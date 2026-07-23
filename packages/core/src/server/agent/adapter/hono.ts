import { getActiveStorage } from "../../log-sink.js";
import type { HeaderPair, StorageAdapter } from "../../storage/types.js";
import {
  type CaptureOutcome,
  type MinimalRequest,
  pairRawHeaders,
} from "../capture.js";
import { type AgentCaptureGate, getAgentCaptureGate } from "../capture-gate.js";
import { classify } from "../detect.js";
import { edgeHeaderPairs, resolveEdgeClientIp } from "../edge/capture-edge.js";
import { safeHtmlToMarkdown } from "../html-to-markdown.js";
import type { IpRangeVerifier } from "../ip-ranges.js";
import type {
  AgentGetAffordance,
  AgentSiteInfo,
  AgentToolInfo,
} from "../represent.js";
import { agentServeEligibility } from "../route.js";
import { getCurrentRuleset } from "../ruleset/holder.js";
import type { Ruleset } from "../ruleset/types.js";
import {
  AgentCaptureRecorder,
  type AgentRecordFlags,
  buildRepresentationDoc,
  DEFAULT_SITE_ID,
  decideServeAction,
  ensureAgentAdapterInstalled,
  type RepresentationSources,
} from "./core.js";

/**
 * `enpilink/hono` — the standalone Hono agent adapter (Node runtime, D4a).
 *
 * ONE line — `app.use("*", agentCapture())` — turns a Hono app into an agent
 * surface, sharing the SAME capture pipeline and cloaking guardrail as the Express
 * adapter and the McpServer. On first use it activates storage (default sqlite),
 * flips capture ON, and starts the D2 ruleset client in the background.
 *
 * Hono is a Web-standard framework: `c.req.raw` is a Web `Request`, whose `Headers`
 * are LOWERCASED and SORTED — losing the header order/casing that carry the best
 * disguise tells (`Sec-Ch-Ua` title-casing). On the **Node runtime**
 * (`@hono/node-server`) we recover full fidelity from the underlying Node
 * `IncomingMessage` (`c.env.incoming.rawHeaders`, same source Express reads); on any
 * other runtime we fall back to the Web `Headers` (degraded exactly like the edge
 * capture path — see `edge/capture-edge.ts`). Hono-on-EDGE (CF/Bun/Deno) is D4b's
 * concern; this adapter is the Node runtime.
 *
 * The middleware runs capture AFTER `await next()` (so it sees the final status)
 * and, when serving is opted in, rewrites `c.res` for an eligible fetcher:
 * a would-be-404 becomes the representation; a crawler/human/subresource is never
 * touched (the guardrail lives in `route.ts`).
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { agentCapture } from "enpilink/hono";
 *
 * const app = new Hono();
 * app.use("*", agentCapture());          // capture-only, out of the box
 * // app.use("*", agentCapture({ serve: true, siteTitle: "Northwind" }));
 * ```
 */

// ── Structural Hono typings (so this adapter needs NO `hono` dependency) ─────────

/** The `HonoRequest` surface we depend on — a real one is assignable to this. */
export interface HonoRequestLike {
  /** The underlying Web `Request`. */
  raw: Request;
  /** HTTP method. */
  method: string;
  /** Request pathname. */
  path: string;
}

/**
 * The subset of the `@hono/node-server` Node bindings (`c.env`) we read for
 * full-fidelity capture. Absent on non-Node runtimes.
 */
export interface HonoNodeIncoming {
  /** Node's flat `[name, value, name, value, …]` — original order + casing. */
  rawHeaders?: string[];
  /** HTTP version string, e.g. `"1.1"`. */
  httpVersion?: string;
  /** The socket, for the direct-connection client IP fallback. */
  socket?: { remoteAddress?: string };
}

/** The Hono `Context` surface we depend on — a real `Context` is assignable to this. */
export interface HonoContextLike {
  req: HonoRequestLike;
  /** The current response. Assignable — we replace it when serving. */
  res: Response;
  /** Runtime bindings; on `@hono/node-server` this carries `{ incoming, outgoing }`. */
  env?: unknown;
}

/** Hono's `next` — run the downstream chain. */
export type HonoNext = () => Promise<void>;

/** The middleware shape `app.use` accepts. */
export type HonoMiddleware = (
  c: HonoContextLike,
  next: HonoNext,
) => Promise<void>;

/** Options for {@link agentCapture} (Hono). Mirrors the Express adapter's. */
export interface HonoAgentCaptureOptions {
  /** Capture agent requests. Defaults to **ON** — installing is the opt-in. */
  enabled?: boolean;
  /** Sampling fraction `[0,1]`. Defaults to the resolved config (1). */
  sampleRate?: number;
  /** Serve the representation to an eligible chat fetcher on a would-be-404. OFF by default. */
  serve?: boolean;
  /** Replace an eligible fetcher's 2xx SPA shell with the representation. OFF by default. */
  spa?: boolean;
  /** Re-encode an eligible fetcher's 2xx HTML response to markdown. OFF by default. */
  reencode?: boolean;
  /** Turn on the optional published-IP-range confidence tier. OFF by default. */
  verifyIpRanges?: boolean;
  /** Owner-declared site title for the representation. */
  siteTitle?: string;
  /** Owner-declared site description for the representation. */
  siteDescription?: string;
  /** A few short factual statements about the app (representation bullets). */
  siteFacts?: string[];
  /** Fallback representation title when none is declared. Defaults to `"enpilink"`. */
  serverName?: string;
  /** Site id to attribute captures to. Defaults to `"default"`. */
  siteId?: string;
  /** The declared tool index for the representation. Defaults to none. */
  getTools?: () => AgentToolInfo[];
  /** GET-exposed tools as affordances (M7). Only used when `agent.getTransport` is on. */
  getGetAffordances?: () => AgentGetAffordance[];

  // ── Test seams ──
  /** Resolve the active storage. Defaults to {@link getActiveStorage}. */
  getStorage?: () => StorageAdapter | null;
  /** Read the current detection ruleset. Defaults to {@link getCurrentRuleset}. */
  getRuleset?: () => Ruleset | null;
  /** Read the live gate. Defaults to {@link getAgentCaptureGate}. */
  getGate?: () => AgentCaptureGate;
  /** IP-range verifier for the optional tier. Injected so tests skip the network. */
  ipVerifier?: IpRangeVerifier;
  /** RNG for sampling `[0,1)`. Defaults to `Math.random`. */
  rng?: () => number;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Skip the one-time process bootstrap. Tests that wire state themselves set this. */
  skipInstall?: boolean;
}

let sharedRecorder: AgentCaptureRecorder | null = null;

function getSharedRecorder(
  opts: HonoAgentCaptureOptions,
): AgentCaptureRecorder {
  if (!sharedRecorder) {
    sharedRecorder = new AgentCaptureRecorder({
      getStorage: opts.getStorage ?? getActiveStorage,
      siteId: opts.siteId ?? DEFAULT_SITE_ID,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.ipVerifier !== undefined ? { ipVerifier: opts.ipVerifier } : {}),
      getRuleset: opts.getRuleset ?? getCurrentRuleset,
      getGate: opts.getGate ?? getAgentCaptureGate,
    });
  }
  return sharedRecorder;
}

/** TEST-ONLY: drop the shared recorder so a fresh one is built next call. */
export function __resetHonoAdapter(): void {
  sharedRecorder = null;
}

/** TEST-ONLY: flush the shared recorder's write buffer. */
export function __flushHonoAdapter(): Promise<void> {
  return sharedRecorder ? sharedRecorder.stop() : Promise.resolve();
}

/** The `@hono/node-server` incoming message, when running on Node. */
function nodeIncoming(c: HonoContextLike): HonoNodeIncoming | undefined {
  const env = c.env as { incoming?: HonoNodeIncoming } | undefined;
  return env?.incoming;
}

/**
 * The request fingerprint pairs. On the Node runtime this reads the raw
 * `IncomingMessage.rawHeaders` (original order + casing — full Express-grade
 * fidelity); otherwise it falls back to the Web `Headers` (lowercased + sorted).
 */
function honoRawHeaderPairs(c: HonoContextLike): HeaderPair[] {
  const inc = nodeIncoming(c);
  if (inc?.rawHeaders && Array.isArray(inc.rawHeaders)) {
    return pairRawHeaders(inc.rawHeaders);
  }
  return edgeHeaderPairs(c.req.raw.headers);
}

/** Resolve the client IP: forwarded headers first, then the Node socket. */
function honoClientIp(c: HonoContextLike): string | null {
  const fromHeaders = resolveEdgeClientIp(c.req.raw.headers);
  if (fromHeaders) {
    return fromHeaders;
  }
  return nodeIncoming(c)?.socket?.remoteAddress ?? null;
}

/** HTTP version, when the Node runtime exposes it. */
function honoHttpVersion(c: HonoContextLike): string {
  return nodeIncoming(c)?.httpVersion ?? "";
}

/**
 * The Hono agent-capture middleware. Returns one handler you mount ONCE:
 * `app.use("*", agentCapture())`.
 */
export function agentCapture(
  options: HonoAgentCaptureOptions = {},
): HonoMiddleware {
  const rng = options.rng ?? Math.random;
  const now = options.now ?? Date.now;
  const readGate = options.getGate ?? getAgentCaptureGate;
  const getRuleset = options.getRuleset ?? getCurrentRuleset;

  if (options.skipInstall !== true) {
    void ensureAgentAdapterInstalled({
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.sampleRate !== undefined
        ? { sampleRate: options.sampleRate }
        : {}),
      ...(options.serve !== undefined ? { serve: options.serve } : {}),
      ...(options.spa !== undefined ? { spa: options.spa } : {}),
      ...(options.reencode !== undefined ? { reencode: options.reencode } : {}),
      ...(options.verifyIpRanges !== undefined
        ? { verifyIpRanges: options.verifyIpRanges }
        : {}),
      ...(options.siteTitle !== undefined
        ? { siteTitle: options.siteTitle }
        : {}),
      ...(options.siteDescription !== undefined
        ? { siteDescription: options.siteDescription }
        : {}),
    });
  }

  const recorder = getSharedRecorder(options);

  const sources: RepresentationSources = {
    getTools: options.getTools ?? (() => []),
    getSiteInfo: () => {
      const site: AgentSiteInfo = {};
      if (options.siteFacts && options.siteFacts.length > 0) {
        site.facts = options.siteFacts;
      }
      return site;
    },
    getServerName: () => options.serverName ?? "enpilink",
    ...(options.getGetAffordances !== undefined
      ? { getGetAffordances: options.getGetAffordances }
      : {}),
  };

  return async (c: HonoContextLike, next: HonoNext): Promise<void> => {
    const gate = readGate();
    const start = now();
    // Snapshot the request BEFORE running downstream — the Node incoming message's
    // rawHeaders are the freshest here, and the request is unchanged by handlers.
    const rawHeaders = honoRawHeaderPairs(c);
    const minimal: MinimalRequest = {
      method: c.req.method,
      path: c.req.path,
      httpVersion: honoHttpVersion(c),
      rawHeaders,
    };
    const ip = honoClientIp(c);

    await next();

    const flags: AgentRecordFlags = {};
    let rescuedDeadEnd = false;

    // ── SERVE / TRANSFORM (independent of capture sampling) ──
    if (gate.serve === true || gate.spa === true || gate.reencode === true) {
      try {
        const accept = c.req.raw.headers.get("accept") ?? "";
        const detection = classify(getRuleset(), rawHeaders);
        const elig = agentServeEligibility({
          method: c.req.method,
          path: c.req.path,
          detection,
          accept,
        });
        if (elig.eligible) {
          rescuedDeadEnd = await applyHonoServe(c, {
            gate,
            encoding: elig.encoding,
            sources,
            path: c.req.path,
            flags,
          });
        }
      } catch {
        // Serving must NEVER break a response — leave c.res untouched.
      }
    }

    // ── CAPTURE (sampled) ──
    if (gate.enabled) {
      const { sampleRate } = gate;
      const sampled = sampleRate >= 1 || (sampleRate > 0 && rng() < sampleRate);
      if (sampled) {
        const outcome: CaptureOutcome = {
          status: c.res.status,
          ts: start,
          ms: now() - start,
          ...(rescuedDeadEnd ? { rescuedDeadEnd: true } : {}),
        };
        recorder.record(minimal, ip, outcome, flags);
      }
    }
  };
}

interface HonoServeContext {
  gate: AgentCaptureGate;
  encoding: "markdown" | "html";
  sources: RepresentationSources;
  path: string;
  flags: AgentRecordFlags;
}

/**
 * Rewrite an ELIGIBLE fetcher's `c.res` per {@link decideServeAction}. Returns
 * whether this was a rescued would-be-404 (so the capture path records the honest
 * dead-end). Mutates `ctx.flags` with what was served.
 */
async function applyHonoServe(
  c: HonoContextLike,
  ctx: HonoServeContext,
): Promise<boolean> {
  const res = c.res;
  const action = decideServeAction({
    gate: ctx.gate,
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    contentEncoding: res.headers.get("content-encoding") ?? "",
    encoding: ctx.encoding,
  });

  if (action.kind === "passthrough") {
    return false;
  }

  if (action.kind === "rescue") {
    const doc = buildRepresentationDoc(ctx.gate, ctx.sources, ctx.path);
    const out = action.encoding === "html" ? doc.html : doc.markdown;
    c.res = new Response(out, {
      status: 200,
      headers: {
        "Content-Type":
          action.encoding === "html"
            ? "text/html; charset=utf-8"
            : "text/markdown; charset=utf-8",
        Vary: "Accept, User-Agent",
        "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      },
    });
    ctx.flags.served = true;
    ctx.flags.servedEncoding = action.encoding;
    return true;
  }

  if (action.kind === "spa") {
    const doc = buildRepresentationDoc(ctx.gate, ctx.sources, ctx.path);
    const out = action.encoding === "html" ? doc.html : doc.markdown;
    c.res = new Response(out, {
      status: res.status,
      headers: {
        "Content-Type":
          action.encoding === "html"
            ? "text/html; charset=utf-8"
            : "text/markdown; charset=utf-8",
        Vary: "Accept, User-Agent",
        "Cache-Control": "private, no-store",
      },
    });
    ctx.flags.served = true;
    ctx.flags.spa = true;
    ctx.flags.servedEncoding = action.encoding;
    return false;
  }

  // reencode — consume the body once, convert, and rebuild the response. A
  // poor/empty conversion restores the original HTML untouched.
  const html = await res.text();
  const md = safeHtmlToMarkdown(html);
  if (md === null) {
    c.res = new Response(html, { status: res.status, headers: res.headers });
    return false;
  }
  c.res = new Response(md, {
    status: res.status,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept, User-Agent",
      "Cache-Control": "private, no-store",
    },
  });
  ctx.flags.reencoded = true;
  ctx.flags.servedEncoding = "markdown";
  return false;
}
