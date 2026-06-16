import express, { type Router } from "express";
import { getActiveStorage } from "../log-sink.js";
import type { ConfigAuditEntry, StorageAdapter } from "../storage/types.js";
import { resolveConfig, validateRuntimeWrite } from "./resolve.js";
import {
  isBootstrapKey,
  isKnownKey,
  isRuntimeKey,
  isSecretKey,
} from "./schema.js";

/**
 * Config admin API (M4). Pure core — reads the SAME active
 * {@link StorageAdapter} the analytics middleware writes to, via
 * {@link getActiveStorage}. Does NOT depend on `@enpilink/devtools`.
 *
 * Mounted dev-only (under the `NODE_ENV !== "production"` block in
 * `express.ts`) at `/__enpilink/config`. Prod admin mounting (behind bearer
 * auth) is M5.
 *
 * Routes:
 * - `GET  /__enpilink/config`        — all settings (value-or-masked + source +
 *   secret/envLocked flags).
 * - `PUT  /__enpilink/config/:key`   — set a RUNTIME, non-secret key. Rejects
 *   bootstrap / secret / env-locked / unknown keys with a clear 4xx.
 * - `GET  /__enpilink/config/audit`  — recent config-change history.
 *
 * Disabled-safe: when there is no active storage, reads fall back to env/file/
 * defaults (runtime keys show their defaults) and NEVER 500. Writes require a
 * storage adapter (409 when none) — there is nowhere to persist otherwise.
 */
export function createConfigRouter(
  getStorage: () => StorageAdapter | null = getActiveStorage,
): Router {
  const router = express.Router();
  const base = "/__enpilink/config";

  // GET /config — full resolved settings. Secrets masked; never 500.
  router.get(base, async (_req, res) => {
    try {
      const resolved = await resolveConfig(getStorage());
      res.json({ settings: resolved.settings });
    } catch {
      // Last-resort: resolve with no storage so reads never fail.
      const resolved = await resolveConfig(null);
      res.json({ settings: resolved.settings });
    }
  });

  // GET /config/audit — change history (most recent first). Never 500.
  router.get(`${base}/audit`, async (_req, res) => {
    const storage = getStorage();
    if (!storage) {
      res.json({ enabled: false, audit: [] as ConfigAuditEntry[] });
      return;
    }
    try {
      const audit = await storage.getConfigAudit();
      res.json({ enabled: true, audit });
    } catch {
      res.json({ enabled: false, audit: [] as ConfigAuditEntry[] });
    }
  });

  // PUT /config/:key — set a runtime, non-secret key. Reject everything else.
  router.put(`${base}/:key`, async (req, res) => {
    const key = req.params.key;

    if (!isKnownKey(key)) {
      res.status(404).json({ error: `Unknown config key "${key}"` });
      return;
    }
    if (isSecretKey(key)) {
      res.status(403).json({
        error: `"${key}" is a secret and is set via environment only`,
      });
      return;
    }
    if (isBootstrapKey(key)) {
      res.status(403).json({
        error: `"${key}" is a bootstrap setting (env/file only) and is read-only here`,
      });
      return;
    }
    if (!isRuntimeKey(key)) {
      res.status(403).json({ error: `"${key}" is not editable` });
      return;
    }

    // Reject if this runtime key is currently pinned (env-locked) by env/file.
    const resolved = await resolveConfig(getStorage());
    const setting = resolved.settings.find((s) => s.key === key);
    if (setting?.envLocked) {
      res.status(409).json({
        error: `"${key}" is pinned via ${setting.source} and cannot be changed here`,
      });
      return;
    }

    const body = req.body as { value?: unknown } | undefined;
    const rawValue = body?.value;
    const check = validateRuntimeWrite(key, rawValue);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }

    const storage = getStorage();
    if (!storage) {
      res.status(409).json({
        error: "No active storage; cannot persist runtime config",
      });
      return;
    }

    try {
      const actor = actorOf(req);
      await storage.setConfig(key, check.value, actor);
      res.json({ ok: true, key, value: check.value });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to write config",
      });
    }
  });

  return router;
}

/** Best-effort actor attribution for audit rows (no auth in dev → "dev"). */
function actorOf(req: express.Request): string {
  const header = req.header("x-enpilink-actor");
  return typeof header === "string" && header.length > 0 ? header : "dev";
}
