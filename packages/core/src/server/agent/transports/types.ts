import type {
  AnySchema,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolParam } from "../represent.js";

/**
 * The GET transport (M7) — one tool definition → a plain, handshake-free
 * `GET /agent/<path>?<params>` that returns the tool's result as markdown
 * (default) or JSON. It is the ONLY transport reachable by the agent classes that
 * cannot speak a protocol (one-shot fetchers, coding CLIs); MCP and WebMCP need a
 * client, GET needs only the one thing every agent can do — fetch a URL.
 *
 * ⚠️ HONEST FRAMING (FINDINGS F-10). The probe proved the majority of agent
 * traffic is CHAT-MODE and one-shot: it makes exactly one request and never acts
 * on any affordance, so it can NEVER reach this endpoint. The GET transport is for
 * the smaller, growing MULTI-FETCH / agent-mode minority (Comet, coding CLIs,
 * work-mode harnesses) — and we have NOT yet observed any specific agent actually
 * calling a standard affordance. This ships OFF by default (`agent.getTransport`)
 * and adds ZERO surface to an app that does not enable it. The endpoint is the
 * easy part; getting an agent to call it is unproven (NLWeb's epitaph).
 *
 * 🔒 SAFETY. GET is SAFE + IDEMPOTENT by construction: a tool is exposable ONLY
 * if it is read-only, non-destructive, and public (no auth) — enforced at
 * REGISTRATION, not at request time (see {@link ./safety.ts}). A mutating or
 * authed tool cannot acquire a GET projection; the server refuses to start.
 */

/** Per-tool GET transport declaration, set under `ToolConfig.transports.get`. */
export interface GetTransport {
  /**
   * Path segment under the agent surface prefix. `"search"` →
   * `GET /agent/search`. A leading/trailing slash is trimmed; it must be
   * non-empty and must not contain `?`, `#` or `..`.
   */
  path: string;
  /**
   * MUST be the literal `true`. A written, physical assertion by the author that
   * this tool is safe, idempotent and public. Belt-and-braces on top of the
   * annotation/security checks — you cannot opt a tool into GET without typing it.
   */
  safe: true;
  /**
   * Token-bucket override for this tool. Defaults come from
   * `agent.getRateLimit` / `agent.getRateBurst`.
   */
  rateLimit?: { rpm: number; burst?: number };
  /**
   * Render the tool's `structuredContent` to a markdown string. When omitted, the
   * transport joins the result's text `content` blocks (or pretty-prints the
   * structured content) — see {@link ../transports/render.ts}.
   */
  render?: (structuredContent: unknown) => string;
  /** `Cache-Control` max-age (seconds) for the response. Default 300. */
  maxAge?: number;
  /**
   * Override the free-text search parameter used when DECLARING this tool as a
   * search affordance (JSON-LD `SearchAction` / OpenSearch). When omitted it is
   * inferred from the input schema (a `q`/`query`/… string param). Set `null` to
   * declare the tool as a non-search endpoint even if it looks search-shaped.
   */
  queryParam?: string | null;
}

/**
 * Which agent transports a tool is projected onto. Extends `ToolConfig`. Only the
 * GET transport is implemented in M7; `webmcp` is reserved for a later milestone
 * and `mcp` is always on (the tool is always a normal MCP tool).
 */
export interface ToolTransports {
  /** MCP JSON-RPC. Always on (a registered tool is always an MCP tool). */
  mcp?: boolean;
  /** WebMCP in-page registration. Reserved — not implemented in M7. */
  webmcp?: boolean | { exposedTo?: string[] };
  /** Plain GET. OFF unless declared. Explicit, safety-gated opt-in only. */
  get?: GetTransport;
}

/** The result shape the GET executor returns (a subset of a tool's return). */
export interface GetToolResult {
  /** Normalised text/content blocks. */
  content?: ContentBlock[];
  /** The tool's structured output, if any. */
  structuredContent?: unknown;
  /** Whether the tool reported a business-level error. */
  isError?: boolean;
}

/**
 * A registered, safety-gated GET-exposed tool — everything the router needs to
 * run one from a query string. Built at registration time in `server.ts` (which
 * owns the SDK handler + types) and read live by the router. The `execute` closure
 * wraps the tool's own handler with a synthesised, no-op MCP `extra`, so the
 * router stays free of any SDK-handler knowledge.
 */
export interface GetExposedTool {
  /** The tool name (its MCP identity). */
  name: string;
  /** Normalised path segment (no leading/trailing slash). `"search"`. */
  path: string;
  /** The tool's description, for the affordance declaration + usage bodies. */
  description?: string;
  /** The declared input schema, for query coercion. */
  inputSchema?: ZodRawShapeCompat | AnySchema;
  /** The derived declared parameters (name/required/type). */
  params: AgentToolParam[];
  /** Run the tool from coerced args. Rejects only on an unexpected throw. */
  execute: (args: Record<string, unknown>) => Promise<GetToolResult>;
  /** Optional structured-content → markdown renderer. */
  render?: (structuredContent: unknown) => string;
  /** Optional per-tool rate-limit override. */
  rateLimit?: { rpm: number; burst?: number };
  /** `Cache-Control` max-age (seconds). Default 300. */
  maxAge?: number;
  /** The free-text search param name if search-shaped, else `null`. */
  queryParam: string | null;
}

/** The agent surface prefix the GET transport (and its declarations) mount under. */
export const AGENT_GET_PREFIX = "/agent";
