import {
  type AnySchema,
  getParseErrorMessage,
  normalizeObjectSchema,
  safeParse,
  type ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { AgentToolParam } from "../represent.js";

/**
 * Query-string → tool-args coercion (M7, ARCHITECTURE §3.4). PURE. A query string
 * is all strings; a tool's input schema wants numbers/booleans/arrays. This
 * pre-coerces each DECLARED parameter to its scalar type (driven by the friendly
 * type label the representation already derived), then validates the whole object
 * against the tool's REAL schema via the MCP SDK's Zod-compat `safeParse` — so the
 * tool sees exactly what an MCP caller would, and validation is the tool's own.
 *
 * Undeclared query keys are IGNORED (agents append `via=`, `utm_*`, …), never an
 * error. A validation failure returns a readable message the router turns into a
 * 400 that TEACHES the correct call (never imperative prose — FINDINGS F-9).
 */

/** The coercion outcome: the validated args, or a readable failure message. */
export type CoerceQueryResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

/** Coerce a single boolean-ish query value; leave it raw so the schema rejects. */
function parseBool(v: unknown): unknown {
  const s = String(v).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") {
    return true;
  }
  if (s === "0" || s === "false" || s === "no" || s === "off") {
    return false;
  }
  return v;
}

/** Coerce one scalar query value to the JS type named by a friendly type label. */
function coerceScalar(value: unknown, type: string | undefined): unknown {
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === "boolean") {
    return parseBool(value);
  }
  // string / enum / value(literal) / date / unknown → pass the string through and
  // let the tool's own schema validate (e.g. enum membership, `z.coerce.date()`).
  return value;
}

/** Coerce one declared parameter's raw query value to its declared type. */
function coerceParam(raw: unknown, type: string | undefined): unknown {
  if (type?.endsWith("[]")) {
    const elementType = type.slice(0, -2);
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.map((el) => coerceScalar(el, elementType));
  }
  // A repeated scalar param (`?q=a&q=b`) arrives as an array — take the last.
  const scalar = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  return coerceScalar(scalar, type);
}

/**
 * Coerce and validate a query object against a tool's input schema. Only DECLARED
 * params are read; everything else in the query is ignored. Returns the validated
 * args on success, or a readable failure message.
 */
export function coerceQuery(
  inputSchema: ZodRawShapeCompat | AnySchema | undefined,
  params: readonly AgentToolParam[],
  query: Record<string, unknown>,
): CoerceQueryResult {
  const preCoerced: Record<string, unknown> = {};
  for (const param of params) {
    const raw = query[param.name];
    if (raw === undefined) {
      continue; // absent → let the schema decide (required / optional / default).
    }
    preCoerced[param.name] = coerceParam(raw, param.type);
  }

  const schema = normalizeObjectSchema(inputSchema);
  if (!schema) {
    return { ok: true, args: preCoerced };
  }
  const parsed = safeParse(schema, preCoerced);
  if (parsed.success) {
    return { ok: true, args: parsed.data as Record<string, unknown> };
  }
  return { ok: false, message: getParseErrorMessage(parsed.error) };
}
