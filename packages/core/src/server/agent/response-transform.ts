import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import type { HeaderPair } from "../storage/types.js";
import { pairRawHeaders } from "./capture.js";
import { type AgentCaptureGate, getAgentCaptureGate } from "./capture-gate.js";
import { classify, type Detection } from "./detect.js";
import { safeHtmlToMarkdown } from "./html-to-markdown.js";
import {
  type AgentGetAffordance,
  type AgentSiteInfo,
  type AgentToolInfo,
  represent,
} from "./represent.js";
import {
  agentServeEligibility,
  resolveSiteInfo,
  type ServeEncoding,
} from "./route.js";

/**
 * The agent RESPONSE-TRANSFORM middleware (M6).
 *
 * Where the M3.5 router is a trailing 404-rescue (it only fires when NO route
 * matched), this middleware acts on a REAL 2xx `text/html` response — so it must
 * be installed EARLY (before user routes) to wrap `res.write`/`res.end` and buffer
 * the body. It powers the two opt-in M6 behaviours, both OFF by default and both
 * behind the SAME cloaking guardrail as the router (only detected assistant
 * fetchers are ever touched; crawlers/humans/subresources always get the byte-
 * identical original):
 *
 * 1. **SPA support** (`agent.spa`). A client-rendered app serves the same empty
 *    shell (`<div id="app">`) with a 200 on every route, so the 404-rescue never
 *    fires and a one-shot chat agent (which runs no JS — FINDINGS F-1) sees
 *    nothing. When on, an eligible fetcher's 2xx HTML shell is REPLACED with the
 *    declared-source {@link represent | representation} (the only real content an
 *    SPA has). This replaces a 200, which is exactly why it is strictly OPT-IN:
 *    the developer is asserting "my pages are client-rendered." Crawlers and
 *    humans still get the shell untouched.
 *
 * 2. **HTML → markdown re-encoding** (`agent.reencode`). When on, an eligible
 *    fetcher's 2xx HTML response is re-encoded to markdown — the app's OWN
 *    content, SAME facts, ~80% fewer tokens. This is guardrail-clean by
 *    construction (a change of encoding, never of claims). A failed/empty
 *    conversion falls back to the original HTML untouched.
 *
 * SPA-replace takes precedence over re-encode (an empty shell is not worth
 * re-encoding). Neither ever touches a non-2xx response, a non-HTML content type,
 * or a `Content-Encoding`-compressed body — those pass through verbatim. The
 * middleware is a cheap no-op (a single gate read, no wrapping) unless a flag is
 * on AND the client is eligible, so normal traffic pays nothing.
 */

/** Options for {@link installAgentResponseTransform}. Mirrors the router's. */
export interface InstallAgentResponseTransformOptions {
  /** The declared tool index for the representation (read live at request time). */
  getTools: () => AgentToolInfo[];
  /** The owner-declared site summary (from `describeForAgents` / config). */
  getSiteInfo: () => AgentSiteInfo;
  /** Fallback title when the site declares none (the MCP server name). */
  getServerName: () => string;
  /**
   * The GET-exposed tools projected as affordances (M7), for the standard-signal
   * declaration in the SPA-replace representation. Only included when
   * `agent.getTransport` is on. Optional — defaults to none.
   */
  getGetAffordances?: () => AgentGetAffordance[];
  /** Live gate reader. Defaults to {@link getAgentCaptureGate}. */
  getGate?: () => AgentCaptureGate;
  /** Classifier. Injectable for tests. Defaults to {@link classify}. */
  classifyRequest?: (pairs: readonly HeaderPair[]) => Detection;
}

/**
 * Cap on how much of a response we will buffer to transform. A body larger than
 * this aborts buffering and streams the original through untouched — a page big
 * enough to exceed this is not a chat-agent target, and buffering it would be a
 * memory risk. 2 MiB comfortably covers any real HTML page.
 */
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

/** Whether a `Content-Type` names an HTML document. */
function isHtmlContentType(ct: string): boolean {
  return /text\/html|application\/xhtml\+xml/i.test(ct);
}

/** Whether the response is (un-)encoded — we only transform identity bodies. */
function isIdentityEncoding(enc: string): boolean {
  return enc === "" || /^identity$/i.test(enc.trim());
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
 * Install the M6 response-transform middleware. Registers exactly one middleware;
 * install it EARLY (before user routes) so it can wrap the response stream. A
 * no-op while both `agent.spa` and `agent.reencode` are off (the default).
 */
export function installAgentResponseTransform(
  app: Express,
  opts: InstallAgentResponseTransformOptions,
): void {
  const readGate = opts.getGate ?? getAgentCaptureGate;
  const classifyRequest = opts.classifyRequest ?? classify;

  const middleware: RequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const gate = readGate();
      // Cheapest early-out: neither feature on (the default) → never wrap.
      if (gate.spa !== true && gate.reencode !== true) {
        next();
        return;
      }

      const accept =
        typeof req.headers.accept === "string" ? req.headers.accept : "";
      const pairs = pairRawHeaders(req.rawHeaders);
      const detection = classifyRequest(pairs);
      const elig = agentServeEligibility({
        method: req.method,
        path: req.path,
        detection,
        accept,
      });
      // 🚩 GUARDRAIL: not an eligible assistant fetcher (crawler, human, a
      // subresource, an excluded surface, …) → never wrap, byte-identical output.
      if (!elig.eligible) {
        next();
        return;
      }

      wrapResponse(res, {
        gate,
        detection,
        encoding: elig.encoding,
        getRepresentation: (path: string) => {
          const site = resolveSiteInfo(gate, opts.getSiteInfo());
          const affordances =
            gate.getTransport === true
              ? (opts.getGetAffordances?.() ?? [])
              : [];
          return represent({
            serverName: opts.getServerName(),
            site,
            tools: opts.getTools(),
            affordances,
            path,
          });
        },
        path: req.path,
      });
      next();
    } catch {
      // Wrapping must NEVER break a response. Any failure → the normal response.
      next();
    }
  };

  app.use(middleware);
}

interface WrapContext {
  gate: AgentCaptureGate;
  detection: Detection;
  encoding: ServeEncoding;
  getRepresentation: (path: string) => { markdown: string; html: string };
  path: string;
}

/**
 * Wrap `res.write`/`res.end` to buffer the body, then — only for a 2xx,
 * identity-encoded HTML response — either replace it with the representation
 * (`agent.spa`) or re-encode it to markdown (`agent.reencode`). Everything else
 * is streamed through untouched. Buffering is aborted (and the original streamed)
 * once {@link MAX_BUFFER_BYTES} is exceeded.
 */
function wrapResponse(res: Response, ctx: WrapContext): void {
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

  /** Split a `(chunk, encoding?, cb?)` arg list into its parts. */
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

  /** Stop buffering: flush what we have and let the rest stream normally. */
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
    // Restore the originals before finishing so nothing re-enters our wrappers.
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
      const status = res.statusCode;
      const ct = String(res.getHeader("content-type") ?? "");
      const ce = String(res.getHeader("content-encoding") ?? "");
      const transformable =
        status >= 200 &&
        status < 300 &&
        !res.headersSent &&
        isHtmlContentType(ct) &&
        isIdentityEncoding(ce);

      if (!transformable) {
        return finishOriginal(body);
      }

      // Replace the body: drop the stale length/validator, and forbid a shared
      // cache from ever handing this agent-only variant to a human or crawler.
      const serve = (out: string, contentType: string): Response => {
        res.removeHeader("Content-Length");
        res.removeHeader("ETag");
        res.setHeader("Content-Type", contentType);
        res.setHeader("Vary", "Accept, User-Agent");
        res.setHeader("Cache-Control", "private, no-store");
        res.locals.enpilinkAgentDetection = ctx.detection;
        return finishOriginal(Buffer.from(out, "utf8"));
      };

      if (ctx.gate.spa === true) {
        const doc = ctx.getRepresentation(ctx.path);
        const out = ctx.encoding === "html" ? doc.html : doc.markdown;
        res.locals.enpilinkAgentServed = true;
        res.locals.enpilinkAgentEncoding = ctx.encoding;
        res.locals.enpilinkAgentSpa = true;
        return serve(
          out,
          ctx.encoding === "html"
            ? "text/html; charset=utf-8"
            : "text/markdown; charset=utf-8",
        );
      }

      // Re-encode the app's OWN html. A poor/empty conversion → original HTML.
      const md = safeHtmlToMarkdown(body.toString("utf8"));
      if (md === null) {
        return finishOriginal(body);
      }
      res.locals.enpilinkAgentReencoded = true;
      res.locals.enpilinkAgentEncoding = "markdown";
      return serve(md, "text/markdown; charset=utf-8");
    } catch {
      // Any failure mid-transform → emit the original bytes, never a broken body.
      return finishOriginal(Buffer.concat(chunks));
    }
  }) as Response["end"];
}
