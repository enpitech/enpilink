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
import {
  type AgentSiteInfo,
  type AgentToolInfo,
  represent,
} from "./represent.js";

/**
 * The agent REPRESENTATION router (M3).
 *
 * One Express middleware, installed ahead of user content routes (in the
 * McpServer constructor, alongside capture), that — only when `agent.serve` is on
 * — recognises an eligible AI chat fetcher and serves it the self-sufficient
 * {@link represent | representation} INSTEAD of the normal page. Chat-mode agents
 * make exactly one request and never come back (FINDINGS F-10), so the first
 * response is the entire product; this is the layer that makes that response
 * self-sufficient.
 *
 * 🚩 THE CLOAKING GUARDRAIL is enforced in {@link decideAgentServe}, and it is the
 * load-bearing constraint of this milestone:
 * - **Crawlers ALWAYS get the normal response — no differentiation, ever.** M2
 *   names Googlebot (and every indexer) `class: "crawler"`; those are routed
 *   straight through, untouched, even if they send `Accept: text/markdown`.
 * - **`human-or-browser` ALWAYS gets the normal response** — it is very likely a
 *   real human and there is no passive signal to separate a human from an
 *   on-device agent, so we never gamble a customer's organic search on it.
 * - **Only chat fetchers (and the reserved `agent-mode`/`browser-agent`) are
 *   eligible** for the representation — plus anyone who EXPLICITLY asks for
 *   markdown via `Accept: text/markdown` (standard content negotiation, and never
 *   a crawler).
 *
 * The whole layer is OFF by default behind `agent.serve`, independent of
 * `agent.enabled` (capture). It follows the same operational discipline as the
 * capture spine: a cheap synchronous gate read, and any error degrades to
 * "pass through untouched" — serving must never break a response.
 */

/** The chosen encoding of a served representation. */
export type ServeEncoding = "markdown" | "html";

/** The routing verdict for one request. */
export type ServeDecision =
  | { action: "pass"; reason: string }
  | { action: "serve"; encoding: ServeEncoding };

/** Behavioural classes eligible for the representation (never `crawler`). */
const ELIGIBLE_CLASSES = new Set([
  "chat-fetcher",
  "agent-mode",
  "browser-agent",
]);

/**
 * Path PREFIXES the router never touches: the MCP endpoint, the admin/console
 * plane, well-known metadata (auth/RFC 9728), static assets, and the OAuth AS
 * endpoints. These are framework/control-plane surfaces, not app content.
 */
const EXCLUDED_PREFIXES = [
  "/mcp",
  "/__enpilink",
  "/.well-known",
  "/assets",
  "/authorize",
  "/token",
  "/register",
  "/callback",
];

/**
 * File extensions that mark a static subresource / data endpoint (NOT a page
 * navigation). A GET for one of these is never replaced with the representation —
 * we must not clobber a stylesheet, an image, `robots.txt`/`sitemap.xml`, or a
 * JSON/XML API response. `.html`/`.htm` are deliberately EXCLUDED from this set
 * (they are pages).
 */
const STATIC_EXTS = new Set([
  "css",
  "js",
  "mjs",
  "cjs",
  "map",
  "json",
  "xml",
  "txt",
  "csv",
  "rss",
  "atom",
  "wasm",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "ico",
  "bmp",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp4",
  "webm",
  "mp3",
  "wav",
  "ogg",
  "pdf",
  "zip",
  "gz",
]);

/** Whether a path is a framework/control-plane surface the router must skip. */
function isExcludedPath(path: string): boolean {
  for (const prefix of EXCLUDED_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

/** Whether a path points at a static subresource / data file rather than a page. */
function looksLikeSubresource(path: string): boolean {
  const seg = path.slice(path.lastIndexOf("/") + 1);
  const dot = seg.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  const ext = seg.slice(dot + 1).toLowerCase();
  if (ext === "html" || ext === "htm") {
    return false;
  }
  return STATIC_EXTS.has(ext);
}

/** Whether the `Accept` header asks for markdown (only Claude Code does today). */
function acceptWantsMarkdown(accept: string): boolean {
  return /text\/markdown/i.test(accept);
}

/**
 * Whether the client STRICTLY wants HTML — it lists `text/html` and offers no
 * wildcard `Accept` fallback. Chat fetchers always carry a wildcard (ChatGPT
 * sends `text/html` then a wildcard; Gemini sends only the wildcard), so they
 * fall through to markdown — the token-efficient encoding the probe prescribes
 * serving them (FINDINGS F-2b).
 */
function acceptStrictlyHtml(accept: string): boolean {
  const hasWildcard = accept.includes("*/*") || accept.trim() === "";
  const hasHtml = /text\/html|application\/xhtml/i.test(accept);
  return hasHtml && !hasWildcard;
}

/**
 * Decide what to do with one request — the whole guardrail, as a PURE function so
 * it is exhaustively testable without Express. Returns `pass` (serve the normal
 * response, untouched) or `serve` with the negotiated encoding.
 */
export function decideAgentServe(input: {
  serve: boolean;
  method: string;
  path: string;
  detection: Detection;
  accept: string;
}): ServeDecision {
  if (!input.serve) {
    return { action: "pass", reason: "serve-disabled" };
  }
  // Representations replace page navigations only; every other method (POST form
  // submits, API writes, …) is left entirely alone.
  if (input.method !== "GET") {
    return { action: "pass", reason: "non-get" };
  }
  if (isExcludedPath(input.path)) {
    return { action: "pass", reason: "excluded-path" };
  }
  if (looksLikeSubresource(input.path)) {
    return { action: "pass", reason: "subresource" };
  }
  // 🚩 GUARDRAIL: crawlers (incl. Googlebot / every search indexer) ALWAYS get
  // the normal response. No differentiation, ever — not even on an explicit
  // markdown Accept. Torching organic search to optimise the agentic slice is a
  // catastrophic trade.
  if (input.detection.class === "crawler") {
    return { action: "pass", reason: "crawler" };
  }

  const wantsMarkdown = acceptWantsMarkdown(input.accept);
  const eligibleClass = ELIGIBLE_CLASSES.has(input.detection.class);
  // Eligible when the client EITHER is a recognised one-shot agent (serve
  // proactively — it never sends `Accept: text/markdown`) OR explicitly asked for
  // markdown (content negotiation, any non-crawler). Everything else —
  // `human-or-browser`, plain `tool`/`cli` with no markdown ask, `unknown` — gets
  // the normal response.
  if (!eligibleClass && !wantsMarkdown) {
    return { action: "pass", reason: "ineligible" };
  }

  let encoding: ServeEncoding = "markdown";
  if (!wantsMarkdown && acceptStrictlyHtml(input.accept)) {
    encoding = "html";
  }
  return { action: "serve", encoding };
}

/** Options for {@link installAgentRouting}. */
export interface InstallAgentRoutingOptions {
  /** The declared tool index for the representation (read live at request time). */
  getTools: () => AgentToolInfo[];
  /** The owner-declared site summary (from `describeForAgents` / config). */
  getSiteInfo: () => AgentSiteInfo;
  /** Fallback title when the site declares none (the MCP server name). */
  getServerName: () => string;
  /** Live gate reader. Defaults to {@link getAgentCaptureGate}. */
  getGate?: () => AgentCaptureGate;
  /** Classifier. Injectable for tests. Defaults to {@link classify}. */
  classifyRequest?: (pairs: readonly HeaderPair[]) => Detection;
}

/**
 * Merge the config-resolved site summary (from the gate — env > file > db) with
 * the code-declared one (from `describeForAgents`). Config wins per field when it
 * is non-empty; otherwise the code declaration stands. `facts` are code-only
 * (an array does not fit a scalar config value). The server name is the final
 * title fallback and is handled by the generator.
 */
function resolveSiteInfo(
  gate: AgentCaptureGate,
  declared: AgentSiteInfo,
): AgentSiteInfo {
  const title = (gate.siteTitle ?? "").trim() || declared.title;
  const description =
    (gate.siteDescription ?? "").trim() || declared.description;
  const site: AgentSiteInfo = {};
  if (title) {
    site.title = title;
  }
  if (description) {
    site.description = description;
  }
  if (declared.facts && declared.facts.length > 0) {
    site.facts = declared.facts;
  }
  return site;
}

/**
 * Install the agent representation router on an Express app. Idempotent per app
 * in the sense that it registers exactly one middleware; install it in the
 * constructor (before user routes) so it can intercept a page navigation and
 * serve the representation in the eligible-agent case.
 */
export function installAgentRouting(
  app: Express,
  opts: InstallAgentRoutingOptions,
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
      // Cheapest possible early-out: serving off (the default) → do nothing.
      if (gate.serve !== true) {
        next();
        return;
      }

      const accept =
        typeof req.headers.accept === "string" ? req.headers.accept : "";
      const pairs = pairRawHeaders(req.rawHeaders);
      const detection = classifyRequest(pairs);
      const decision = decideAgentServe({
        serve: true,
        method: req.method,
        path: req.path,
        detection,
        accept,
      });

      if (decision.action === "pass") {
        next();
        return;
      }

      const site = resolveSiteInfo(gate, opts.getSiteInfo());
      const doc = represent({
        serverName: opts.getServerName(),
        site,
        tools: opts.getTools(),
        path: req.path,
      });

      // M4 hook: mark that M3 served a representation for THIS request, so the
      // capture path (which records on `res.finish`) can attribute the outcome to
      // the serving layer — did the served response actually help the agent, or
      // did it still dead-end / escalate? Telemetry (M4) reads these locals.
      res.locals.enpilinkAgentServed = true;
      res.locals.enpilinkAgentEncoding = decision.encoding;
      res.locals.enpilinkAgentDetection = detection;

      // Adaptive serving varies by UA + Accept; tell shared caches so a human or
      // crawler is never handed a cached agent representation.
      res.setHeader("Vary", "Accept, User-Agent");
      res.setHeader(
        "Cache-Control",
        "public, max-age=300, stale-while-revalidate=86400",
      );
      if (decision.encoding === "markdown") {
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.status(200).send(doc.markdown);
      } else {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.status(200).send(doc.html);
      }
    } catch {
      // Serving must NEVER break a response. Any failure → the normal response.
      if (!res.headersSent) {
        next();
      }
    }
  };

  app.use(middleware);
}
