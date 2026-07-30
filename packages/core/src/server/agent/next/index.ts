import { BeaconSink, type FetchLike } from "../edge/beacon.js";
import { buildEdgeRecord } from "../edge/capture-edge.js";
// TYPE-ONLY (erased): the persisted-cache seam — the KV/Cache-API/memory impls
// are supplied by the caller, so no store implementation enters this graph.
import type { RulesetCacheStore } from "../ruleset/cache-store.js";
// The zod-free edge ruleset client (D4b) — auto-fetches + validates the ruleset so
// the Next edge path no longer needs a hand-passed `ruleset` value.
import { EdgeRulesetClient } from "../ruleset/edge-client.js";
// TYPE-ONLY (erased): edge-safe — the ruleset VALUE is supplied by the caller.
import type { Ruleset } from "../ruleset/types.js";

/**
 * `enpilink/next` — the Next.js **edge middleware** agent-capture adapter (M8).
 *
 * Next.js `middleware.ts` runs on the **edge runtime**: a Web-standard
 * `Request`/`Response`, `fetch`, `crypto.subtle`, and `event.waitUntil()` — and
 * **no `better-sqlite3`, no `node:fs`, no in-process `StorageAdapter`.** So this
 * adapter cannot write to storage directly. It:
 *   1. builds a capture record from the Web `Request` (reusing the SAME pure
 *      `capture.ts`/`detect.ts` the Node path uses — see `edge/capture-edge.ts`),
 *   2. hashes the client IP with `crypto.subtle` (never stores a raw IP), and
 *   3. **POSTs a batch to the beacon sink** (`ingest.ts`, mounted in a full Node
 *      enpilink server) **inside `event.waitUntil()`**, so it NEVER blocks the
 *      response and a sink failure never breaks the page.
 *
 * This module imports ONLY the edge-safe pieces (`edge/*`, which in turn import
 * only the pure `capture.ts`/`detect.ts`). It pulls in NO `node:*`, Express, or
 * storage — asserted by `edge-safety.test.ts`.
 *
 * ── SCOPE: this is a CAPTURE adapter, not a SERVE adapter. ────────────────────
 * It observes the request and beacons the fingerprint + detection. It does NOT
 * port the M3 detect→serve representation layer to the edge (that is heavier and
 * Node-oriented). And because Next middleware runs BEFORE the route resolves, the
 * downstream 200-vs-404 is generally invisible here — see `edge/capture-edge.ts`
 * for the full "what the edge can and cannot see vs the Node path" note. The
 * authoritative outcome/dead-end analytics remains the Node/Express path; the
 * edge's job is DETECTION + the fingerprint corpus.
 */

// Response headers Next sets on a `NextResponse.next()` / `.rewrite()` — they
// mean "the route is still resolved downstream", so the status we hold is NOT
// the final page status. We record such requests with an unknown status.
const MIDDLEWARE_CONTINUE_HEADERS = [
  "x-middleware-next",
  "x-middleware-rewrite",
] as const;

/** A structural Web `Request` — matches Next's `NextRequest` without importing `next`. */
export type EdgeRequest = Request;

/**
 * The structural shape of Next's `NextFetchEvent` we depend on. Typed
 * structurally so `enpilink/next` needs NO `next` dependency (the user's Next
 * runtime supplies the real object).
 */
export interface EdgeFetchEvent {
  /** Extend the invocation's lifetime until `promise` settles (fire-and-forget). */
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The inner middleware body. Receives the request and returns the Next response
 * (`NextResponse.next()`, a redirect/rewrite, or an explicit `Response`), or
 * `undefined`/nothing to continue. Optional — omit it for capture-only.
 */
export type EdgeMiddlewareHandler = (
  request: EdgeRequest,
  event: EdgeFetchEvent,
) => Response | undefined | Promise<Response | undefined>;

/** Options for {@link withAgentCapture}. */
export interface WithAgentCaptureOptions {
  /**
   * Master switch. **OFF by default** — capture only runs when this is
   * explicitly `true` (and {@link sinkUrl} is set). Mirrors the framework's
   * capture-off-by-default discipline.
   */
  enabled?: boolean;
  /**
   * The beacon sink URL — a full Node enpilink server's ingest endpoint, e.g.
   * `https://your-app.com/__enpilink/agents/ingest`. Required when
   * {@link enabled}; capture is inert without it.
   */
  sinkUrl?: string;
  /**
   * The shared bearer token the sink validates (its `ENPILINK_AGENT_INGEST_TOKEN`
   * / `agent.ingestToken`). Sent as `Authorization: Bearer <token>`. Without a
   * matching token the sink rejects the batch.
   */
  token?: string;
  /**
   * Per-deployment salt for IP hashing. When absent, the IP is NOT hashed and
   * NOT sent (we NEVER transmit or store a raw IP). Set it to the target site's
   * salt if you want edge hashes to be joinable with Node-captured ones.
   */
  ipSalt?: string;
  /** Site id to attribute captures to. Default `"default"`. */
  siteId?: string;
  /** Sampling fraction `[0,1]`. Default 1 (capture every request). */
  sampleRate?: number;
  /** Max records per beacon POST. Default 20. */
  maxBatch?: number;
  /** Hard cap on the pending queue; enqueue past this DROPS. Default 1000. */
  maxQueue?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable RNG for sampling `[0,1)` (tests). Defaults to `Math.random`. */
  rng?: () => number;
  /**
   * An EXPLICIT loaded detection ruleset (D1). When provided, it classifies every
   * captured record and BYPASSES the auto-fetch client below — an advanced/testing
   * override. When absent, the {@link rulesetEnabled} client supplies the ruleset
   * (or records are beaconed `pending` until it loads — the no-baseline default,
   * backfilled by the Node sink).
   */
  ruleset?: Ruleset | null;

  // ── Detection freshness — the auto-fetch edge ruleset client (D4b) ────────────
  /**
   * Auto-fetch the detection ruleset (stale-while-revalidate, off the hot path via
   * `waitUntil`) so the edge path classifies without a hand-passed `ruleset`.
   * Requires a {@link rulesetUrl}: the edge has no packaged ruleset of its own, so
   * with no URL the edge captures records `pending` and your Node enpilink server
   * classifies them on ingest. Defaults to `true` when a `rulesetUrl` is set; set
   * `false` to keep the `pending` behaviour even with a URL configured.
   */
  rulesetEnabled?: boolean;
  /**
   * The ruleset artifact URL. **Point it at YOUR OWN enpilink server's public
   * ruleset endpoint** (`https://your-app.com/__enpilink/agents/ruleset`) or a
   * mirror you run — never at enpitech (enpilink is self-hosted; there is no
   * enpitech CDN). Without it the edge stays `pending` and the Node sink backfills.
   */
  rulesetUrl?: string;
  /**
   * A cross-isolate persisted cache for the fetched ruleset — a
   * `KVRulesetCacheStore` / `CacheApiRulesetCacheStore` (from `enpilink/cloudflare`)
   * so a cold isolate warms without re-fetching. Without one, the ruleset is held
   * in-isolate only (a cold isolate re-fetches; a warm one does not).
   */
  rulesetCacheStore?: RulesetCacheStore;
  /** TTL override in seconds; `0`/absent ⇒ honor the artifact's `Cache-Control`. */
  rulesetTtlSeconds?: number;
  /** Hard ruleset-fetch timeout in ms. Default 5000. */
  rulesetTimeoutMs?: number;
  /** `live` (long TTL) or `dev` (short TTL for testing signatures). Default live. */
  rulesetMode?: "live" | "dev";
}

const DEFAULT_SITE_ID = "default";

/**
 * Wrap a Next.js edge middleware with agent capture. Returns a middleware
 * function of Next's shape `(request, event) => Response | undefined`.
 *
 * The wrapper runs your `handler` (or a pass-through), returns its response to
 * Next SYNCHRONOUSLY (never awaited on the response path), and — when capture is
 * enabled and the request is sampled — builds the record and POSTs it to the
 * sink INSIDE `event.waitUntil()`. Capture can never block, throw onto, or slow
 * the response; a sink failure is swallowed.
 *
 * @example
 * ```ts
 * // middleware.ts
 * import { withAgentCapture } from "enpilink/next";
 *
 * export const middleware = withAgentCapture({
 *   enabled: true,
 *   sinkUrl: "https://your-app.com/__enpilink/agents/ingest",
 *   token: process.env.ENPILINK_AGENT_INGEST_TOKEN,
 *   ipSalt: process.env.ENPILINK_AGENT_IP_SALT,
 * });
 *
 * export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
 * ```
 */
export function withAgentCapture(
  options: WithAgentCaptureOptions = {},
  handler?: EdgeMiddlewareHandler,
): (
  request: EdgeRequest,
  event: EdgeFetchEvent,
) => Response | undefined | Promise<Response | undefined> {
  const now = options.now ?? Date.now;
  const rng = options.rng ?? Math.random;
  const siteId = options.siteId ?? DEFAULT_SITE_ID;
  const sampleRate = options.sampleRate ?? 1;

  // Capture is OFF unless explicitly enabled AND a sink URL is set. The sink is
  // constructed once and shared across invocations (opportunistic batching).
  const active =
    options.enabled === true &&
    typeof options.sinkUrl === "string" &&
    options.sinkUrl.length > 0;
  const sink = active
    ? new BeaconSink({
        sinkUrl: options.sinkUrl as string,
        ...(options.token !== undefined ? { token: options.token } : {}),
        ...(options.maxBatch !== undefined
          ? { maxBatch: options.maxBatch }
          : {}),
        ...(options.maxQueue !== undefined
          ? { maxQueue: options.maxQueue }
          : {}),
        ...(options.fetchImpl !== undefined
          ? { fetchImpl: options.fetchImpl }
          : {}),
      })
    : null;

  // The auto-fetch ruleset client (D4b) — created when capture is active, no
  // explicit `ruleset` value was passed (which bypasses it; pass `ruleset: null`
  // for pending-only), AND there is a source for the ruleset: a `rulesetUrl`
  // (fetch from your OWN enpilink server's `/__enpilink/agents/ruleset` — never
  // enpitech) or a pre-populated `rulesetCacheStore`. The edge has no packaged
  // ruleset of its own, so with neither there is nothing to load: the edge
  // captures `pending` and the Node sink backfills. NETWORK FETCH happens only
  // with a URL; a cache-store-only client is cache-only. Reads the ruleset
  // synchronously on the hot path; refreshes via `waitUntil`.
  const rulesetUrl =
    typeof options.rulesetUrl === "string" && options.rulesetUrl.length > 0
      ? options.rulesetUrl
      : null;
  const rulesetClient =
    active &&
    options.ruleset === undefined &&
    (rulesetUrl !== null || options.rulesetCacheStore !== undefined)
      ? new EdgeRulesetClient({
          enabled: options.rulesetEnabled !== false && rulesetUrl !== null,
          url: rulesetUrl ?? "",
          ...(options.rulesetTtlSeconds !== undefined
            ? { ttlSeconds: options.rulesetTtlSeconds }
            : {}),
          ...(options.rulesetTimeoutMs !== undefined
            ? { timeoutMs: options.rulesetTimeoutMs }
            : {}),
          ...(options.rulesetMode !== undefined
            ? { mode: options.rulesetMode }
            : {}),
          ...(options.rulesetCacheStore !== undefined
            ? { cacheStore: options.rulesetCacheStore }
            : {}),
        })
      : null;

  return (request, event) => {
    // Always run the handler first; its response is returned to Next unchanged.
    const result = handler ? handler(request, event) : undefined;

    if (!sink) {
      return result;
    }
    // Stale-while-revalidate the ruleset in the background — independent of
    // capture sampling, always off the hot path, never awaited.
    if (rulesetClient) {
      event.waitUntil(rulesetClient.refreshInBackground());
    }
    const sampled = sampleRate >= 1 || (sampleRate > 0 && rng() < sampleRate);
    if (!sampled) {
      return result;
    }

    const start = now();
    // Capture runs entirely inside waitUntil — off the response path. We resolve
    // the handler's response (if async) only to read its status; the SAME value
    // is returned to Next above, so nothing here delays the response.
    event.waitUntil(
      Promise.resolve(result)
        .then(async (res) => {
          const status = statusFromResponse(res);
          const ms = now() - start;
          const record = await buildEdgeRecord(
            request,
            { status, ts: start, ms },
            {
              siteId,
              ...(options.ipSalt !== undefined
                ? { ipSalt: options.ipSalt }
                : {}),
              // Explicit value wins; else the auto-fetch client's held ruleset
              // (or null ⇒ `pending`, the no-baseline default).
              ruleset: options.ruleset ?? rulesetClient?.getRuleset() ?? null,
            },
          );
          sink.add(record);
          await sink.drainAndSend();
        })
        .catch(() => {
          // Capture is best-effort; a build/beacon failure never surfaces.
        }),
    );

    return result;
  };
}

/**
 * Derive the status to record from the middleware's response. A middleware that
 * produced the response itself (redirect / block / explicit `Response`) gives a
 * real status; a `NextResponse.next()` / `.rewrite()` (marked by an
 * `x-middleware-*` header) leaves the final page status to the route downstream,
 * so we record `0` (→ `meta.statusUnknown`). No response at all → `0` too.
 */
function statusFromResponse(res: Response | undefined): number {
  if (!res || typeof res.status !== "number") {
    return 0;
  }
  for (const h of MIDDLEWARE_CONTINUE_HEADERS) {
    if (res.headers?.get?.(h)) {
      return 0;
    }
  }
  return res.status;
}

/**
 * Read {@link withAgentCapture} options from `process.env` (Next inlines
 * `process.env.*` at build). Capture is enabled ONLY when a sink URL is set, so a
 * bare `export { default } from "enpilink/next"` is a safe no-op until configured.
 * `process` is guarded so a non-Next bundler doesn't throw at import.
 */
function optionsFromEnv(): WithAgentCaptureOptions {
  const env: Record<string, string | undefined> =
    typeof process !== "undefined" && process.env ? process.env : {};
  const sinkUrl = env.ENPILINK_AGENT_SINK_URL;
  const opts: WithAgentCaptureOptions = {
    enabled: typeof sinkUrl === "string" && sinkUrl.length > 0,
  };
  if (sinkUrl !== undefined) {
    opts.sinkUrl = sinkUrl;
  }
  if (env.ENPILINK_AGENT_INGEST_TOKEN !== undefined) {
    opts.token = env.ENPILINK_AGENT_INGEST_TOKEN;
  }
  if (env.ENPILINK_AGENT_IP_SALT !== undefined) {
    opts.ipSalt = env.ENPILINK_AGENT_IP_SALT;
  }
  if (env.ENPILINK_AGENT_RULESET === "false") {
    opts.rulesetEnabled = false;
  }
  if (env.ENPILINK_AGENT_RULESET_URL !== undefined) {
    opts.rulesetUrl = env.ENPILINK_AGENT_RULESET_URL;
  }
  return opts;
}

/**
 * THE ONE-LINE INSTALL: in `middleware.ts`, `export { default } from "enpilink/next"`.
 * A capture middleware configured from `ENPILINK_AGENT_*` env vars (see
 * {@link optionsFromEnv}) — a no-op passthrough until `ENPILINK_AGENT_SINK_URL` is
 * set, and once set it captures + auto-fetches the ruleset. For explicit config
 * (or an in-line handler), call the named {@link withAgentCapture} instead.
 */
const middleware = withAgentCapture(optionsFromEnv());
export default middleware;

export {
  BeaconSink,
  type BeaconSinkOptions,
  type FetchLike,
} from "../edge/beacon.js";
export {
  type BuildEdgeRecordOptions,
  buildEdgeRecord,
  type EdgeCaptureOutcome,
  edgeHeaderPairs,
  hashIpEdge,
  resolveEdgeClientIp,
} from "../edge/capture-edge.js";
