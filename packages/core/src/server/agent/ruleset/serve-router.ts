import express, { type Router } from "express";
import { getAgentCaptureGate } from "../capture-gate.js";
import { getRulesetStatus, type RulesetStatus } from "./bootstrap.js";
import { buildRulesetArtifact, type RulesetArtifact } from "./publish.js";

/**
 * THE SELF-HOST RULESET ENDPOINT (D3) — the escape hatch that lets an
 * air-gapped/paranoid operator point `agent.ruleset.url` at their OWN enpilink
 * instead of the enpitech CDN. It serves the exact artifact the publish pipeline
 * emits (`buildRulesetArtifact`, same corpus, deterministic → same bytes), so
 * there is no data duplication and no file to keep in sync. This is also "exactly
 * what the enpitech CDN fronts" — the CDN is just this artifact behind a cache.
 *
 * POSTURE (one-directional): the endpoint only serves rules OUT. It reads no
 * request body, no storage, and nothing about the caller's traffic — so the
 * data-ownership promise holds even when one enpilink mirrors another.
 *
 * AUTH: the ruleset is PUBLIC, non-sensitive data (the same bytes the keyless
 * public CDN serves), and a consuming D2 client fetches it WITHOUT a bearer. So
 * the serve route is mounted BEFORE the admin auth guard (see `admin.ts`) — it
 * is deliberately public. The separate STATUS route (below) exposes this server's
 * own live ruleset state and DOES sit behind the guard with the other data APIs.
 */

/** The public serving path (stable; the artifact's `version` field changes, not
 * this URL). Kept in sync with `admin.ts`'s public-route carve-out. */
export const RULESET_SERVE_PATH = "/__enpilink/agents/ruleset";
/** The guarded live-status path the dashboard polls. */
export const RULESET_STATUS_PATH = "/__enpilink/agents/ruleset/status";

/** Default `Cache-Control: max-age` (seconds) served in `live` mode when no TTL
 * override is set — the central freshness dial. One hour. */
const SERVED_LIVE_DEFAULT_MAX_AGE = 3600;
/** Short `max-age` served in `dev` mode so downstream consumers pick up a new
 * signature within seconds. */
const SERVED_DEV_MAX_AGE = 30;

/**
 * The `max-age` (seconds) to emit — THE live-mode TTL knob, driven by the
 * dashboard `agent.ruleset.mode` + `agent.ruleset.ttlSeconds`. `dev` mode forces
 * a short max-age; `live` mode uses the configured TTL override, or the 1h
 * default when it is 0. A downstream client with `ttlSeconds: 0` (honor
 * Cache-Control) refreshes on exactly this cadence — freshness tuned centrally,
 * no client redeploy.
 */
export function servedMaxAgeSeconds(
  mode: "live" | "dev",
  ttlSeconds: number,
): number {
  if (mode === "dev") {
    return SERVED_DEV_MAX_AGE;
  }
  return ttlSeconds > 0 ? ttlSeconds : SERVED_LIVE_DEFAULT_MAX_AGE;
}

/**
 * Memoized built artifact. The corpus is compile-time data and the build is
 * deterministic, so we build once on first request and reuse the bytes. (A
 * process restart re-reads the corpus; there is no live-editing of the corpus.)
 */
let cachedArtifact: RulesetArtifact | null = null;
function artifact(): RulesetArtifact {
  if (!cachedArtifact) {
    cachedArtifact = buildRulesetArtifact();
  }
  return cachedArtifact;
}

/**
 * Build the PUBLIC ruleset serve router: `GET /__enpilink/agents/ruleset`.
 * Serves the versioned artifact with a `Cache-Control` header driven by the
 * dashboard mode/TTL. Degrades to 503 (never 500, never a hang) if the artifact
 * somehow can't be produced — the D2 client treats a non-200 as a failed refresh
 * and keeps serving its last-good ruleset, so a downstream site never breaks.
 */
export function createRulesetServeRouter(): Router {
  const router = express.Router();
  router.get(RULESET_SERVE_PATH, (_req, res) => {
    try {
      const art = artifact();
      const gate = getAgentCaptureGate();
      const mode = gate.rulesetMode === "dev" ? "dev" : "live";
      const maxAge = servedMaxAgeSeconds(mode, gate.rulesetTtlSeconds ?? 0);
      res.set("Cache-Control", `public, max-age=${maxAge}`);
      res.set("Content-Type", "application/json; charset=utf-8");
      // A convenience mirror of the artifact's internal version, so an operator
      // can diff CDN vs self-host with a HEAD-ish glance.
      res.set("X-Enpilink-Ruleset-Version", art.version);
      res.status(200).send(art.json);
    } catch {
      // Deterministic + pre-validated, so this is belt-and-braces: signal
      // "temporarily unavailable" rather than corrupt the caller's cache.
      res.status(503).json({ error: "ruleset unavailable" });
    }
  });
  return router;
}

/**
 * Build the GUARDED ruleset status router: `GET /__enpilink/agents/ruleset/status`.
 * Reports THIS server's live ruleset state (version / last-refresh / mode / TTL /
 * pending) for the dashboard's Detection-ruleset card. Reads storage/state only
 * synchronously and degrades to `{ enabled: false }` — never a 500 — exactly like
 * the M4 telemetry read API. Mounted behind the admin auth guard.
 */
export function createRulesetStatusRouter(
  readStatus: () => RulesetStatus | { enabled: false } = getRulesetStatus,
): Router {
  const router = express.Router();
  router.get(RULESET_STATUS_PATH, (_req, res) => {
    try {
      res.json(readStatus());
    } catch {
      res.json({ enabled: false });
    }
  });
  return router;
}

/** TEST-ONLY: drop the memoized artifact so a fresh build is forced. */
export function resetServedArtifactCache(): void {
  cachedArtifact = null;
}
