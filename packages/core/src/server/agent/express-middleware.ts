import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { getActiveStorage } from "../log-sink.js";
import type { StorageAdapter } from "../storage/types.js";
import {
  AgentCaptureRecorder,
  type AgentRecordFlags,
  DEFAULT_SITE_ID,
  pruneAgentData,
} from "./adapter/core.js";
import {
  type CaptureOutcome,
  type MinimalRequest,
  pairRawHeaders,
} from "./capture.js";
import { getAgentCaptureGate } from "./capture-gate.js";
import type { IpRangeVerifier } from "./ip-ranges.js";
import { getCurrentRuleset } from "./ruleset/holder.js";
import type { Ruleset } from "./ruleset/types.js";

/**
 * Express adapter for the agent capture spine (M1).
 *
 * Installs ONE middleware, ahead of all route handlers, that — only when the
 * live {@link getAgentCaptureGate} says so — records one agent request per request
 * after the response finishes. The capture→classify→enqueue pipeline itself now
 * lives in the runtime-neutral {@link AgentCaptureRecorder} (`adapter/core.ts`),
 * which the standalone `enpilink/express` + `enpilink/hono` adapters share; this
 * module is the thin Express skin over it. It follows the same operational
 * discipline as `analytics.ts`: capture off by default, fire-and-forget writes, a
 * storage failure never breaks a response, and the request NEVER blocks on a write.
 *
 * Two non-negotiables live here:
 * - **`trust proxy` is set**, so `req.ip` reflects the real client behind a
 *   proxy/tunnel (Cloudflare, srv.us, a load balancer).
 * - **The fingerprint is read from `req.rawHeaders`, NEVER `req.headers`.**
 *   `req.headers` lowercases, de-dupes and re-orders — destroying header casing
 *   and order, the two best fingerprint signals. `req.headers` is used ONLY for
 *   a case-insensitive IP-header *value* lookup, where casing is irrelevant.
 */

export { DEFAULT_SITE_ID, pruneAgentData };

/** Options for {@link installAgentCapture}. */
export interface InstallAgentCaptureOptions {
  /** Resolve the active storage at write time. Defaults to {@link getActiveStorage}. */
  getStorage?: () => StorageAdapter | null;
  /** RNG for sampling `[0, 1)`. Defaults to `Math.random`. */
  rng?: () => number;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Site id to attribute captures to. Defaults to {@link DEFAULT_SITE_ID}. */
  siteId?: string;
  /**
   * The optional IP-range verifier for the `agent.verifyIpRanges` tier.
   * Injectable so tests never hit the network; defaults to a real
   * {@link IpRangeVerifier} that fetches published lists on a daily cache (and
   * only when the flag is on).
   */
  ipVerifier?: IpRangeVerifier;
  /**
   * Read the current detection ruleset. Defaults to {@link getCurrentRuleset} —
   * the in-memory holder D2 populates from the network. Capture is
   * ruleset-INDEPENDENT: a raw row is always written. Classification is applied
   * ONLY when this returns a ruleset; when it returns `null` the row is stored
   * `pending` (family/class NULL, no version) — the no-baseline default — and
   * `backfillClassification` labels it once a ruleset loads. Injectable so tests
   * load a fixture without touching the global holder.
   */
  getRuleset?: () => Ruleset | null;
}

/** Handle returned by {@link installAgentCapture} for clean shutdown. */
export interface AgentCaptureHandle {
  /** Flush and stop the write buffer. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Resolve the real client IP. Prefers Cloudflare's authoritative
 * `CF-Connecting-IP`, then `req.ip` (derived from `X-Forwarded-For` because we
 * set `trust proxy`), then the raw socket address. NOTE: reading `req.headers`
 * for this VALUE lookup is fine — header casing is irrelevant to an IP address,
 * and the order/casing fingerprint is captured separately from `req.rawHeaders`.
 */
function resolveClientIp(req: Request): string | null {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) {
    return cf;
  }
  if (typeof req.ip === "string" && req.ip.length > 0) {
    return req.ip;
  }
  return req.socket?.remoteAddress ?? null;
}

/**
 * Install the agent capture middleware on an Express app. Returns a handle whose
 * {@link AgentCaptureHandle.stop} flushes the buffer (wire it to server
 * shutdown; not doing so only leaks an unref'd timer, never a live one).
 */
export function installAgentCapture(
  app: Express,
  opts: InstallAgentCaptureOptions = {},
): AgentCaptureHandle {
  const rng = opts.rng ?? Math.random;
  const now = opts.now ?? Date.now;
  const siteId = opts.siteId ?? DEFAULT_SITE_ID;

  const recorder = new AgentCaptureRecorder({
    getStorage: opts.getStorage ?? getActiveStorage,
    siteId,
    now,
    ...(opts.ipVerifier !== undefined ? { ipVerifier: opts.ipVerifier } : {}),
    getRuleset: opts.getRuleset ?? getCurrentRuleset,
  });

  // Real client IP requires trusting the proxy/tunnel in front of us.
  app.set("trust proxy", true);

  const middleware: RequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const gate = getAgentCaptureGate();
    if (!gate.enabled) {
      next();
      return;
    }
    const { sampleRate } = gate;
    const sampled = sampleRate >= 1 || (sampleRate > 0 && rng() < sampleRate);
    if (!sampled) {
      next();
      return;
    }

    const start = now();
    // Snapshot request-side facts NOW: they are all available synchronously and
    // some (rawHeaders) are cheaper to read before the handler runs.
    const rawHeaders = pairRawHeaders(req.rawHeaders);
    const minimal: MinimalRequest = {
      method: req.method,
      path: req.path,
      httpVersion: req.httpVersion,
      rawHeaders,
    };
    const ip = resolveClientIp(req);

    let recorded = false;
    const record = (): void => {
      if (recorded) {
        return;
      }
      recorded = true;
      // M3.5: a rescued would-be-404. The routing fallback sets this synchronously
      // before it sends the 200 representation, so it is populated by the time
      // `finish` fires. When set, the record's outcome is forced to `dead_end`
      // regardless of the 200 status — the honest pre-rescue truth.
      const rescuedDeadEnd = res.locals.enpilinkAgentRescuedDeadEnd === true;
      const outcome: CaptureOutcome = {
        status: res.statusCode,
        ts: start,
        ms: now() - start,
        ...(rescuedDeadEnd ? { rescuedDeadEnd: true } : {}),
      };
      // M4/M6: persist what the serving layer did for THIS request. M3/M6 set
      // these locals synchronously before ending the response, so they are
      // populated by the time `finish` fires.
      const flags: AgentRecordFlags = {};
      if (res.locals.enpilinkAgentServed === true) {
        flags.served = true;
      }
      if (
        res.locals.enpilinkAgentEncoding === "markdown" ||
        res.locals.enpilinkAgentEncoding === "html"
      ) {
        flags.servedEncoding = res.locals.enpilinkAgentEncoding;
      }
      if (res.locals.enpilinkAgentReencoded === true) {
        flags.reencoded = true;
      }
      if (res.locals.enpilinkAgentSpa === true) {
        flags.spa = true;
      }
      recorder.record(minimal, ip, outcome, flags);
    };

    res.on("finish", record);
    res.on("close", record);
    next();
  };

  // FIRST middleware: wraps every request, including unmatched paths that fall
  // through to Express's 404 finalhandler.
  app.use(middleware);

  return {
    stop: () => recorder.stop(),
  };
}
