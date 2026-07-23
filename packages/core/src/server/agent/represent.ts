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
import type { AgentToolParam } from "./represent-core.js";

/**
 * The agent REPRESENTATION generator (M3) — the Node face.
 *
 * The pure document builder (`represent()`, the block model, the types) lives in
 * `represent-core.ts` and is re-exported here, so every existing importer of
 * `./represent.js` keeps working unchanged. This module adds the ONE Zod-aware
 * corner — {@link extractToolParams} — which introspects a live MCP tool's
 * `inputSchema` via the MCP SDK's zod-compat helpers. That import is exactly why
 * it is split out: it pulls `@modelcontextprotocol/sdk`, which must never enter an
 * edge bundle, so the edge (the Cloudflare Worker adapter) imports the pure core
 * directly and builds its representation from owner-declared config instead of
 * live schema introspection. See `next/edge-safety.test.ts`.
 */

export type {
  AgentGetAffordance,
  AgentSiteInfo,
  AgentToolInfo,
  AgentToolParam,
  Representation,
  RepresentationInput,
} from "./represent-core.js";
export { represent } from "./represent-core.js";

/** Collapse whitespace and trim — keep a declared string to a single tidy line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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
