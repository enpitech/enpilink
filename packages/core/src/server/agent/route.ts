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
// The cloaking guardrail + serve decision live in the pure, edge-safe module so
// both the Node serving paths and the edge adapters share ONE source. Re-exported
// here so every existing importer of `./route.js` keeps working unchanged.
import { decideAgentServe } from "./serve-eligibility.js";

export {
  type AgentServeEligibility,
  agentServeEligibility,
  decideAgentServe,
  type ServeDecision,
  type ServeEncoding,
} from "./serve-eligibility.js";

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
