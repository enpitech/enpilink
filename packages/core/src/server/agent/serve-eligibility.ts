// TYPE-ONLY (erased): keeps this module free of `detect.ts`'s runtime graph — it
// is a pure predicate over an already-computed Detection.
import type { Detection } from "./detect.js";

/**
 * THE CLOAKING GUARDRAIL + serve decision, as a PURE, edge-safe module (D4b).
 *
 * This is the single source of truth for "who may be served the agent
 * representation, and what to do with their response" — the crawler/human
 * exemptions, the excluded framework surfaces, the subresource skip, and the
 * eligible-class / explicit-markdown rules. It was lifted verbatim out of
 * `route.ts` (which shipped Express + config + `represent.ts` in its runtime
 * graph, so it could never be imported on the edge) so that BOTH the Node serving
 * paths AND the edge adapters (`@enpilink/cloudflare`, Hono-on-edge) share ONE
 * guardrail and can never diverge on who is protected.
 *
 * It imports NOTHING at runtime (only `import type { Detection }`, erased under
 * `verbatimModuleSyntax`), so it carries no `node:*`, no Express, no config, no
 * `represent.ts` — it is edge-bundle-safe, asserted by `next/edge-safety.test.ts`.
 * `route.ts` and `adapter/core.ts` now re-export from here, so every existing
 * importer keeps working unchanged.
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
 * rules, all in one place. It is the SINGLE source of truth shared by every
 * serving path (the trailing 404-rescue, the M6 response-transform, and the edge
 * adapters), so they can never diverge on who is protected.
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

// ── SERVE / TRANSFORM decision (used by the standalone + edge adapters) ─────────

/** The serve/transform feature flags a caller enables — a structural subset of
 * the Node capture gate, so `AgentCaptureGate` satisfies it directly, and the
 * edge adapters pass their own `{ serve, spa, reencode }` options. */
export interface ServeFeatureFlags {
  /** Serve the representation on a would-be dead-end (404/410). */
  serve?: boolean;
  /** Replace a 2xx SPA shell with the representation. */
  spa?: boolean;
  /** Re-encode a 2xx HTML body to markdown. */
  reencode?: boolean;
}

/** What the serve/transform layer should do with an ELIGIBLE client's response. */
export type ServeAction =
  | { kind: "rescue"; encoding: ServeEncoding }
  | { kind: "spa"; encoding: ServeEncoding }
  | { kind: "reencode" }
  | { kind: "passthrough" };

/** Whether a `Content-Type` names an HTML document. */
export function isHtmlContentType(ct: string): boolean {
  return /text\/html|application\/xhtml\+xml/i.test(ct);
}

/** Whether the response is (un-)encoded — we only transform identity bodies. */
export function isIdentityEncoding(enc: string): boolean {
  return enc === "" || /^identity$/i.test(enc.trim());
}

/**
 * Decide what to do with an ELIGIBLE client's response — the neutral branch shared
 * by every standalone AND edge adapter. Callers MUST have already checked
 * {@link agentServeEligibility} (so the cloaking guardrail — crawlers, humans,
 * subresources, excluded surfaces — is enforced ONCE); this only maps the final
 * status + content type + the enabled features onto an action:
 *
 * - `serve` on + a would-be dead-end (404/410) → RESCUE with the representation.
 * - `spa` on + a 2xx identity HTML body → replace the shell with the representation.
 * - `reencode` on + a 2xx identity HTML body → re-encode to markdown.
 * - otherwise pass the original bytes through untouched.
 *
 * SPA-replace takes precedence over re-encode, matching `response-transform.ts`.
 */
export function decideServeAction(input: {
  gate: ServeFeatureFlags;
  status: number;
  contentType: string;
  contentEncoding: string;
  encoding: ServeEncoding;
}): ServeAction {
  if (
    input.gate.serve === true &&
    (input.status === 404 || input.status === 410)
  ) {
    return { kind: "rescue", encoding: input.encoding };
  }
  const is2xxHtml =
    input.status >= 200 &&
    input.status < 300 &&
    isHtmlContentType(input.contentType) &&
    isIdentityEncoding(input.contentEncoding);
  if (is2xxHtml && input.gate.spa === true) {
    return { kind: "spa", encoding: input.encoding };
  }
  if (is2xxHtml && input.gate.reencode === true) {
    return { kind: "reencode" };
  }
  return { kind: "passthrough" };
}
