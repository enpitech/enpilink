import { dirname, join, resolve } from "node:path";
import { getActiveStorage, serverLog } from "../../log-sink.js";
import { backfillClassification } from "../backfill.js";
import { getAgentCaptureGate } from "../capture-gate.js";
import {
  RulesetClient,
  type RulesetClientConfig,
  type RulesetClientOptions,
  type RulesetSource,
} from "./client.js";
import { DiskRulesetCacheStore } from "./disk-cache.js";
import { setCurrentRuleset } from "./holder.js";
import { buildRulesetArtifact } from "./publish.js";
import type { Ruleset } from "./types.js";

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
 * SELF-HOSTED BY DEFAULT: enpilink is self-hosted software, not a SaaS — there is
 * no enpitech CDN. By default (`agent.ruleset.url` empty) the client loads THIS
 * instance's OWN packaged ruleset in-process — {@link packagedRuleset}, the exact
 * artifact this server also self-hosts at `/__enpilink/agents/ruleset` — with NO
 * network call. Detection therefore works offline, out of the box. A `url` is set
 * only for the DISTRIBUTED case (a website/edge adapter deployed apart from the
 * enpilink server): it points at the operator's OWN enpilink server endpoint (or a
 * mirror they run), never at enpitech, and takes the D2 fetch path.
 *
 * The client is CONSTRUCTED at boot (cheap; it loads nothing until started) and
 * STARTED either at boot when the agent surface is already on, or lazily on the
 * first captured-request nudge ({@link maybeRefreshRuleset}) — so a server that
 * never uses the agent surface does no ruleset work at all. Nothing here is ever
 * awaited on a request path.
 */

let client: RulesetClient | null = null;

/**
 * The instance's OWN packaged detection ruleset — built once from the maintained
 * corpus (`buildRulesetArtifact`, content-addressed version) and reused. This is
 * the SOLE default detection source (self-hosted mode), loaded through the normal
 * validate/version/backfill path — NOT a hidden classifier fallback. It is the
 * byte-identical artifact the D3 self-host endpoint serves, so a distributed
 * adapter pointed at this server agrees on `version` (no needless re-classify).
 */
let packagedBody: Ruleset | null = null;
function packagedRuleset(): Ruleset {
  if (!packagedBody) {
    packagedBody = buildRulesetArtifact().body;
  }
  return packagedBody;
}

/** Read the live ruleset-client config off the agent capture gate. */
function configFromGate(): RulesetClientConfig {
  const g = getAgentCaptureGate();
  return {
    enabled: g.rulesetEnabled === true,
    // Empty URL ⇒ SELF/PACKAGED mode (the default). The `?? ""` is belt-and-braces
    // for a partially-populated test gate — there is no CDN default.
    url: g.rulesetUrl ?? "",
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
    // SELF-HOSTED DEFAULT: with no `url` configured, the client activates this
    // instance's own packaged ruleset in-process (no network) via this provider.
    localRuleset: packagedRuleset,
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

  // Start now only if the ruleset is enabled AND the agent surface is on;
  // otherwise stay dormant and lazy-start on the first captured-request nudge.
  // `start()` loads the packaged ruleset in-process (self mode) or kicks a
  // background fetch (remote mode) — never awaited.
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
  /** Epoch-ms the held ruleset was fetched/loaded, or `null`. */
  fetchedAt: number | null;
  /** Where the held ruleset came from (`packaged` = in-process self-hosted
   * default), or `null`. */
  source: RulesetSource | null;
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
