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

/** Everything the generator needs. All fields are owner-declared or framework. */
export interface RepresentationInput {
  /** Fallback title when the site declares none (the MCP server name). */
  serverName: string;
  /** The owner-declared site summary (may be empty). */
  site: AgentSiteInfo;
  /** The declared tool index (may be empty). */
  tools: AgentToolInfo[];
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

/** The internal block model — one source of truth rendered to BOTH encodings. */
type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] };

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

/** Render the block model to a minimal, self-contained HTML5 document. */
function blocksToHtml(blocks: readonly Block[], title: string): string {
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
    }
  }
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
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
  return {
    markdown: blocksToMarkdown(blocks),
    html: blocksToHtml(blocks, title),
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
