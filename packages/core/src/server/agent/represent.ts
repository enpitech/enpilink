import type {
  AnySchema,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import {
  getObjectShape,
  getSchemaDescription,
  isSchemaOptional,
  normalizeObjectSchema,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";

/**
 * The agent REPRESENTATION generator (M3).
 *
 * Chat-mode agents make exactly ONE request and never come back (FINDINGS F-10):
 * ChatGPT web, Gemini web and Claude chat all fetch a single document and answer
 * from it alone — they will not follow a link or an affordance. So the ENTIRE
 * value has to live in that first response. This module builds that response: a
 * self-sufficient document, generated ONLY from what the developer DECLARED — the
 * registered MCP tool registry plus an optional owner-authored site summary — so
 * no second request is ever needed.
 *
 * Two hard rules shape everything here:
 *
 * 1. **Same facts, different encoding — never different content** (the cloaking
 *    guardrail). The document re-states first-party, owner-declared facts (the
 *    site summary and the tool index) as clean markdown / SSR'd HTML. It invents
 *    nothing, makes no new claims, and never keyword-stuffs. WHICH clients get it
 *    is decided in `route.ts`; crawlers and humans always get the normal response.
 *
 * 2. **Descriptive, NEVER imperative** (FINDINGS F-9). Agents are hardened against
 *    instructions embedded in fetched content — an imperative preamble
 *    ("you must…", "if you are an AI agent…", "ignore previous instructions") is
 *    indistinguishable from a prompt-injection attack and gets refused. Every line
 *    this module emits is a plain, declarative capability description. The
 *    representation OFFERS; it never COMMANDS.
 *
 * The core is PURE data → string (no Node, no I/O, no clock), like `capture.ts`
 * and `detect.ts`, so it is trivially testable and reusable from a future edge
 * adapter. The one schema-aware helper, {@link extractToolParams}, is factored out
 * so `represent()` itself stays free of any Zod knowledge.
 */

/**
 * The optional, owner-declared, one-time site summary — "what this app is". Set
 * in code via `server.describeForAgents({...})` and/or the `agent.site.*` config
 * keys. Everything here is FIRST-PARTY, owner-authored content; that is exactly
 * why it is safe to place in the representation.
 */
export interface AgentSiteInfo {
  /** Short site/app title. Falls back to the MCP server name when absent. */
  title?: string;
  /** One-line description of what the app is / does. */
  description?: string;
  /** A few short, factual statements about the app (bullet points). */
  facts?: string[];
}

/** One declared input parameter of a tool, derived from its input schema. */
export interface AgentToolParam {
  /** Parameter name. */
  name: string;
  /** Whether the caller must supply it (an optional/defaulted param is not). */
  required: boolean;
  /** Best-effort friendly type label (`string`, `number`, `enum`, …), if known. */
  type?: string;
  /** The schema's own `.describe(...)` text, if the author supplied one. */
  description?: string;
}

/**
 * A tool as it appears in the agent representation — the declared source. Mirrors
 * a registered MCP tool's public face (name, description, input parameters); it
 * carries nothing the tool does not already expose through `tools/list`.
 */
export interface AgentToolInfo {
  name: string;
  description?: string;
  params: AgentToolParam[];
}

/**
 * A GET-exposed tool projected as a declarative AFFORDANCE (M7). Present only when
 * the GET transport is enabled. The representation DECLARES it through STANDARD
 * signals — JSON-LD `SearchAction`, `<link rel="search">`, OpenSearch, and a
 * factual capability list with the GET URL — never prose addressed to an agent
 * (FINDINGS F-9). `urlPath` is the fully-composed path under the agent prefix
 * (e.g. `/agent/search`); `queryParam` names the free-text search param, or is
 * `null` for a non-search endpoint.
 */
export interface AgentGetAffordance {
  urlPath: string;
  name: string;
  description?: string;
  queryParam: string | null;
  params: AgentToolParam[];
}

/** Everything the generator needs. All fields are owner-declared or framework. */
export interface RepresentationInput {
  /** Fallback title when the site declares none (the MCP server name). */
  serverName: string;
  /** The owner-declared site summary (may be empty). */
  site: AgentSiteInfo;
  /** The declared tool index (may be empty). */
  tools: AgentToolInfo[];
  /**
   * The GET-exposed tools projected as declarative affordances (M7). Empty (or
   * omitted) when the GET transport is off — so the representation only ever
   * advertises endpoints that actually exist.
   */
  affordances?: AgentGetAffordance[];
  /**
   * The requested path — context only. It is deliberately NOT interpolated into
   * the body: it is attacker-controlled, so it never reaches the document.
   */
  path: string;
}

/** The generated document, in both encodings. Same facts, different bytes. */
export interface Representation {
  /** Clean markdown — the token-efficient primary encoding. */
  markdown: string;
  /** A minimal, self-contained, server-rendered HTML document of the same facts. */
  html: string;
}

/** One declarative capability line: a GET URL template and what it does. */
interface AffordanceLine {
  /** The call template, e.g. `GET /agent/search?q={query}`. */
  call: string;
  /** What the endpoint does (the tool description), if any. */
  description?: string;
}

/** The internal block model — one source of truth rendered to BOTH encodings. */
type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "affordances"; items: AffordanceLine[] };

/** Collapse whitespace and trim — keep a declared string to a single tidy line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Render a tool's parameters as one declarative line, e.g.
 * `q (string, required), limit (number, optional)`. Empty string when none. */
function paramsLine(params: readonly AgentToolParam[]): string {
  return params
    .map((p) => {
      const bits: string[] = [];
      if (p.type) {
        bits.push(p.type);
      }
      bits.push(p.required ? "required" : "optional");
      return `${p.name} (${bits.join(", ")})`;
    })
    .join(", ");
}

/** The GET call template for an affordance, e.g. `GET /agent/search?q={query}`. */
function affordanceCall(aff: AgentGetAffordance): string {
  if (aff.queryParam) {
    return `GET ${aff.urlPath}?${aff.queryParam}={query}`;
  }
  const required = aff.params.filter((p) => p.required);
  if (required.length === 0) {
    return `GET ${aff.urlPath}`;
  }
  const qs = required.map((p) => `${p.name}={${p.type ?? "value"}}`).join("&");
  return `GET ${aff.urlPath}?${qs}`;
}

/** The schema.org EntryPoint urlTemplate for a non-search GET affordance. */
function nonSearchTemplate(aff: AgentGetAffordance): string {
  const required = aff.params.filter((p) => p.required);
  if (required.length === 0) {
    return aff.urlPath;
  }
  const qs = required.map((p) => `${p.name}={${p.name}}`).join("&");
  return `${aff.urlPath}?${qs}`;
}

/**
 * Build the JSON-LD `WebSite.potentialAction` block declaring the GET affordances
 * as STANDARD schema.org actions: a `SearchAction` for a search-shaped tool, a
 * generic `Action` (with an EntryPoint urlTemplate) for the rest. `<` is escaped
 * to `<` so the JSON can never break out of the `<script>` element.
 */
function buildJsonLd(
  affordances: readonly AgentGetAffordance[],
  title: string,
): string {
  const potentialAction = affordances.map((a) => {
    if (a.queryParam) {
      return {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${a.urlPath}?${a.queryParam}={search_term_string}`,
        },
        "query-input": "required name=search_term_string",
      };
    }
    return {
      "@type": "Action",
      name: a.name,
      target: { "@type": "EntryPoint", urlTemplate: nonSearchTemplate(a) },
    };
  });
  const doc = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: title,
    potentialAction,
  };
  return JSON.stringify(doc, null, 2).replace(/</g, "\\u003c");
}

/**
 * Build the HTML `<head>` signals declaring the GET affordances: `<link
 * rel="search">` (OpenSearch + a direct markdown template) for a search-shaped
 * tool, and the JSON-LD block. HTML-only (a `<link>`/`<script>` has no markdown
 * analogue); the same facts also appear in the body affordance list, so both
 * encodings carry them. Returns "" when there are no affordances.
 */
function buildHeadExtra(
  affordances: readonly AgentGetAffordance[],
  title: string,
): string {
  if (affordances.length === 0) {
    return "";
  }
  const lines: string[] = [];
  const searchAff = affordances.find((a) => a.queryParam !== null);
  if (searchAff?.queryParam) {
    lines.push(
      `<link rel="search" type="application/opensearchdescription+xml" title="${escapeHtml(
        title,
      )}" href="/agent/opensearch.xml">`,
    );
    lines.push(
      `<link rel="search" type="text/markdown" href="${escapeHtml(
        `${searchAff.urlPath}?${searchAff.queryParam}={q}`,
      )}">`,
    );
  }
  lines.push(
    `<script type="application/ld+json">${buildJsonLd(affordances, title)}</script>`,
  );
  return lines.join("\n");
}

/** Append the declarative affordance list to the block model, if any. */
function appendAffordanceBlocks(
  blocks: Block[],
  affordances: readonly AgentGetAffordance[],
): void {
  if (affordances.length === 0) {
    return;
  }
  blocks.push({ kind: "h2", text: "Data endpoints" });
  // Descriptive framing only — this states what the endpoints are, it does not
  // instruct the reader to call them.
  blocks.push({
    kind: "p",
    text: "Each endpoint below answers a plain HTTP GET and returns markdown (or JSON on request).",
  });
  blocks.push({
    kind: "affordances",
    items: affordances.map((a) => {
      const line: AffordanceLine = { call: affordanceCall(a) };
      const desc = oneLine(a.description ?? "");
      if (desc) {
        line.description = desc;
      }
      return line;
    }),
  });
}

/** Build the block model from the declared source. Pure. */
function buildBlocks(input: RepresentationInput): Block[] {
  const blocks: Block[] = [];
  const title =
    oneLine(input.site.title ?? "") || oneLine(input.serverName) || "This app";
  blocks.push({ kind: "h1", text: title });

  const description = oneLine(input.site.description ?? "");
  if (description) {
    blocks.push({ kind: "p", text: description });
  }

  const facts = (input.site.facts ?? [])
    .map((f) => oneLine(f))
    .filter((f) => f.length > 0);
  if (facts.length > 0) {
    blocks.push({ kind: "ul", items: facts });
  }

  blocks.push({ kind: "h2", text: "What this app offers" });
  if (input.tools.length === 0) {
    blocks.push({
      kind: "p",
      text: "This app currently declares no tools.",
    });
    appendAffordanceBlocks(blocks, input.affordances ?? []);
    return blocks;
  }

  // Descriptive framing only — this states what exists, it does not instruct.
  blocks.push({
    kind: "p",
    text: "This app exposes the following tools through the Model Context Protocol.",
  });
  for (const tool of input.tools) {
    blocks.push({ kind: "h3", text: tool.name });
    const desc = oneLine(tool.description ?? "");
    if (desc) {
      blocks.push({ kind: "p", text: desc });
    }
    const line = paramsLine(tool.params);
    if (line) {
      blocks.push({ kind: "p", text: `Parameters: ${line}` });
    }
  }
  appendAffordanceBlocks(blocks, input.affordances ?? []);
  return blocks;
}

/** Render the block model to markdown. */
function blocksToMarkdown(blocks: readonly Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "h1":
        out.push(`# ${b.text}`);
        break;
      case "h2":
        out.push(`## ${b.text}`);
        break;
      case "h3":
        out.push(`### ${b.text}`);
        break;
      case "p":
        out.push(b.text);
        break;
      case "ul":
        out.push(b.items.map((i) => `- ${i}`).join("\n"));
        break;
      case "affordances":
        out.push(
          b.items
            .map((i) =>
              i.description
                ? `- \`${i.call}\` — ${i.description}`
                : `- \`${i.call}\``,
            )
            .join("\n"),
        );
        break;
    }
  }
  return `${out.join("\n\n")}\n`;
}

/** Escape the five characters that must not appear raw in HTML text/attributes. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render the block model to a minimal, self-contained HTML5 document. The
 * `headExtra` (JSON-LD + `<link rel="search">`, an HTML-only projection of the
 * affordances) is injected into `<head>`. */
function blocksToHtml(
  blocks: readonly Block[],
  title: string,
  headExtra: string,
): string {
  const body: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "h1":
        body.push(`<h1>${escapeHtml(b.text)}</h1>`);
        break;
      case "h2":
        body.push(`<h2>${escapeHtml(b.text)}</h2>`);
        break;
      case "h3":
        body.push(`<h3>${escapeHtml(b.text)}</h3>`);
        break;
      case "p":
        body.push(`<p>${escapeHtml(b.text)}</p>`);
        break;
      case "ul":
        body.push(
          `<ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`,
        );
        break;
      case "affordances":
        body.push(
          `<ul>${b.items
            .map((i) => {
              const call = `<code>${escapeHtml(i.call)}</code>`;
              return i.description
                ? `<li>${call} — ${escapeHtml(i.description)}</li>`
                : `<li>${call}</li>`;
            })
            .join("")}</ul>`,
        );
        break;
    }
  }
  const head = [
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
  ];
  if (headExtra) {
    head.push(headExtra);
  }
  head.push("</head>");
  return [
    "<!doctype html>",
    '<html lang="en">',
    ...head,
    "<body>",
    "<main>",
    body.join("\n"),
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * Build the self-sufficient agent representation from the declared source. Pure
 * and total: same input → same document, no side effects. The markdown and HTML
 * are two encodings of the SAME block model, so they carry identical facts by
 * construction (the cloaking guardrail, enforced structurally rather than by
 * discipline).
 */
export function represent(input: RepresentationInput): Representation {
  const blocks = buildBlocks(input);
  const title =
    oneLine(input.site.title ?? "") || oneLine(input.serverName) || "This app";
  const headExtra = buildHeadExtra(input.affordances ?? [], title);
  return {
    markdown: blocksToMarkdown(blocks),
    html: blocksToHtml(blocks, title, headExtra),
  };
}

// ── Schema introspection (the one Zod-aware corner) ──────────────────────────

/** Minimal view of a Zod v4 schema's internal definition. */
interface ZodV4Like {
  _zod?: { def?: { type?: string; innerType?: unknown; element?: unknown } };
}
/** Minimal view of a Zod v3 schema's internal definition. */
interface ZodV3Like {
  _def?: { typeName?: string; innerType?: unknown; type?: unknown };
}

/** The raw type token for a schema (v4 `type` or v3 `typeName`), or null. */
function rawTypeToken(schema: AnySchema): string | null {
  const v4 = (schema as ZodV4Like)._zod?.def?.type;
  if (typeof v4 === "string") {
    return v4;
  }
  const v3 = (schema as ZodV3Like)._def?.typeName;
  if (typeof v3 === "string") {
    return v3;
  }
  return null;
}

/** The wrapped inner schema of an optional/default/nullable wrapper, or null. */
function innerSchema(schema: AnySchema): AnySchema | null {
  const v4 = (schema as ZodV4Like)._zod?.def?.innerType;
  if (v4) {
    return v4 as AnySchema;
  }
  const v3 = (schema as ZodV3Like)._def?.innerType;
  if (v3) {
    return v3 as AnySchema;
  }
  return null;
}

/** The element schema of an array, or null. */
function elementSchema(schema: AnySchema): AnySchema | null {
  const el = (schema as ZodV4Like)._zod?.def?.element;
  return el ? (el as AnySchema) : null;
}

const TYPE_LABELS: Record<string, string> = {
  string: "string",
  ZodString: "string",
  number: "number",
  ZodNumber: "number",
  bigint: "number",
  ZodBigInt: "number",
  boolean: "boolean",
  ZodBoolean: "boolean",
  date: "date",
  ZodDate: "date",
  object: "object",
  ZodObject: "object",
  enum: "enum",
  ZodEnum: "enum",
  literal: "value",
  ZodLiteral: "value",
};

const WRAPPERS = new Set([
  "optional",
  "ZodOptional",
  "default",
  "ZodDefault",
  "nullable",
  "ZodNullable",
  "readonly",
  "ZodReadonly",
]);

/**
 * A best-effort, cross-(v3/v4) friendly type label for a schema, unwrapping
 * optional/default/nullable wrappers and naming array element types. Returns
 * `undefined` when the type can't be determined — the renderer degrades to
 * `name (required)`, never guesses.
 */
function schemaTypeLabel(schema: AnySchema, depth = 0): string | undefined {
  if (depth > 5) {
    return undefined;
  }
  const token = rawTypeToken(schema);
  if (token === null) {
    return undefined;
  }
  if (WRAPPERS.has(token)) {
    const inner = innerSchema(schema);
    return inner ? schemaTypeLabel(inner, depth + 1) : undefined;
  }
  if (token === "array" || token === "ZodArray") {
    const el = elementSchema(schema);
    const elLabel = el ? schemaTypeLabel(el, depth + 1) : undefined;
    return elLabel ? `${elLabel}[]` : "array";
  }
  return TYPE_LABELS[token];
}

/** Whether a schema is optional for the caller (an `.optional()` or `.default()`). */
function isCallerOptional(schema: AnySchema): boolean {
  if (isSchemaOptional(schema)) {
    return true;
  }
  const token = rawTypeToken(schema);
  return token === "default" || token === "ZodDefault";
}

/**
 * Derive the declared parameters of a tool from its `inputSchema`. Accepts either
 * a raw shape (`{ q: z.string() }`, enpilink's usual form) or a full object
 * schema — both normalise through the MCP SDK's Zod-compat helpers, so this works
 * across Zod v3 and v4. Returns `[]` for a tool with no inputs. Pure.
 */
export function extractToolParams(
  inputSchema: ZodRawShapeCompat | AnySchema | undefined,
): AgentToolParam[] {
  if (!inputSchema) {
    return [];
  }
  const normalized = normalizeObjectSchema(inputSchema);
  const shape = getObjectShape(normalized);
  if (!shape) {
    return [];
  }
  const params: AgentToolParam[] = [];
  for (const [name, schema] of Object.entries(shape)) {
    const param: AgentToolParam = {
      name,
      required: !isCallerOptional(schema),
    };
    const type = schemaTypeLabel(schema);
    if (type !== undefined) {
      param.type = type;
    }
    const desc = getSchemaDescription(schema);
    if (desc) {
      param.description = oneLine(desc);
    }
    params.push(param);
  }
  return params;
}
