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
  type AgentGetAffordance,
  type AgentSiteInfo,
  type AgentToolInfo,
  represent,
} from "./represent.js";
import { getCurrentRuleset } from "./ruleset/holder.js";
import type { Ruleset } from "./ruleset/types.js";

/**
 * The agent REPRESENTATION router (M3, refined by M3.5).
 *
 * One Express middleware — installed as a TRAILING 404-fallback, AFTER all user
 * content routes and the `/mcp` mount (see `installAgentRoutingFallback` in
 * `server.ts`) — that, only when `agent.serve` is on, RESCUES a request that
 * would otherwise 404 for an eligible AI chat fetcher by serving the
 * self-sufficient {@link represent | representation}. Chat-mode agents make
 * exactly one request and never come back (FINDINGS F-10), so a 404 is the whole
 * conversation lost; answering it with a useful body — the site index + tools,
 * inline — is the recovery.
 *
 * Two properties fall out of the trailing-fallback position, and both are the
 * point of M3.5:
 * - **A real 2xx route responds first, so the fallback never runs for it** — the
 *   agent gets the REAL page content, untouched. (Re-encoding real HTML to
 *   markdown is M6, deferred; passing real HTML through is strictly better than
 *   replacing it.) The representation ONLY ever stands in for a missing page.
 * - **A rescue is recorded HONESTLY as the dead-end it was.** The handler sends a
 *   `200` (a chat agent discards a 404 body) but sets
 *   `res.locals.enpilinkAgentRescuedDeadEnd`, so the capture spine records
 *   `outcome = "dead_end"` + `served = 1` — never `resolved`. The headline
 *   dead-end rate stays truthful, and "of D dead-ends, R were rescued" becomes a
 *   first-class metric.
 *
 * 🚩 THE CLOAKING GUARDRAIL is enforced in {@link decideAgentServe}, and it is the
 * load-bearing constraint of this milestone:
 * - **Crawlers ALWAYS get the normal response — no differentiation, ever.** M2
 *   names Googlebot (and every indexer) `class: "crawler"`; a missing page 404s
 *   for them exactly as it would with no agent layer, even on
 *   `Accept: text/markdown`. Because the rescue only fires for detected assistant
 *   fetchers, never crawlers or humans, there is zero soft-404 / SEO exposure.
 * - **`human-or-browser` ALWAYS gets the normal response** — it is very likely a
 *   real human and there is no passive signal to separate a human from an
 *   on-device agent, so we never gamble a customer's organic search on it.
 * - **Only chat fetchers (and the reserved `agent-mode`/`browser-agent`) are
 *   eligible** for a rescue — plus anyone who EXPLICITLY asks for markdown via
 *   `Accept: text/markdown` (standard content negotiation, and never a crawler).
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

/** The eligibility verdict for one request — WHO may be served, if serving runs. */
export interface AgentServeEligibility {
  /** Whether this client is eligible to be served the agent representation. */
  eligible: boolean;
  /** The encoding to serve when eligible (meaningless when not). */
  encoding: ServeEncoding;
  /** Why — for logging/telemetry and readable pass-through reasons. */
  reason: string;
}

/**
 * The WHOLE cloaking guardrail as a PURE function: given a request's method,
 * path, detection and `Accept`, decide whether this client may be served the
 * agent representation — the crawler/human exemptions, the excluded framework
 * surfaces, the subresource skip, and the eligible-class / explicit-markdown
 * rules, all in one place. It is the SINGLE source of truth shared by both
 * serving paths ({@link decideAgentServe} for the trailing 404-rescue, and the
 * M6 response-transform middleware for SPA-replace / HTML re-encode), so they can
 * never diverge on who is protected.
 *
 * It does NOT consider whether serving is enabled or whether a route exists —
 * those are the caller's concern (a flag read; the structural install position).
 */
export function agentServeEligibility(input: {
  method: string;
  path: string;
  detection: Detection;
  accept: string;
}): AgentServeEligibility {
  const no = (reason: string): AgentServeEligibility => ({
    eligible: false,
    encoding: "markdown",
    reason,
  });
  // Representations replace page navigations only; every other method (POST form
  // submits, API writes, …) is left entirely alone.
  if (input.method !== "GET") {
    return no("non-get");
  }
  if (isExcludedPath(input.path)) {
    return no("excluded-path");
  }
  if (looksLikeSubresource(input.path)) {
    return no("subresource");
  }
  // 🚩 GUARDRAIL: crawlers (incl. Googlebot / every search indexer) ALWAYS get
  // the normal response. No differentiation, ever — not even on an explicit
  // markdown Accept. Torching organic search to optimise the agentic slice is a
  // catastrophic trade.
  if (input.detection.class === "crawler") {
    return no("crawler");
  }

  const wantsMarkdown = acceptWantsMarkdown(input.accept);
  const eligibleClass = ELIGIBLE_CLASSES.has(input.detection.class);
  // Eligible when the client EITHER is a recognised one-shot agent (serve
  // proactively — it never sends `Accept: text/markdown`) OR explicitly asked for
  // markdown (content negotiation, any non-crawler). Everything else —
  // `human-or-browser`, plain `tool`/`cli` with no markdown ask, `unknown` — gets
  // the normal response.
  if (!eligibleClass && !wantsMarkdown) {
    return no("ineligible");
  }

  let encoding: ServeEncoding = "markdown";
  if (!wantsMarkdown && acceptStrictlyHtml(input.accept)) {
    encoding = "html";
  }
  return { eligible: true, encoding, reason: "eligible" };
}

/**
 * Decide what to do with one request — the trailing 404-rescue verdict. Returns
 * `pass` (serve the normal response / real 404, untouched) or `serve` with the
 * negotiated encoding. Thin wrapper over {@link agentServeEligibility} plus the
 * `agent.serve` flag.
 *
 * This decides ELIGIBILITY only. The "is this actually a would-be-404" gate is
 * STRUCTURAL, not encoded here: the middleware is installed as a trailing
 * fallback, so it only ever runs when no route matched. A `serve` verdict
 * therefore always applies to a request that was about to 404.
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
  const elig = agentServeEligibility(input);
  if (!elig.eligible) {
    return { action: "pass", reason: elig.reason };
  }
  return { action: "serve", encoding: elig.encoding };
}

/** Options for {@link installAgentRouting}. */
export interface InstallAgentRoutingOptions {
  /** The declared tool index for the representation (read live at request time). */
  getTools: () => AgentToolInfo[];
  /** The owner-declared site summary (from `describeForAgents` / config). */
  getSiteInfo: () => AgentSiteInfo;
  /** Fallback title when the site declares none (the MCP server name). */
  getServerName: () => string;
  /**
   * The GET-exposed tools projected as affordances (M7), for the standard-signal
   * declaration in the representation. Only included when `agent.getTransport` is
   * on. Optional — defaults to none.
   */
  getGetAffordances?: () => AgentGetAffordance[];
  /** Live gate reader. Defaults to {@link getAgentCaptureGate}. */
  getGate?: () => AgentCaptureGate;
  /**
   * Read the current detection ruleset for the serve decision. Defaults to
   * {@link getCurrentRuleset}. When it returns `null` (no ruleset loaded), the
   * request classifies as `pending`/unknown, so no chat-fetcher is identified and
   * NOTHING is served — the correct no-baseline behaviour (a would-be-404 stays a
   * 404 until a ruleset loads). Ignored when {@link classifyRequest} is supplied.
   */
  getRuleset?: () => Ruleset | null;
  /** Classifier. Injectable for tests. Defaults to {@link classify} over the
   * loaded ruleset (via {@link getRuleset}). */
  classifyRequest?: (pairs: readonly HeaderPair[]) => Detection;
}

/**
 * Merge the config-resolved site summary (from the gate — env > file > db) with
 * the code-declared one (from `describeForAgents`). Config wins per field when it
 * is non-empty; otherwise the code declaration stands. `facts` are code-only
 * (an array does not fit a scalar config value). The server name is the final
 * title fallback and is handled by the generator.
 */
export function resolveSiteInfo(
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
 * Install the agent representation router on an Express app as a TRAILING
 * 404-rescue fallback. It registers exactly one middleware; install it AFTER all
 * user routes and the `/mcp` mount, so it runs ONLY when nothing matched — i.e.
 * for a request that would otherwise 404. On a rescue it sends `200` + the
 * representation and marks `res.locals.enpilinkAgentRescuedDeadEnd` so the capture
 * spine records the dead-end honestly.
 */
export function installAgentRouting(
  app: Express,
  opts: InstallAgentRoutingOptions,
): void {
  const readGate = opts.getGate ?? getAgentCaptureGate;
  const getRuleset = opts.getRuleset ?? getCurrentRuleset;
  const classifyRequest =
    opts.classifyRequest ?? ((pairs) => classify(getRuleset(), pairs));

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
      // Advertise the GET affordances only when the transport is actually on, so
      // the representation never names an endpoint that would 404.
      const affordances =
        gate.getTransport === true ? (opts.getGetAffordances?.() ?? []) : [];
      const doc = represent({
        serverName: opts.getServerName(),
        site,
        tools: opts.getTools(),
        affordances,
        path: req.path,
      });

      // M4 hook: mark that we served a representation for THIS request, so the
      // capture path (which records on `res.finish`) can attribute the outcome to
      // the serving layer. Because this is a trailing 404-fallback, reaching here
      // means the request was a would-be-404, so ALSO flag it as a rescued
      // dead-end: the capture spine forces `outcome = "dead_end"` (the pre-rescue
      // truth) even though we send a 200. `served` + `dead_end` is the rescued
      // segment M4 counts as `rescuedDeadEnds`.
      res.locals.enpilinkAgentServed = true;
      res.locals.enpilinkAgentRescuedDeadEnd = true;
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
