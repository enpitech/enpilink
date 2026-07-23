import { dirname, join, resolve } from "node:path";
import { getActiveStorage, serverLog } from "../../log-sink.js";
import { backfillClassification } from "../backfill.js";
import { getAgentCaptureGate } from "../capture-gate.js";
import {
  RulesetClient,
  type RulesetClientConfig,
  type RulesetClientOptions,
} from "./client.js";
import { DiskRulesetCacheStore } from "./disk-cache.js";
import { setCurrentRuleset } from "./holder.js";

/**
 * NODE WIRING for the cached ruleset client (D2).
 *
 * This is the Node-only seam that turns the runtime-neutral {@link RulesetClient}
 * into a running component wired to enpilink's process-wide state:
 *   - config comes from the agent capture gate (env > file > db, re-resolved on
 *     every config write — so a dashboard edit to the URL/TTL/mode takes effect
 *     without a restart),
 *   - a validated ruleset is pushed into the in-memory holder
 *     (`setCurrentRuleset`) the Node classifier reads, and
 *   - a first load / version change triggers `backfillClassification` OFF THE
 *     HOT PATH (fire-and-forget, guarded for storage presence), so `pending`
 *     rows get labelled once rules land and re-labelled when the version bumps.
 *
 * The client is CONSTRUCTED at boot (cheap; it fetches nothing until started)
 * and STARTED either at boot when the agent surface is already on, or lazily on
 * the first captured-request nudge ({@link maybeRefreshRuleset}) — so a server
 * that never uses the agent surface makes no outbound call. Nothing here is ever
 * awaited on a request path.
 */

let client: RulesetClient | null = null;

/** Read the live ruleset-client config off the agent capture gate. */
function configFromGate(): RulesetClientConfig {
  const g = getAgentCaptureGate();
  return {
    enabled: g.rulesetEnabled === true,
    // The gate carries the schema default when unset, so these ?? fallbacks are
    // belt-and-braces for a partially-populated test gate.
    url: g.rulesetUrl ?? "https://cdn.enpitech.dev/agent/ruleset/v1.json",
    ttlSeconds: g.rulesetTtlSeconds ?? 0,
    timeoutMs: g.rulesetTimeoutMs ?? 5000,
    mode: g.rulesetMode === "dev" ? "dev" : "live",
  };
}

/**
 * Where the on-disk ruleset cache lives — co-located with the sqlite DB so it
 * follows the operator's data directory. Falls back to the cwd (where the
 * default `./enpilink.db` lives). A hidden file so it doesn't clutter the tree.
 */
function defaultCacheFilePath(): string {
  const dbPath = process.env.ENPILINK_DB_PATH ?? "./enpilink.db";
  const dir = dirname(resolve(dbPath));
  return join(dir, ".enpilink-ruleset.json");
}

/** Whether the agent surface is active (so it's worth fetching a ruleset now). */
function agentSurfaceActive(): boolean {
  const g = getAgentCaptureGate();
  return g.enabled === true || g.serve === true;
}

/**
 * Construct (and, when appropriate, start) the process-wide ruleset client.
 * Called once from `createApp` after the capture gate has resolved. Idempotent:
 * a prior client is stopped and replaced (matters for tests / re-`createApp`).
 * Returns the client (mostly for tests). NEVER blocks — start is fire-and-forget.
 */
export function bootstrapRulesetClient(
  overrides: Partial<
    Pick<RulesetClientOptions, "cacheStore" | "fetchImpl" | "now">
  > & { cacheFilePath?: string } = {},
): RulesetClient {
  if (client) {
    client.stop();
  }
  client = new RulesetClient({
    getConfig: configFromGate,
    cacheStore:
      overrides.cacheStore ??
      new DiskRulesetCacheStore(
        overrides.cacheFilePath ?? defaultCacheFilePath(),
      ),
    onActivate: (ruleset, meta) => {
      // Make the validated ruleset live for the Node classifier.
      setCurrentRuleset(ruleset);
      // Label pending rows (first load) / re-label on a version change — OFF THE
      // HOT PATH. `backfillClassification` is a safe no-op when storage is
      // absent or lacks the methods, mirroring how observability guards storage.
      if (meta.firstLoad || meta.versionChanged) {
        void backfillClassification(getActiveStorage(), ruleset).catch(
          (err) => {
            serverLog("warning", "[enpilink] agent ruleset backfill failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
      }
    },
    onError: (err, phase) => {
      // Loud but harmless: capture keeps working, classification stays pending /
      // last-good. This is the intended no-baseline signal, not an outage.
      serverLog("warning", `[enpilink] agent ruleset ${phase} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    },
    ...(overrides.fetchImpl !== undefined
      ? { fetchImpl: overrides.fetchImpl }
      : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });

  // Start now only if fetching is enabled AND the agent surface is on; otherwise
  // stay dormant and lazy-start on the first captured-request nudge.
  if (configFromGate().enabled && agentSurfaceActive()) {
    void client.start();
  }
  return client;
}

/**
 * The stale-while-revalidate nudge, called OFF THE HOT PATH from the agent
 * capture spine (after the response has finished). Cheap + synchronous; it
 * lazy-starts the client and, when the held ruleset is past its TTL, kicks a
 * background refresh — but NEVER awaits one. A no-op when no client is
 * bootstrapped (e.g. unit tests that install the middleware standalone).
 */
export function maybeRefreshRuleset(): void {
  client?.maybeRefresh();
}

/** The process-wide ruleset client, or `null` before bootstrap. */
export function getRulesetClient(): RulesetClient | null {
  return client;
}

/** The live ruleset status the dashboard reads (D3). `enabled:false` = no client
 * bootstrapped (agent surface off) — mirrors the M4 read-API degrade shape. */
export interface RulesetStatus {
  enabled: true;
  /** A validated ruleset is currently held. `false` ⇒ detection is `pending`. */
  loaded: boolean;
  /** The held ruleset's version, or `null` when nothing has loaded yet. */
  version: string | null;
  /** Epoch-ms the held ruleset was fetched, or `null`. */
  fetchedAt: number | null;
  /** Where the held ruleset came from, or `null`. */
  source: "network" | "cache" | null;
  /** Resolved `agent.ruleset.mode` (echoed so the card renders without a config read). */
  mode: "live" | "dev";
  /** Resolved `agent.ruleset.ttlSeconds` (0 ⇒ honor Cache-Control). */
  ttlSeconds: number;
  /** Resolved `agent.ruleset.url`. */
  url: string;
  /** Resolved `agent.ruleset.enabled` — whether network fetching is on. */
  fetchEnabled: boolean;
}

/**
 * Read the current ruleset status for the dashboard — synchronous, cheap, never
 * throws. Returns `{ enabled: false }` when no client is bootstrapped (the agent
 * surface is off / not wired), so the console can degrade exactly like it does
 * for the telemetry summary.
 */
export function getRulesetStatus(): RulesetStatus | { enabled: false } {
  if (!client) {
    return { enabled: false };
  }
  const st = client.getStatus();
  const cfg = configFromGate();
  return {
    enabled: true,
    loaded: st.version !== null,
    version: st.version,
    fetchedAt: st.fetchedAt,
    source: st.source,
    mode: cfg.mode,
    ttlSeconds: cfg.ttlSeconds,
    url: cfg.url,
    fetchEnabled: cfg.enabled,
  };
}

/** Stop + clear the process-wide client (shutdown / test teardown). */
export function stopRulesetClient(): void {
  if (client) {
    client.stop();
    client = null;
  }
}
