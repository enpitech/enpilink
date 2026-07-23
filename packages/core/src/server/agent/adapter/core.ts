import { createHash, randomBytes } from "node:crypto";
import { resolveConfig } from "../../config/index.js";
import {
  getActiveStorage,
  serverLog,
  setActiveStorage,
} from "../../log-sink.js";
import { resolveStorageAdapter } from "../../storage/index.js";
import type {
  AgentRequestRecord,
  StorageAdapter,
} from "../../storage/types.js";
import { AgentWriteBuffer } from "../buffer.js";
import {
  type CaptureOutcome,
  type MinimalRequest,
  toCaptureRecord,
} from "../capture.js";
import {
  type AgentCaptureGate,
  getAgentCaptureGate,
  refreshAgentCaptureGate,
  setAgentCaptureGate,
} from "../capture-gate.js";
import { classify } from "../detect.js";
import { IpRangeVerifier } from "../ip-ranges.js";
import {
  type AgentGetAffordance,
  type AgentSiteInfo,
  type AgentToolInfo,
  type Representation,
  represent,
} from "../represent.js";
import { resolveSiteInfo, type ServeEncoding } from "../route.js";
import {
  bootstrapRulesetClient,
  maybeRefreshRuleset,
} from "../ruleset/bootstrap.js";
import { getCurrentRuleset } from "../ruleset/holder.js";
import type { Ruleset } from "../ruleset/types.js";

/**
 * The SHARED, runtime-neutral core for the standalone Node agent adapters
 * (`enpilink/express`, `enpilink/hono`).
 *
 * The agent surface first shipped welded to {@link McpServer}: the capture spine
 * lives in `express-middleware.ts`, the 404-rescue in `route.ts`, the HTML
 * transform in `response-transform.ts` — each bound to Express AND to the server's
 * lifecycle (it activates storage, resolves the gate, bootstraps the ruleset
 * client). A one-line `app.use(agentCapture())` in a plain Express/Hono/NestJS app
 * has none of that scaffolding, so this module factors the reusable half OUT of
 * the server:
 *
 * - {@link AgentCaptureRecorder} — the capture→classify→(optional IP-tier)→enqueue
 *   pipeline, lifted verbatim from `express-middleware.ts`. It takes a neutral
 *   {@link MinimalRequest} + resolved IP + {@link CaptureOutcome} (each adapter
 *   builds those from its own request/response), hashes the IP, classifies against
 *   the live ruleset, and buffers the row. `express-middleware.ts` now delegates to
 *   it too, so there is ONE capture pipeline.
 * - {@link ensureAgentAdapterInstalled} — the one-time process bootstrap the server
 *   used to do inline: activate a real StorageAdapter (so capture works WITHOUT
 *   `ENPILINK_ANALYTICS`), resolve the config gate, flip capture ON by default (the
 *   one-liner IS the opt-in), and start the D2 ruleset client.
 * - {@link decideServeAction} + {@link buildRepresentationDoc} — the serve/transform
 *   DECISION and the representation build, reusing `agentServeEligibility`
 *   (`route.ts`) as the single source of the cloaking guardrail. The adapter only
 *   supplies the runtime-specific EXECUTION (mutate an Express `res`, replace a Hono
 *   `Response`).
 *
 * NODE-ONLY. This core uses `node:crypto` and touches the StorageAdapter/config
 * subsystems, so it must never enter an edge bundle. The edge adapters (D4b) reuse
 * the parallel pure `edge/capture-edge.ts` core instead — see the D4b note in the
 * distribution plan.
 */

/** The site id captured under (single-site). Multi-site is future work. */
export const DEFAULT_SITE_ID = "default";

/** Milliseconds in a day, for the retention window. */
const DAY_MS = 86_400_000;

/** How often the write path opportunistically sweeps expired rows. */
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Compute the retention boundary and delete captured requests older than it.
 * Returns the number of rows removed. `retentionDays <= 0` disables pruning
 * (keep forever). This is the REAL retention the decorative `retention.*` config
 * never delivered. Shared by the Express spine and the standalone adapters.
 */
export async function pruneAgentData(
  storage: StorageAdapter | null,
  retentionDays: number,
  nowMs: number = Date.now(),
): Promise<number> {
  if (!storage?.prune) {
    return 0;
  }
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return 0;
  }
  const before = nowMs - retentionDays * DAY_MS;
  try {
    return await storage.prune({ before });
  } catch {
    // Retention is best-effort; a prune failure must never break anything.
    return 0;
  }
}

/** Hash a client IP with the per-site salt. NEVER stores or returns the raw IP. */
function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(salt).update(":").update(ip).digest("hex");
}

/** Serve-flag hints the adapter observed while (re)writing the response. */
export interface AgentRecordFlags {
  /** The M3/M6 serving layer produced this response body. */
  served?: boolean;
  /** Encoding of a served representation. */
  servedEncoding?: ServeEncoding;
  /** A real 2xx HTML route was re-encoded to markdown (M6 `agent.reencode`). */
  reencoded?: boolean;
  /** An SPA shell was replaced with the representation (M6 `agent.spa`). */
  spa?: boolean;
}

/** Options for {@link AgentCaptureRecorder}. */
export interface AgentCaptureRecorderOptions {
  /** Resolve the active storage at write time. Defaults to {@link getActiveStorage}. */
  getStorage?: () => StorageAdapter | null;
  /** Site id to attribute captures to. Defaults to {@link DEFAULT_SITE_ID}. */
  siteId?: string;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * The optional IP-range verifier for the `agent.verifyIpRanges` tier. Injectable
   * so tests never hit the network; defaults to a real {@link IpRangeVerifier}
   * (which fetches NOTHING until the tier is on).
   */
  ipVerifier?: IpRangeVerifier;
  /**
   * Read the current detection ruleset. Defaults to {@link getCurrentRuleset} — the
   * in-memory holder D2 populates. Capture is ruleset-INDEPENDENT: a raw row is
   * always written; classification only runs when this returns a ruleset, else the
   * row is stored `pending` and `backfillClassification` labels it later.
   */
  getRuleset?: () => Ruleset | null;
  /** Live gate reader (for the `verifyIpRanges` tier). Defaults to {@link getAgentCaptureGate}. */
  getGate?: () => AgentCaptureGate;
}

/**
 * The runtime-neutral capture pipeline. Each adapter builds a {@link MinimalRequest}
 * + resolved IP + {@link CaptureOutcome} from its own runtime and calls
 * {@link record}; this class owns the parts that DON'T vary by runtime — the write
 * buffer, per-site salt resolution, IP hashing, classification, the optional
 * IP-range tier, and the opportunistic retention sweep.
 *
 * {@link record} is fire-and-forget: it returns immediately and does all I/O off
 * the caller's stack, mirroring `analytics.ts` discipline (a storage failure never
 * breaks a response; the request never blocks on a write).
 */
export class AgentCaptureRecorder {
  private readonly getStorage: () => StorageAdapter | null;
  private readonly siteId: string;
  private readonly now: () => number;
  private readonly ipVerifier: IpRangeVerifier;
  private readonly getRuleset: () => Ruleset | null;
  private readonly getGate: () => AgentCaptureGate;
  private readonly buffer: AgentWriteBuffer;

  // Per-site salt for IP hashing, resolved once and reused. `undefined` = not yet
  // resolved; `null` = resolution failed / storage can't store sites (then we omit
  // the hash — we NEVER fall back to a raw IP).
  private resolvedSalt: string | null | undefined;
  private saltPromise: Promise<string | null> | null = null;

  // Opportunistic retention sweep, throttled + driven off write activity so there
  // is NO standalone always-on timer (nothing runs while capture is off).
  private lastSweepAt = 0;

  constructor(opts: AgentCaptureRecorderOptions = {}) {
    this.getStorage = opts.getStorage ?? getActiveStorage;
    this.siteId = opts.siteId ?? DEFAULT_SITE_ID;
    this.now = opts.now ?? Date.now;
    this.ipVerifier = opts.ipVerifier ?? new IpRangeVerifier();
    this.getRuleset = opts.getRuleset ?? getCurrentRuleset;
    this.getGate = opts.getGate ?? getAgentCaptureGate;
    this.buffer = new AgentWriteBuffer({
      sink: async (records) => {
        const storage = this.getStorage();
        if (!storage?.recordAgentRequests) {
          return;
        }
        await storage.recordAgentRequests(records);
        this.maybeSweep(storage);
      },
    });
  }

  private ensureSalt(): Promise<string | null> {
    if (this.resolvedSalt !== undefined) {
      return Promise.resolve(this.resolvedSalt);
    }
    if (!this.saltPromise) {
      this.saltPromise = (async () => {
        const storage = this.getStorage();
        if (!storage?.ensureAgentSite) {
          this.resolvedSalt = null;
          return null;
        }
        try {
          const site = await storage.ensureAgentSite({
            id: this.siteId,
            ipSalt: randomBytes(32).toString("hex"),
            createdAt: this.now(),
          });
          this.resolvedSalt = site.ipSalt;
          return site.ipSalt;
        } catch {
          this.resolvedSalt = null;
          return null;
        }
      })();
    }
    return this.saltPromise;
  }

  private maybeSweep(storage: StorageAdapter): void {
    const t = this.now();
    if (t - this.lastSweepAt < RETENTION_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweepAt = t;
    void (async () => {
      try {
        const { values } = await resolveConfig(storage);
        await pruneAgentData(
          storage,
          values["agent.retentionDays"],
          this.now(),
        );
      } catch {
        // Sweep is best-effort.
      }
    })();
  }

  /**
   * Record ONE captured request. Fire-and-forget + never throws. `ip` is the raw
   * client IP the adapter resolved (or `null`); it is hashed here and never stored
   * raw. `flags` carry what the serve/transform layer did to this response.
   */
  record(
    minimal: MinimalRequest,
    ip: string | null,
    outcome: CaptureOutcome,
    flags: AgentRecordFlags = {},
  ): void {
    // Stale-while-revalidate nudge (D2): classifying is the moment ruleset
    // freshness matters, so opportunistically kick a BACKGROUND refresh when past
    // TTL. Cheap + synchronous; NEVER awaits the fetch. A no-op when no client is
    // bootstrapped.
    maybeRefreshRuleset();
    void (async () => {
      // (1) CAPTURE — ruleset-INDEPENDENT. Hash the IP (never stored raw) and
      // assemble the raw record; written regardless of ruleset state.
      let ipHash: string | undefined;
      if (ip) {
        const salt = await this.ensureSalt();
        if (salt) {
          ipHash = hashIp(ip, salt);
        }
      }
      const m: MinimalRequest =
        ipHash !== undefined ? { ...minimal, ipHash } : minimal;
      const rec: AgentRequestRecord = toCaptureRecord(m, outcome, this.siteId);
      if (flags.served) {
        rec.served = true;
        if (flags.servedEncoding !== undefined) {
          rec.servedEncoding = flags.servedEncoding;
        }
      }
      if (flags.reencoded) {
        rec.meta = { ...(rec.meta ?? {}), reencoded: true };
      }
      if (flags.spa) {
        rec.meta = { ...(rec.meta ?? {}), spa: true };
      }

      // (2) CLASSIFY — a SEPARATE step, keyed on the CURRENTLY-LOADED ruleset. No
      // ruleset → leave the row `pending`, backfilled once a ruleset loads.
      const ruleset = this.getRuleset();
      if (!ruleset) {
        rec.confidence = "pending";
        this.buffer.enqueue(rec);
        return;
      }

      const detection = classify(ruleset, minimal.rawHeaders);
      let confidence = detection.confidence;

      // (3) OPTIONAL IP tier — on the RAW ip, BEFORE it is hashed and discarded.
      // We keep only the verdict, never the ip. Only for a family whose vendor
      // publishes a list AND is expected to originate from its ranges.
      const gate = this.getGate();
      if (ip && gate.verifyIpRanges === true && detection.family !== null) {
        const vendor =
          ruleset.ipRanges.familyToVendor[detection.family] ?? null;
        if (vendor) {
          this.ipVerifier.ensureFresh(vendor);
          const verdict = this.ipVerifier.verify(vendor, ip);
          if (verdict === "match") {
            confidence = "ip-verified";
          } else if (verdict === "miss") {
            rec.meta = { ...(rec.meta ?? {}), spoof: true };
          }
        }
      }

      if (detection.family !== null) {
        rec.agentFamily = detection.family;
      }
      rec.agentClass = detection.class;
      rec.confidence = confidence;
      rec.rulesetVersion = ruleset.version;
      this.buffer.enqueue(rec);
    })();
  }

  /** Flush and stop the write buffer. Idempotent. */
  stop(): Promise<void> {
    return this.buffer.stop();
  }
}

// ── SERVE / TRANSFORM decision (guardrail single-source in serve-eligibility.ts) ─
// The serve DECISION + guardrail live in the pure, edge-safe `serve-eligibility.ts`
// so the standalone Node adapters and the edge adapters share ONE source. Re-
// exported here so `express.ts` / `hono.ts` keep importing them from the core.
export {
  decideServeAction,
  isHtmlContentType,
  isIdentityEncoding,
  type ServeAction,
} from "../serve-eligibility.js";

/** The declared source the representation is built from. */
export interface RepresentationSources {
  /** The declared tool index (read live). */
  getTools: () => AgentToolInfo[];
  /** The owner-declared site summary (from `describeForAgents` / options / config). */
  getSiteInfo: () => AgentSiteInfo;
  /** Fallback title when the site declares none. */
  getServerName: () => string;
  /** GET-exposed tools as affordances (M7). Only used when `agent.getTransport` is on. */
  getGetAffordances?: () => AgentGetAffordance[];
}

/**
 * Build the representation document for a path, merging the config-resolved site
 * summary (from the gate) with the code-declared one (via {@link resolveSiteInfo},
 * the SAME merge `route.ts`/`response-transform.ts` use).
 */
export function buildRepresentationDoc(
  gate: AgentCaptureGate,
  sources: RepresentationSources,
  path: string,
): Representation {
  const site = resolveSiteInfo(gate, sources.getSiteInfo());
  const affordances =
    gate.getTransport === true ? (sources.getGetAffordances?.() ?? []) : [];
  return represent({
    serverName: sources.getServerName(),
    site,
    tools: sources.getTools(),
    affordances,
    path,
  });
}

// ── One-time process bootstrap for a standalone adapter ─────────────────────────

/** The subset of adapter options that shape the process gate + storage bootstrap. */
export interface AgentAdapterInstallOptions {
  /**
   * Capture agent requests. Defaults to **ON** — installing the middleware IS the
   * opt-in for a standalone app (unlike `McpServer`, where capture is off until a
   * dashboard toggle). An explicit `false`, or an explicit `ENPILINK_AGENT` env
   * pin, still wins.
   */
  enabled?: boolean;
  /** Sampling fraction `[0,1]`. Defaults to the resolved config (1). */
  sampleRate?: number;
  /** Serve the representation to eligible chat fetchers on a would-be-404 (opt-in). */
  serve?: boolean;
  /** Replace an eligible fetcher's 2xx SPA shell with the representation (opt-in). */
  spa?: boolean;
  /** Re-encode an eligible fetcher's 2xx HTML to markdown (opt-in). */
  reencode?: boolean;
  /** Turn on the optional published-IP-range confidence tier (opt-in). */
  verifyIpRanges?: boolean;
  /** Owner-declared site title for the representation. */
  siteTitle?: string;
  /** Owner-declared site description for the representation. */
  siteDescription?: string;
}

let installPromise: Promise<void> | null = null;

/** Truthy env strings, matching the analytics gate's parsing. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Resolve the effective `enabled` for a standalone adapter. Precedence:
 * explicit option → an explicit `ENPILINK_AGENT` env pin (honored via the resolved
 * config gate) → default ON. This is the ONE place the standalone default diverges
 * from `McpServer` (where capture is off by default).
 */
function resolveEnabled(
  opts: AgentAdapterInstallOptions,
  base: AgentCaptureGate,
): boolean {
  if (typeof opts.enabled === "boolean") {
    return opts.enabled;
  }
  if (process.env.ENPILINK_AGENT !== undefined) {
    // The config gate already applied the env pin (env > db); honor it.
    return base.enabled;
  }
  return true;
}

/**
 * The one-time process bootstrap a standalone adapter needs before it can capture.
 * Idempotent (a shared promise): the FIRST `agentCapture()` call runs it; later
 * calls await the same promise.
 *
 * 1. **Activate storage** if none is active yet (the M1 quirk: agent capture writes
 *    to the shared `activeStorage`, which `McpServer` activates via analytics/admin
 *    — a standalone app has neither, so we activate the configured StorageAdapter
 *    ourselves, default sqlite). Now `app.use(agentCapture())` "just works": one
 *    line → capturing to `enpilink.db`, no `ENPILINK_ANALYTICS` required.
 * 2. **Resolve + overlay the gate** — read the config gate (env > file > db, for
 *    the ruleset URL/TTL/mode, site summary, sampleRate and any env pins), then
 *    overlay the adapter defaults (capture ON) and publish it process-wide.
 * 3. **Bootstrap the D2 ruleset client** — it reads the gate, so with capture on it
 *    starts fetching the CDN ruleset in the background (never blocks a request).
 *
 * Every step is best-effort: a storage/config failure logs and degrades (capture
 * stays a no-op) rather than throwing into app startup.
 */
export function ensureAgentAdapterInstalled(
  opts: AgentAdapterInstallOptions = {},
): Promise<void> {
  if (installPromise) {
    return installPromise;
  }
  installPromise = (async () => {
    // (1) Storage — activate the configured adapter if the process has none.
    if (!getActiveStorage()) {
      try {
        const storage = resolveStorageAdapter();
        await storage.init();
        setActiveStorage(storage);
      } catch (err) {
        serverLog("warning", "[enpilink] agent adapter storage init failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // (2) Gate — resolve config, then overlay the standalone defaults.
    await refreshAgentCaptureGate();
    const base = getAgentCaptureGate();
    setAgentCaptureGate({
      ...base,
      enabled: resolveEnabled(opts, base),
      sampleRate: opts.sampleRate ?? base.sampleRate,
      serve: opts.serve ?? base.serve ?? false,
      spa: opts.spa ?? base.spa ?? false,
      reencode: opts.reencode ?? base.reencode ?? false,
      verifyIpRanges: opts.verifyIpRanges ?? base.verifyIpRanges ?? false,
      siteTitle: opts.siteTitle !== undefined ? opts.siteTitle : base.siteTitle,
      siteDescription:
        opts.siteDescription !== undefined
          ? opts.siteDescription
          : base.siteDescription,
    });

    // (3) Ruleset client — reads the gate; auto-starts now that capture is on.
    try {
      bootstrapRulesetClient();
    } catch (err) {
      serverLog("warning", "[enpilink] agent ruleset bootstrap failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
  return installPromise;
}

/** TEST-ONLY: reset the one-time install latch so a fresh bootstrap can run. */
export function __resetAgentAdapterInstall(): void {
  installPromise = null;
}

/** Whether an env string is truthy (exported for adapters that read env directly). */
export function envTruthy(raw: string | undefined): boolean {
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}
