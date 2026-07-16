import { createHash, randomBytes } from "node:crypto";
import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { resolveConfig } from "../config/index.js";
import { getActiveStorage } from "../log-sink.js";
import type { AgentRequestRecord, StorageAdapter } from "../storage/types.js";
import { AgentWriteBuffer } from "./buffer.js";
import {
  type CaptureOutcome,
  type MinimalRequest,
  pairRawHeaders,
  toCaptureRecord,
} from "./capture.js";
import { getAgentCaptureGate } from "./capture-gate.js";

/**
 * Express adapter for the agent capture spine (M1).
 *
 * Installs ONE middleware, ahead of all route handlers, that — only when the
 * live {@link getAgentCaptureGate} says so — records one {@link AgentRequestRecord}
 * per request after the response finishes. It follows the same operational
 * discipline as `analytics.ts`: capture off by default, fire-and-forget writes,
 * a storage failure never breaks a response, and the request NEVER blocks on a
 * write.
 *
 * Two non-negotiables live here:
 * - **`trust proxy` is set**, so `req.ip` reflects the real client behind a
 *   proxy/tunnel (Cloudflare, srv.us, a load balancer).
 * - **The fingerprint is read from `req.rawHeaders`, NEVER `req.headers`.**
 *   `req.headers` lowercases, de-dupes and re-orders — destroying header casing
 *   and order, the two best fingerprint signals. `req.headers` is used ONLY for
 *   a case-insensitive IP-header *value* lookup, where casing is irrelevant.
 */

/** The site id M1 captures under (single-site). Multi-site is future work. */
export const DEFAULT_SITE_ID = "default";

/** Milliseconds in a day, for the retention window. */
const DAY_MS = 86_400_000;

/** How often the write path opportunistically sweeps expired rows. */
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
}

/** Handle returned by {@link installAgentCapture} for clean shutdown. */
export interface AgentCaptureHandle {
  /** Flush and stop the write buffer. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Compute the retention boundary and delete captured requests older than it.
 * Returns the number of rows removed. `retentionDays <= 0` disables pruning
 * (keep forever). This is the REAL retention the decorative `retention.*` config
 * never delivered.
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
  const getStorage = opts.getStorage ?? getActiveStorage;
  const rng = opts.rng ?? Math.random;
  const now = opts.now ?? Date.now;
  const siteId = opts.siteId ?? DEFAULT_SITE_ID;

  // Real client IP requires trusting the proxy/tunnel in front of us.
  app.set("trust proxy", true);

  // Per-site salt for IP hashing, resolved once and reused. `undefined` = not
  // yet resolved; `null` = resolution failed / storage can't store sites (then
  // we simply omit the hash — we NEVER fall back to a raw IP).
  let resolvedSalt: string | null | undefined;
  let saltPromise: Promise<string | null> | null = null;
  const ensureSalt = (): Promise<string | null> => {
    if (resolvedSalt !== undefined) {
      return Promise.resolve(resolvedSalt);
    }
    if (!saltPromise) {
      saltPromise = (async () => {
        const storage = getStorage();
        if (!storage?.ensureAgentSite) {
          resolvedSalt = null;
          return null;
        }
        try {
          const site = await storage.ensureAgentSite({
            id: siteId,
            ipSalt: randomBytes(32).toString("hex"),
            createdAt: now(),
          });
          resolvedSalt = site.ipSalt;
          return site.ipSalt;
        } catch {
          resolvedSalt = null;
          return null;
        }
      })();
    }
    return saltPromise;
  };

  // Opportunistic retention sweep, throttled and driven off write activity so
  // there is NO standalone always-on timer (nothing runs while capture is off).
  let lastSweepAt = 0;
  const maybeSweep = (storage: StorageAdapter): void => {
    const t = now();
    if (t - lastSweepAt < RETENTION_SWEEP_INTERVAL_MS) {
      return;
    }
    lastSweepAt = t;
    void (async () => {
      try {
        const { values } = await resolveConfig(storage);
        await pruneAgentData(storage, values["agent.retentionDays"], now());
      } catch {
        // Sweep is best-effort.
      }
    })();
  };

  const buffer = new AgentWriteBuffer({
    sink: async (records) => {
      const storage = getStorage();
      if (!storage?.recordAgentRequests) {
        return;
      }
      await storage.recordAgentRequests(records);
      maybeSweep(storage);
    },
  });

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
    const method = req.method;
    const path = req.path;
    const httpVersion = req.httpVersion;
    const ip = resolveClientIp(req);

    let recorded = false;
    const record = (): void => {
      if (recorded) {
        return;
      }
      recorded = true;
      const outcome: CaptureOutcome = {
        status: res.statusCode,
        ts: start,
        ms: now() - start,
      };
      // Build + enqueue AFTER the response is done, so nothing here touches the
      // request latency. Salt/hash resolution is async but off the hot path.
      void (async () => {
        let ipHash: string | undefined;
        if (ip) {
          const salt = await ensureSalt();
          if (salt) {
            ipHash = hashIp(ip, salt);
          }
        }
        const minimal: MinimalRequest = {
          method,
          path,
          httpVersion,
          rawHeaders,
        };
        if (ipHash !== undefined) {
          minimal.ipHash = ipHash;
        }
        const rec: AgentRequestRecord = toCaptureRecord(
          minimal,
          outcome,
          siteId,
        );
        buffer.enqueue(rec);
      })();
    };

    res.on("finish", record);
    res.on("close", record);
    next();
  };

  // FIRST middleware: wraps every request, including unmatched paths that fall
  // through to Express's 404 finalhandler.
  app.use(middleware);

  return {
    stop: () => buffer.stop(),
  };
}
