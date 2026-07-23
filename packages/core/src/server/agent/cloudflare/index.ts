import type { AgentRequestRecord } from "../../storage/types.js";
import { classify } from "../detect.js";
import { buildEdgeRecord, edgeHeaderPairs } from "../edge/capture-edge.js";
import { safeHtmlToMarkdown } from "../html-to-markdown.js";
import {
  type AgentGetAffordance,
  type AgentSiteInfo,
  type AgentToolInfo,
  type Representation,
  represent,
} from "../represent-core.js";
import type { RulesetCacheStore } from "../ruleset/cache-store.js";
import { EdgeRulesetClient } from "../ruleset/edge-client.js";
import type { Ruleset } from "../ruleset/types.js";
import {
  agentServeEligibility,
  decideServeAction,
  type ServeEncoding,
} from "../serve-eligibility.js";
import type { EdgeCaptureSink } from "./sink.js";

/**
 * `enpilink/cloudflare` — the CLOUDFLARE WORKER agent adapter (D4b).
 *
 * Full capture + detect + (opt-in) serve in a Worker's `fetch` handler, running
 * in the request-path hop the Worker ALREADY is — no new hop, no Node built-ins.
 * One wrapper around your origin handler:
 *
 * ```ts
 * // worker.ts
 * import { agentCapture, d1CaptureSink } from "enpilink/cloudflare";
 *
 * export default agentCapture({
 *   serve: true,
 *   site: { title: "Acme", description: "Acme's API and docs." },
 *   // How to get the REAL response (proxy to origin, serve assets, run a router):
 *   fetchOrigin: (request, env) => env.ASSETS.fetch(request),
 *   // Store captures in D1 (CF-native) — or use a beaconCaptureSink({ sinkUrl }).
 *   sink: (env) => d1CaptureSink(env.DB),
 *   // Detection stays fresh from the CDN ruleset, warm across isolates via KV:
 *   ruleset: { cacheStore: (env) => new KVRulesetCacheStore({ kv: env.RULESET_KV }) },
 * });
 * ```
 *
 * ── THREE non-negotiable guarantees ──────────────────────────────────────────
 * 1. **Fail-open.** The ORIGIN response is resolved FIRST; the entire
 *    capture/serve wrapper runs in a `try` whose `catch` returns that origin
 *    response untouched. A bug in detection, serving, the ruleset, or the sink can
 *    NEVER turn a good page into an error. (The origin's OWN failure is the app's,
 *    and is never masked.)
 * 2. **Latency law.** `client.getRuleset()` is a synchronous field read; capture
 *    writes and the ruleset refresh are handed to `ctx.waitUntil()` — the response
 *    is NEVER delayed by I/O.
 * 3. **The cloaking guardrail holds.** Serving is decided by the shared, pure
 *    {@link agentServeEligibility} + {@link decideServeAction}: crawlers
 *    (Googlebot / every indexer), humans, subresources and framework surfaces
 *    ALWAYS pass through untouched; only an eligible chat fetcher (or an explicit
 *    `Accept: text/markdown`) is served.
 *
 * No baseline: a cold isolate whose cross-isolate cache is empty serves its first
 * request classified `pending` (capture still works); the `waitUntil` warm loads
 * the ruleset for every subsequent request. Zero `node:*` — asserted by
 * `next/edge-safety.test.ts`.
 */

/** The public CDN ruleset artifact (same default as the Node client). */
const DEFAULT_RULESET_URL = "https://cdn.enpitech.dev/agent/ruleset/v1.json";
/** The site id captured under when none is given. */
const DEFAULT_SITE_ID = "default";

/**
 * The Worker `ExecutionContext` fields the adapter uses — structural, so no
 * `@cloudflare/workers-types` dependency (the runtime supplies the real object).
 */
export interface CloudflareExecutionContext {
  /** Extend the isolate's lifetime until `promise` settles (fire-and-forget). */
  waitUntil(promise: Promise<unknown>): void;
  /** Optional — some runtimes expose it; the adapter never requires it. */
  passThroughOnException?(): void;
}

/** How the adapter obtains the ORIGIN/next response for a request. */
export type OriginHandler<Env> = (
  request: Request,
  env: Env,
  ctx: CloudflareExecutionContext,
) => Response | Promise<Response>;

/** The Worker default-export shape the adapter returns. */
export interface CloudflareFetchExport<Env> {
  fetch(
    request: Request,
    env: Env,
    ctx: CloudflareExecutionContext,
  ): Promise<Response>;
}

/** Detection-freshness (ruleset client) options. */
export interface CloudflareRulesetOptions<Env> {
  /** Fetch the ruleset from the network. Default `true`. */
  enabled?: boolean;
  /** The artifact URL. Default the public enpitech CDN. */
  url?: string;
  /** TTL override in seconds; `0`/absent ⇒ honor the artifact's `Cache-Control`. */
  ttlSeconds?: number;
  /** Hard fetch timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** `live` (long TTL) or `dev` (short TTL for testing signatures). Default live. */
  mode?: "live" | "dev";
  /**
   * Resolve the cross-isolate cache store from `env` — a
   * `KVRulesetCacheStore` (recommended) or `CacheApiRulesetCacheStore`. Without
   * one, the ruleset is held in-isolate only (a cold isolate re-fetches).
   */
  cacheStore?: (env: Env) => RulesetCacheStore | undefined;
}

/** Options for {@link agentCapture}. */
export interface CloudflareAgentCaptureOptions<Env = Record<string, unknown>> {
  /**
   * Capture agent requests. Defaults to **ON** — installing the adapter IS the
   * opt-in (like the standalone Node adapters). Explicit `false` disables capture
   * AND serving (the wrapper becomes a pass-through).
   */
  enabled?: boolean;
  /**
   * How to get the ORIGIN response. Falls back to `env.ASSETS.fetch(request)` when
   * an `ASSETS` binding is present, else `fetch(request)`. Provide it explicitly
   * for any non-trivial Worker (a router, an origin proxy).
   */
  fetchOrigin?: OriginHandler<Env>;

  /** Serve the representation to an eligible fetcher on a would-be 404/410 (opt-in). */
  serve?: boolean;
  /** Replace an eligible fetcher's 2xx HTML SPA shell with the representation (opt-in). */
  spa?: boolean;
  /** Re-encode an eligible fetcher's 2xx HTML to markdown (opt-in). */
  reencode?: boolean;

  /** Owner-declared site summary for the representation (account-free — no MCP server). */
  site?: AgentSiteInfo;
  /** Fallback title when the site declares none. */
  serverName?: string;
  /** Declared tools to advertise in the representation. */
  tools?: AgentToolInfo[];
  /** Declared GET affordances to advertise (M7). */
  affordances?: AgentGetAffordance[];

  /** Site id to attribute captures to. Default `"default"`. */
  siteId?: string;
  /**
   * Per-deployment salt for IP hashing. Without it, the IP is NOT hashed and NOT
   * stored (a raw IP is NEVER transmitted or persisted).
   */
  ipSalt?: string;
  /** Sampling fraction `[0,1]` for CAPTURE (serving is never sampled). Default 1. */
  sampleRate?: number;

  /** Detection-freshness (cached ruleset client) config. */
  ruleset?: CloudflareRulesetOptions<Env>;
  /**
   * An explicit ruleset value — bypasses the client entirely (advanced / testing).
   * When set, no network fetch is performed and this value classifies every row.
   */
  rulesetValue?: Ruleset | null;

  /**
   * Resolve the capture STORAGE SINK from `env` — `d1CaptureSink(env.DB)` for a
   * CF-native deploy, or `beaconCaptureSink({ sinkUrl, token })` to POST to a Node
   * enpilink server. Without a sink, capture is a no-op (nowhere to write).
   */
  sink?: (env: Env) => EdgeCaptureSink | undefined;

  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable RNG for sampling `[0,1)` (tests). Defaults to `Math.random`. */
  rng?: () => number;
  /** Injectable error sink for swallowed failures (tests / observability). */
  onError?: (err: unknown) => void;
}

/** The serve/transform outcome for one request. */
interface ServeFlags {
  served?: boolean;
  servedEncoding?: ServeEncoding;
  spa?: boolean;
  reencoded?: boolean;
  rescuedDeadEnd?: boolean;
}
interface ServeResult {
  response: Response;
  flags?: ServeFlags;
}

/** An `ASSETS`-like binding (static-asset Worker). */
interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/** Best-effort extraction of an `env.ASSETS` binding, or `null`. */
function getAssetsBinding(env: unknown): AssetsBinding | null {
  if (env && typeof env === "object" && "ASSETS" in env) {
    const assets = (env as { ASSETS?: unknown }).ASSETS;
    if (assets && typeof (assets as { fetch?: unknown }).fetch === "function") {
      return assets as AssetsBinding;
    }
  }
  return null;
}

/** Resolve the origin response — explicit handler, then `env.ASSETS`, then `fetch`. */
function resolveOrigin<Env>(
  options: CloudflareAgentCaptureOptions<Env>,
  request: Request,
  env: Env,
  ctx: CloudflareExecutionContext,
): Response | Promise<Response> {
  if (options.fetchOrigin) {
    return options.fetchOrigin(request, env, ctx);
  }
  const assets = getAssetsBinding(env);
  if (assets) {
    return assets.fetch(request);
  }
  return fetch(request);
}

/** Build the representation response (markdown or HTML) with the serve headers. */
function representationResponse(
  encoding: ServeEncoding,
  doc: Representation,
  status: number,
): Response {
  const headers = new Headers();
  // Adaptive by UA + Accept — never hand a human/crawler a cached agent doc.
  headers.set("Vary", "Accept, User-Agent");
  headers.set(
    "Cache-Control",
    "public, max-age=300, stale-while-revalidate=86400",
  );
  if (encoding === "markdown") {
    headers.set("Content-Type", "text/markdown; charset=utf-8");
    return new Response(doc.markdown, { status, headers });
  }
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(doc.html, { status, headers });
}

/**
 * Decide + apply the serve action for one request. Returns the (possibly rewritten)
 * response plus the flags to stamp on the captured record. The guardrail
 * ({@link agentServeEligibility}) runs FIRST — a crawler / human / subresource is
 * never touched. Async because `reencode` reads the origin body.
 */
async function maybeServe<Env>(
  options: CloudflareAgentCaptureOptions<Env>,
  request: Request,
  ruleset: Ruleset | null,
  origin: Response,
): Promise<ServeResult> {
  const serveFeaturesOn =
    options.serve === true || options.spa === true || options.reencode === true;
  if (!serveFeaturesOn) {
    return { response: origin };
  }

  const url = new URL(request.url);
  const accept = request.headers.get("accept") ?? "";
  const detection = classify(ruleset, edgeHeaderPairs(request.headers));
  const eligibility = agentServeEligibility({
    method: request.method,
    path: url.pathname,
    detection,
    accept,
  });
  if (!eligibility.eligible) {
    return { response: origin };
  }

  const action = decideServeAction({
    gate: {
      serve: options.serve === true,
      spa: options.spa === true,
      reencode: options.reencode === true,
    },
    status: origin.status,
    contentType: origin.headers.get("content-type") ?? "",
    contentEncoding: origin.headers.get("content-encoding") ?? "",
    encoding: eligibility.encoding,
  });

  if (action.kind === "passthrough") {
    return { response: origin };
  }

  const doc = represent({
    serverName: options.serverName ?? options.site?.title ?? "This app",
    site: options.site ?? {},
    tools: options.tools ?? [],
    affordances: options.affordances ?? [],
    path: url.pathname,
  });

  if (action.kind === "rescue") {
    // A would-be dead-end, answered with the representation at 200. Recorded as
    // the dead-end it truly was (`rescuedDeadEnd`) + `served`.
    return {
      response: representationResponse(action.encoding, doc, 200),
      flags: {
        served: true,
        servedEncoding: action.encoding,
        rescuedDeadEnd: true,
      },
    };
  }

  if (action.kind === "spa") {
    // Replace the 2xx SPA shell with the representation (status stays resolved).
    return {
      response: representationResponse(action.encoding, doc, origin.status),
      flags: { served: true, servedEncoding: action.encoding, spa: true },
    };
  }

  // reencode — convert the real 2xx HTML body to markdown. Read a CLONE so the
  // original stays intact for fail-open; if conversion fails, pass through.
  try {
    const html = await origin.clone().text();
    const markdown = safeHtmlToMarkdown(html);
    if (markdown === null) {
      return { response: origin };
    }
    const headers = new Headers();
    headers.set("Content-Type", "text/markdown; charset=utf-8");
    headers.set("Vary", "Accept, User-Agent");
    return {
      response: new Response(markdown, { status: origin.status, headers }),
      flags: { served: true, servedEncoding: "markdown", reencoded: true },
    };
  } catch {
    return { response: origin };
  }
}

/** Stamp the serve flags onto a built record (mirrors the Node recorder). */
function applyServeFlags(record: AgentRequestRecord, flags?: ServeFlags): void {
  if (!flags) {
    return;
  }
  if (flags.served) {
    record.served = true;
    if (flags.servedEncoding !== undefined) {
      record.servedEncoding = flags.servedEncoding;
    }
  }
  if (flags.spa) {
    record.meta = { ...(record.meta ?? {}), spa: true };
  }
  if (flags.reencoded) {
    record.meta = { ...(record.meta ?? {}), reencoded: true };
  }
}

/**
 * Wrap a Cloudflare Worker with agent capture + (opt-in) serving. Returns a
 * `{ fetch }` object usable directly as `export default`.
 */
export function agentCapture<Env = Record<string, unknown>>(
  options: CloudflareAgentCaptureOptions<Env> = {},
): CloudflareFetchExport<Env> {
  const enabled = options.enabled !== false;
  const siteId = options.siteId ?? DEFAULT_SITE_ID;
  const sampleRate = options.sampleRate ?? 1;
  const now = options.now ?? Date.now;
  const rng = options.rng ?? Math.random;
  const onError = options.onError ?? (() => {});

  const rulesetCfg = options.ruleset ?? {};
  // A client is used whenever no explicit `rulesetValue` was given. Its `enabled`
  // flag controls only NETWORK FETCH — even with fetch off it still warms from the
  // cross-isolate cache. So `ruleset.enabled: false` = "cache-only", not "no
  // ruleset"; pass `rulesetValue: null` for pending-only.
  const useClient = options.rulesetValue === undefined;
  // One client per adapter instance (per isolate), constructed lazily on the
  // first request so the env-derived cache store can be wired.
  let cachedClient: EdgeRulesetClient | null = null;

  function ensureClient(env: Env): EdgeRulesetClient | null {
    if (!useClient) {
      return null;
    }
    if (cachedClient) {
      return cachedClient;
    }
    const cacheStore = rulesetCfg.cacheStore?.(env);
    cachedClient = new EdgeRulesetClient({
      enabled: rulesetCfg.enabled !== false,
      url: rulesetCfg.url ?? DEFAULT_RULESET_URL,
      ...(rulesetCfg.ttlSeconds !== undefined
        ? { ttlSeconds: rulesetCfg.ttlSeconds }
        : {}),
      ...(rulesetCfg.timeoutMs !== undefined
        ? { timeoutMs: rulesetCfg.timeoutMs }
        : {}),
      ...(rulesetCfg.mode !== undefined ? { mode: rulesetCfg.mode } : {}),
      ...(cacheStore ? { cacheStore } : {}),
      onError,
    });
    return cachedClient;
  }

  return {
    async fetch(request, env, ctx): Promise<Response> {
      // (1) ORIGIN first — outside the fail-open try, so the app's OWN error is
      // never masked, and we always have an untouched response to fall back to.
      const origin = await resolveOrigin(options, request, env, ctx);
      if (!enabled) {
        return origin;
      }

      // (2) Everything below is FAIL-OPEN: any throw → return `origin` untouched.
      try {
        const start = now();
        const client = ensureClient(env);
        const ruleset: Ruleset | null =
          options.rulesetValue !== undefined
            ? options.rulesetValue
            : (client?.getRuleset() ?? null);

        // Serve is decided (and applied) ALWAYS when eligible — never sampled.
        const { response, flags } = await maybeServe(
          options,
          request,
          ruleset,
          origin,
        );

        // (3) CAPTURE — off the hot path, gated by sampling + a resolved sink.
        const sampled =
          sampleRate >= 1 || (sampleRate > 0 && rng() < sampleRate);
        if (sampled) {
          const sink = options.sink?.(env);
          if (sink) {
            const capturedStatus = response.status;
            ctx.waitUntil(
              captureOne({
                sink,
                request,
                capturedStatus,
                start,
                ms: now() - start,
                ruleset,
                flags,
                siteId,
                ipSalt: options.ipSalt,
                onError,
              }),
            );
          }
        }

        // (4) Stale-while-revalidate the ruleset in the background.
        if (client) {
          ctx.waitUntil(client.refreshInBackground());
        }

        return response;
      } catch (err) {
        onError(err);
        return origin;
      }
    },
  };
}

/** Build + write one captured record. Best-effort — never throws. */
async function captureOne(input: {
  sink: EdgeCaptureSink;
  request: Request;
  capturedStatus: number;
  start: number;
  ms: number;
  ruleset: Ruleset | null;
  flags?: ServeFlags;
  siteId: string;
  ipSalt?: string;
  onError: (err: unknown) => void;
}): Promise<void> {
  try {
    const record = await buildEdgeRecord(
      input.request,
      {
        status: input.capturedStatus,
        ts: input.start,
        ms: input.ms,
        ...(input.flags?.rescuedDeadEnd === true
          ? { rescuedDeadEnd: true }
          : {}),
      },
      {
        siteId: input.siteId,
        ...(input.ipSalt !== undefined ? { ipSalt: input.ipSalt } : {}),
        ruleset: input.ruleset,
      },
    );
    applyServeFlags(record, input.flags);
    await input.sink.write([record]);
  } catch (err) {
    input.onError(err);
  }
}

// ── Re-exports so everything installs from `enpilink/cloudflare` ────────────────
export {
  CacheApiRulesetCacheStore,
  type CacheApiRulesetCacheStoreOptions,
  type EdgeCacheLike,
  type EdgeKvLike,
  KVRulesetCacheStore,
  type KVRulesetCacheStoreOptions,
  MemoryRulesetCacheStore,
} from "../ruleset/edge-cache.js";
export {
  EdgeRulesetClient,
  type EdgeRulesetClientConfig,
  type EdgeRulesetClientOptions,
} from "../ruleset/edge-client.js";
export {
  parseRulesetEdge,
  safeParseRulesetEdge,
} from "../ruleset/validate-edge.js";
export {
  D1_SCHEMA,
  D1CaptureSink,
  type D1CaptureSinkOptions,
  type D1DatabaseLike,
  d1CaptureSink,
  ensureD1Schema,
} from "./d1.js";
export {
  BeaconCaptureSink,
  type BeaconCaptureSinkOptions,
  beaconCaptureSink,
  type EdgeCaptureSink,
} from "./sink.js";
