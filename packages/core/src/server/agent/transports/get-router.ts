import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { type AgentCaptureGate, getAgentCaptureGate } from "../capture-gate.js";
import { toAffordance } from "./affordance.js";
import { coerceQuery } from "./coerce.js";
import { openSearchXml } from "./opensearch.js";
import { type RateLimitConfig, TokenBucketLimiter } from "./rate-limit.js";
import {
  badRequestMarkdown,
  rateLimitMarkdown,
  renderGetResult,
} from "./render.js";
import {
  AGENT_GET_PREFIX,
  type GetExposedTool,
  type GetToolResult,
} from "./types.js";

/**
 * The GET transport router (M7) — mounts a plain, handshake-free
 * `GET /agent/<path>?<params>` for each safety-gated GET-exposed tool, plus the
 * `GET /agent/opensearch.xml` description document. Installed EARLY (in the
 * McpServer constructor) so it owns the `/agent` namespace ahead of user routes.
 *
 * A cheap no-op until `agent.getTransport` is on AND the path is under the agent
 * prefix AND it names a registered GET tool — otherwise it calls `next()` and the
 * request continues untouched. It never touches a mutating tool: only tools that
 * passed the registration-time safety gate ({@link ./safety.ts}) are ever here.
 *
 * ⚠️ Unproven-in-use (FINDINGS F-10): chat-mode agents — the majority — never make
 * a second request and so can never reach this. It serves the multi-fetch /
 * agent-mode minority, and no specific agent has yet been observed calling it.
 */

/** Options for {@link installAgentGetTransport}. */
export interface InstallAgentGetTransportOptions {
  /** The registered, safety-gated GET-exposed tools (read live). */
  getExposedTools: () => GetExposedTool[];
  /** Live gate reader. Defaults to {@link getAgentCaptureGate}. */
  getGate?: () => AgentCaptureGate;
}

/** Resolve a tool's bucket size from its override or the gate defaults. */
function resolveRateLimit(
  tool: GetExposedTool,
  gate: AgentCaptureGate,
): RateLimitConfig {
  return {
    rpm: tool.rateLimit?.rpm ?? gate.getRateLimit ?? 60,
    burst: tool.rateLimit?.burst ?? gate.getRateBurst ?? 10,
  };
}

/** Whether the client explicitly wants JSON over markdown. */
function wantsJson(accept: string): boolean {
  return /application\/json/i.test(accept) && !/text\/markdown/i.test(accept);
}

/**
 * Install the GET transport on an Express app. Registers exactly one middleware;
 * install it EARLY (the McpServer constructor does). Holds one per-app
 * token-bucket limiter.
 */
export function installAgentGetTransport(
  app: Express,
  opts: InstallAgentGetTransportOptions,
): void {
  const readGate = opts.getGate ?? getAgentCaptureGate;
  const limiter = new TokenBucketLimiter();

  const middleware: RequestHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const gate = readGate();
      // Cheapest possible early-out: transport off (the default) → do nothing.
      if (gate.getTransport !== true) {
        next();
        return;
      }
      if (
        req.method !== "GET" ||
        !req.path.startsWith(`${AGENT_GET_PREFIX}/`)
      ) {
        next();
        return;
      }

      const tools = opts.getExposedTools();

      // The OpenSearch description document, built from the first search-shaped
      // GET tool. A standard signal — not prose.
      if (req.path === `${AGENT_GET_PREFIX}/opensearch.xml`) {
        const searchTool = tools.find((t) => t.queryParam !== null);
        const xml = searchTool
          ? openSearchXml(toAffordance(searchTool), {
              baseUrl: `${req.protocol}://${req.get("host") ?? ""}`,
            })
          : null;
        if (!xml) {
          next();
          return;
        }
        res.setHeader(
          "Content-Type",
          "application/opensearchdescription+xml; charset=utf-8",
        );
        res.setHeader("Cache-Control", "public, max-age=300");
        res.status(200).send(xml);
        return;
      }

      const segment = req.path.slice(AGENT_GET_PREFIX.length + 1);
      const tool = tools.find((t) => t.path === segment);
      if (!tool) {
        next();
        return;
      }

      const urlPath = `${AGENT_GET_PREFIX}/${tool.path}`;

      // 🔒 Rate limit — the only real cost of this unauthenticated surface.
      const ip = req.ip ?? "unknown";
      const verdict = limiter.check(
        `${ip}:${tool.path}`,
        resolveRateLimit(tool, gate),
      );
      if (!verdict.allowed) {
        res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.status(429).send(
          rateLimitMarkdown({
            urlPath,
            retryAfterSeconds: verdict.retryAfterSeconds,
          }),
        );
        return;
      }

      // Query → args. A failure teaches the correct call in a 400.
      const coerced = coerceQuery(
        tool.inputSchema,
        tool.params,
        req.query as Record<string, unknown>,
      );
      if (!coerced.ok) {
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.status(400).send(
          badRequestMarkdown({
            urlPath,
            params: tool.params,
            detail: coerced.message,
          }),
        );
        return;
      }

      let result: GetToolResult;
      try {
        result = await tool.execute(coerced.args);
      } catch {
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.status(500).send("# Error\n\nThe tool failed to run.\n");
        return;
      }

      const accept =
        typeof req.headers.accept === "string" ? req.headers.accept : "";
      const maxAge = tool.maxAge ?? 300;
      res.setHeader("Vary", "Accept");
      res.setHeader(
        "Cache-Control",
        `public, max-age=${maxAge}, stale-while-revalidate=86400`,
      );
      if (wantsJson(accept)) {
        res.status(200).json(result.structuredContent ?? null);
        return;
      }
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.status(200).send(renderGetResult(result, tool.render));
    } catch {
      // The transport must NEVER break the app. Any failure → pass through.
      if (!res.headersSent) {
        next();
      }
    }
  };

  app.use(middleware);
}
