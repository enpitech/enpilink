import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getActiveStorage } from "../../log-sink.js";
import type { StorageAdapter } from "../../storage/types.js";
import {
  type CaptureOutcome,
  type MinimalRequest,
  pairRawHeaders,
} from "../capture.js";
import { type AgentCaptureGate, getAgentCaptureGate } from "../capture-gate.js";
import { classify } from "../detect.js";
import { safeHtmlToMarkdown } from "../html-to-markdown.js";
import type { IpRangeVerifier } from "../ip-ranges.js";
import type {
  AgentGetAffordance,
  AgentSiteInfo,
  AgentToolInfo,
} from "../represent.js";
import { agentServeEligibility, type ServeEncoding } from "../route.js";
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
 * `enpilink/express` — the standalone Express agent adapter.
 *
 * ONE line — `app.use(agentCapture())` — turns any Express app (and any
 * Express-based framework: NestJS, a custom server) into an agent-analytics
 * surface, with NO `McpServer`, NO `ENPILINK_ANALYTICS`, and NO manual storage
 * wiring. On first use it activates the configured StorageAdapter (default sqlite),
 * flips capture ON, and starts the D2 ruleset client in the background (see
 * {@link ensureAgentAdapterInstalled}). Thereafter every request is captured +
 * classified, and — when you opt into serving — an eligible AI chat fetcher's
 * would-be-404 is answered with the self-sufficient representation.
 *
 * It is a thin skin over the shared `adapter/core.ts`:
 * - capture reuses {@link AgentCaptureRecorder} (the same pipeline the McpServer
 *   spine uses),
 * - the serve/transform decision reuses {@link agentServeEligibility} +
 *   {@link decideServeAction} (the cloaking guardrail stays single-source in
 *   `route.ts`) — so crawlers/Googlebot, humans, subresources and framework
 *   surfaces ALWAYS get the untouched real response, exactly as on the McpServer.
 *
 * Unlike the McpServer, this is a SINGLE middleware doing both jobs, so serving is
 * an early response-wrap (it buffers `res.write`/`res.end` and rewrites at `end`)
 * rather than a trailing 404-fallback. Both jobs are cheap no-ops for normal
 * traffic: capture is a synchronous gate read + a fire-and-forget write after the
 * response; serving only wraps the response for a DETECTED, eligible fetcher.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { agentCapture } from "enpilink/express";
 *
 * const app = express();
 * app.use(agentCapture());          // capture-only, out of the box
 * // app.use(agentCapture({ serve: true, siteTitle: "Northwind" })); // + rescue 404s
 * ```
 */

/** Options for {@link agentCapture} (Express). */
export interface ExpressAgentCaptureOptions {
  /**
   * Capture agent requests. Defaults to **ON** — installing the middleware is the
   * opt-in. An explicit `false` (or an `ENPILINK_AGENT` env pin) disables it.
   */
  enabled?: boolean;
  /** Sampling fraction `[0,1]`. Defaults to the resolved config (1). */
  sampleRate?: number;
  /**
   * Serve the representation to an eligible chat fetcher on a would-be-404
   * (the standalone 404-rescue). OFF by default.
   */
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

  // ── Test seams (defaults are the process-wide singletons) ──
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
  /**
   * Skip the one-time process bootstrap (storage activation + gate overlay +
   * ruleset client). Tests that wire storage/gate themselves set this so the
   * adapter doesn't fight them. Defaults to `false`.
   */
  skipInstall?: boolean;
}

/**
 * A process-wide recorder so `agentCapture()` called more than once (unusual, but
 * possible) shares ONE write buffer rather than double-capturing. Keyed by nothing:
 * the first call's storage/ruleset seams win. Reset via {@link __resetExpressAdapter}.
 */
let sharedRecorder: AgentCaptureRecorder | null = null;

function getSharedRecorder(
  opts: ExpressAgentCaptureOptions,
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
export function __resetExpressAdapter(): void {
  sharedRecorder = null;
}

/** TEST-ONLY: flush the shared recorder's write buffer. */
export function __flushExpressAdapter(): Promise<void> {
  return sharedRecorder ? sharedRecorder.stop() : Promise.resolve();
}

/** Resolve the real client IP (same rules as the McpServer spine). */
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
 * The Express agent-capture middleware. Returns a single `RequestHandler` you mount
 * ONCE, ahead of your routes: `app.use(agentCapture())`.
 */
export function agentCapture(
  options: ExpressAgentCaptureOptions = {},
): RequestHandler {
  const rng = options.rng ?? Math.random;
  const now = options.now ?? Date.now;
  const readGate = options.getGate ?? getAgentCaptureGate;
  const getRuleset = options.getRuleset ?? getCurrentRuleset;

  // Kick the one-time bootstrap (storage + gate + ruleset client). Fire-and-forget:
  // the gate stays OFF until it resolves, so any request in that first tick is a
  // clean no-op — never an error, never a blocked response.
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

  return (req: Request, res: Response, next: NextFunction) => {
    const gate = readGate();

    // ── SERVE / TRANSFORM (independent of capture + its sampling) ──
    // Only when a serving feature is on AND this client is an eligible fetcher do
    // we wrap the response. Crawlers/humans/subresources/excluded surfaces fall
    // straight through — the guardrail (agentServeEligibility) decides, once.
    if (gate.serve === true || gate.spa === true || gate.reencode === true) {
      try {
        const rawHeaders = pairRawHeaders(req.rawHeaders);
        const accept =
          typeof req.headers.accept === "string" ? req.headers.accept : "";
        const detection = classify(getRuleset(), rawHeaders);
        const elig = agentServeEligibility({
          method: req.method,
          path: req.path,
          detection,
          accept,
        });
        if (elig.eligible) {
          wrapExpressServe(res, {
            gate,
            encoding: elig.encoding,
            sources,
            path: req.path,
          });
        }
      } catch {
        // Serving must NEVER break a response — fall through untouched.
      }
    }

    // ── CAPTURE (sampled) ──
    if (gate.enabled) {
      const { sampleRate } = gate;
      const sampled = sampleRate >= 1 || (sampleRate > 0 && rng() < sampleRate);
      if (sampled) {
        const start = now();
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
          const rescuedDeadEnd =
            res.locals.enpilinkAgentRescuedDeadEnd === true;
          const outcome: CaptureOutcome = {
            status: res.statusCode,
            ts: start,
            ms: now() - start,
            ...(rescuedDeadEnd ? { rescuedDeadEnd: true } : {}),
          };
          recorder.record(minimal, ip, outcome, flagsFromLocals(res));
        };
        res.on("finish", record);
        res.on("close", record);
      }
    }

    next();
  };
}

/** Lift the serve-layer flags this request set into a neutral {@link AgentRecordFlags}. */
function flagsFromLocals(res: Response): AgentRecordFlags {
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
  return flags;
}

/** Cap on buffered response bytes; past it we stream the original untouched. */
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

interface WrapContext {
  gate: AgentCaptureGate;
  encoding: ServeEncoding;
  sources: RepresentationSources;
  path: string;
}

/** Coerce a `write`/`end` chunk argument to a Buffer. */
function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk, encoding ?? "utf8");
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.alloc(0);
}

/**
 * Wrap an ELIGIBLE fetcher's response so we can rewrite it at `end`: buffer
 * `res.write`/`res.end`, then apply {@link decideServeAction} — RESCUE a would-be
 * 404/410 with the representation (`serve`), REPLACE a 2xx SPA shell (`spa`),
 * RE-ENCODE a 2xx HTML body to markdown (`reencode`), or pass the original bytes
 * through. Sets the `res.locals.enpilinkAgent*` flags the capture path records.
 * Any failure mid-transform emits the original bytes — serving never breaks a
 * response.
 */
function wrapExpressServe(res: Response, ctx: WrapContext): void {
  type WriteArgs = [
    chunk?: unknown,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void,
  ];

  const originalWrite = res.write.bind(res) as (...args: WriteArgs) => boolean;
  const originalEnd = res.end.bind(res) as (...args: WriteArgs) => Response;

  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;

  const parseArgs = (
    args: WriteArgs,
  ): {
    chunk: unknown;
    enc: BufferEncoding | undefined;
    cb: ((error?: Error | null) => void) | undefined;
  } => {
    const [chunk, encOrCb, maybeCb] = args;
    if (typeof encOrCb === "function") {
      return { chunk, enc: undefined, cb: encOrCb };
    }
    return { chunk, enc: encOrCb, cb: maybeCb };
  };

  const abort = (): void => {
    aborted = true;
    res.write = originalWrite;
    res.end = originalEnd;
    for (const b of chunks) {
      originalWrite(b);
    }
    chunks.length = 0;
  };

  res.write = ((...args: WriteArgs): boolean => {
    if (aborted) {
      return originalWrite(...args);
    }
    const { chunk, enc, cb } = parseArgs(args);
    if (chunk !== undefined && chunk !== null) {
      const buf = toBuffer(chunk, enc);
      size += buf.length;
      chunks.push(buf);
      if (size > MAX_BUFFER_BYTES) {
        abort();
      }
    }
    if (cb) {
      cb();
    }
    return true;
  }) as Response["write"];

  res.end = ((...args: WriteArgs): Response => {
    if (aborted) {
      return originalEnd(...args);
    }
    const { chunk, enc, cb } = parseArgs(args);
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
      chunks.push(toBuffer(chunk, enc));
    }
    // Restore originals before finishing so nothing re-enters our wrappers.
    res.write = originalWrite;
    res.end = originalEnd;

    const finishOriginal = (body: Buffer): Response => {
      const r = originalEnd(body);
      if (cb) {
        cb();
      }
      return r;
    };

    try {
      const body = Buffer.concat(chunks);
      if (res.headersSent) {
        return finishOriginal(body);
      }
      const action = decideServeAction({
        gate: ctx.gate,
        status: res.statusCode,
        contentType: String(res.getHeader("content-type") ?? ""),
        contentEncoding: String(res.getHeader("content-encoding") ?? ""),
        encoding: ctx.encoding,
      });
      if (action.kind === "passthrough") {
        return finishOriginal(body);
      }

      // Replace the body: drop the stale length/validator, and forbid a shared
      // cache from ever handing this agent-only variant to a human or crawler.
      const serve = (out: string, contentType: string): Response => {
        res.removeHeader("Content-Length");
        res.removeHeader("ETag");
        res.setHeader("Content-Type", contentType);
        res.setHeader("Vary", "Accept, User-Agent");
        return finishOriginal(Buffer.from(out, "utf8"));
      };

      if (action.kind === "rescue") {
        // A would-be-404 → serve the representation with a 200, recorded as the
        // dead-end it truly was (rescuedDeadEnd) + served.
        const doc = buildRepresentationDoc(ctx.gate, ctx.sources, ctx.path);
        const out = action.encoding === "html" ? doc.html : doc.markdown;
        res.statusCode = 200;
        res.setHeader(
          "Cache-Control",
          "public, max-age=300, stale-while-revalidate=86400",
        );
        res.locals.enpilinkAgentServed = true;
        res.locals.enpilinkAgentRescuedDeadEnd = true;
        res.locals.enpilinkAgentEncoding = action.encoding;
        return serve(
          out,
          action.encoding === "html"
            ? "text/html; charset=utf-8"
            : "text/markdown; charset=utf-8",
        );
      }

      if (action.kind === "spa") {
        const doc = buildRepresentationDoc(ctx.gate, ctx.sources, ctx.path);
        const out = action.encoding === "html" ? doc.html : doc.markdown;
        res.setHeader("Cache-Control", "private, no-store");
        res.locals.enpilinkAgentServed = true;
        res.locals.enpilinkAgentEncoding = action.encoding;
        res.locals.enpilinkAgentSpa = true;
        return serve(
          out,
          action.encoding === "html"
            ? "text/html; charset=utf-8"
            : "text/markdown; charset=utf-8",
        );
      }

      // reencode: the app's OWN html → markdown. A poor/empty conversion →
      // original HTML untouched.
      const md = safeHtmlToMarkdown(body.toString("utf8"));
      if (md === null) {
        return finishOriginal(body);
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.locals.enpilinkAgentReencoded = true;
      res.locals.enpilinkAgentEncoding = "markdown";
      return serve(md, "text/markdown; charset=utf-8");
    } catch {
      return finishOriginal(Buffer.concat(chunks));
    }
  }) as Response["end"];
}
