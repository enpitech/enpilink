import express, { type Router } from "express";
import { refreshCaptureGate } from "../capture-gate.js";
import { getActiveStorage } from "../log-sink.js";
import type { ConfigAuditEntry, StorageAdapter } from "../storage/types.js";
import { getPreset, PRESETS } from "./presets.js";
import {
  type ResolvedSetting,
  resolveConfig,
  validateConfigWrite,
} from "./resolve.js";
import {
  type ConfigKey,
  isBootstrapKey,
  isKnownKey,
  isRestartKey,
  isRuntimeKey,
  isSecretKey,
} from "./schema.js";

/**
 * Config admin API. Pure core — reads the SAME active {@link StorageAdapter}
 * the analytics middleware writes to, via {@link getActiveStorage}. Does NOT
 * depend on `@enpilink/console`.
 *
 * Mounted dev-only (unauth, localhost) and in the prod admin plane (behind
 * bearer auth) at `/__enpilink/config`.
 *
 * Routes:
 * - `GET    /__enpilink/config`               — all settings (rich metadata +
 *   source + secret/envLocked/modified/restartRequired flags).
 * - `PUT    /__enpilink/config/:key`          — set a RUNTIME or RESTART-tier
 *   key. Rejects secret / `admin` / env-locked / unknown keys with a clear 4xx.
 * - `DELETE /__enpilink/config/:key`          — reset a key to its default
 *   (clears the DB override). Same guardrails as PUT.
 * - `GET    /__enpilink/config/presets`       — list presets + the values each
 *   would set.
 * - `POST   /__enpilink/config/preset/:name`  — apply a preset (validate +
 *   persist + audit each runtime key; skip env-locked).
 * - `GET    /__enpilink/config/audit`         — recent config-change history.
 *
 * Disabled-safe: with no active storage, reads fall back to env/file/defaults
 * and NEVER 500. Writes require a storage adapter (409 when none).
 *
 * SECURITY: `admin`, `adminAuthToken`, unknown keys, and env-locked keys can
 * NEVER be written here. `adminAuthToken` is never persisted nor returned in
 * plaintext.
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
      const resolved = await resolveConfig(null);
      res.json({ settings: resolved.settings });
    }
  });

  // GET /config/presets — list presets + the values each would set.
  router.get(`${base}/presets`, (_req, res) => {
    res.json({ presets: Object.values(PRESETS) });
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

  // POST /config/preset/:name — apply a runtime-only preset.
  router.post(`${base}/preset/:name`, async (req, res) => {
    const preset = getPreset(req.params.name);
    if (!preset) {
      res.status(404).json({ error: `Unknown preset "${req.params.name}"` });
      return;
    }
    const storage = getStorage();
    if (!storage) {
      res.status(409).json({
        error: "No active storage; cannot apply preset",
      });
      return;
    }

    const resolved = await resolveConfig(storage);
    const byKey = new Map(resolved.settings.map((s) => [s.key, s]));
    const actor = actorOf(req);

    const applied: { key: string; value: unknown }[] = [];
    const skipped: { key: string; reason: string }[] = [];

    for (const [key, value] of Object.entries(preset.values)) {
      // Presets only ever touch runtime keys; double-check the guardrail.
      if (!isRuntimeKey(key)) {
        skipped.push({ key, reason: "not a runtime key" });
        continue;
      }
      const setting = byKey.get(key as ConfigKey);
      if (setting?.envLocked) {
        skipped.push({ key, reason: `pinned via ${setting.source}` });
        continue;
      }
      const check = validateConfigWrite(key, value);
      if (!check.ok) {
        skipped.push({ key, reason: check.error });
        continue;
      }
      try {
        await storage.setConfig(key, check.value, actor);
        applied.push({ key, value: check.value });
      } catch (err) {
        skipped.push({
          key,
          reason: err instanceof Error ? err.message : "write failed",
        });
      }
    }

    // A preset may have changed analytics.enabled/sampleRate — refresh the live
    // capture gate so it takes effect without a restart.
    await refreshCaptureGate();
    res.json({ ok: true, preset: preset.name, applied, skipped });
  });

  // PUT /config/:key — set a runtime or restart-tier key.
  router.put(`${base}/:key`, async (req, res) => {
    const guard = await writeGuard(req.params.key, getStorage);
    if (!guard.ok) {
      res.status(guard.status).json({ error: guard.error });
      return;
    }
    const key = guard.key;

    const body = req.body as { value?: unknown } | undefined;
    const check = validateConfigWrite(key, body?.value);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }

    try {
      await guard.storage.setConfig(key, check.value, actorOf(req));
      // Refresh the live capture gate so a toggle of analytics.enabled /
      // analytics.sampleRate takes effect immediately (no restart).
      await refreshCaptureGate();
      res.json({
        ok: true,
        key,
        value: check.value,
        restartRequired: isRestartKey(key),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to write config",
      });
    }
  });

  // DELETE /config/:key — reset to default (clear the DB override).
  router.delete(`${base}/:key`, async (req, res) => {
    const guard = await writeGuard(req.params.key, getStorage);
    if (!guard.ok) {
      res.status(guard.status).json({ error: guard.error });
      return;
    }
    try {
      await guard.storage.clearConfig(guard.key, actorOf(req));
      // Resetting analytics.enabled / sampleRate to default also re-gates
      // capture live.
      await refreshCaptureGate();
      res.json({
        ok: true,
        key: guard.key,
        reset: true,
        restartRequired: isRestartKey(guard.key),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to reset config",
      });
    }
  });

  return router;
}

type WriteGuardResult =
  | { ok: true; key: ConfigKey; storage: StorageAdapter }
  | { ok: false; status: number; error: string };

/**
 * Shared guardrail for PUT + DELETE. Rejects unknown / secret / `admin` /
 * env-locked keys and requires an active storage adapter. Only runtime and
 * non-env-locked restart-tier keys pass.
 */
async function writeGuard(
  key: string,
  getStorage: () => StorageAdapter | null,
): Promise<WriteGuardResult> {
  if (!isKnownKey(key)) {
    return { ok: false, status: 404, error: `Unknown config key "${key}"` };
  }
  if (isSecretKey(key)) {
    return {
      ok: false,
      status: 403,
      error: `"${key}" is a secret and is set via environment only`,
    };
  }
  // Bootstrap keys are writable ONLY if they are restart-tier (the non-secret
  // auth keys). `admin`, the secrets, and the startup-only port/storage/dbPath
  // keys (env-only / UI-hidden) are read-only here.
  if (isBootstrapKey(key) && !isRestartKey(key)) {
    return {
      ok: false,
      status: 403,
      error: `"${key}" is environment-only and is read-only here`,
    };
  }
  if (!isRuntimeKey(key) && !isRestartKey(key)) {
    return { ok: false, status: 403, error: `"${key}" is not editable` };
  }

  // Reject if the key is currently pinned (env-locked) by env/file.
  const resolved = await resolveConfig(getStorage());
  const setting = resolved.settings.find((s: ResolvedSetting) => s.key === key);
  if (setting?.envLocked) {
    return {
      ok: false,
      status: 409,
      error: `"${key}" is pinned via ${setting.source} and cannot be changed here`,
    };
  }

  const storage = getStorage();
  if (!storage) {
    return {
      ok: false,
      status: 409,
      error: "No active storage; cannot persist config",
    };
  }
  return { ok: true, key: key as ConfigKey, storage };
}

/** Best-effort actor attribution for audit rows (no auth in dev → "dev"). */
function actorOf(req: express.Request): string {
  const header = req.header("x-enpilink-actor");
  return typeof header === "string" && header.length > 0 ? header : "dev";
}
