import type { AgentGetAffordance, AgentToolParam } from "../represent.js";
import { AGENT_GET_PREFIX, type GetExposedTool } from "./types.js";

/**
 * Search-affordance detection + the affordance projection (M7). PURE — no I/O, no
 * clock — so both the registration path (`server.ts`) and the tests use the same
 * logic. A GET tool is declared as a SEARCH affordance (JSON-LD `SearchAction` /
 * OpenSearch) when it has a single free-text query parameter; otherwise it is a
 * plain declarative link with its GET URL. The declaration is always via STANDARD
 * signals only — never prose addressed to an agent (FINDINGS F-9).
 */

/** Conventional names for a free-text "search terms" parameter. */
const SEARCH_PARAM_NAMES = new Set([
  "q",
  "query",
  "search",
  "searchterms",
  "term",
  "terms",
  "keyword",
  "keywords",
  "s",
  "text",
]);

/**
 * Pick the free-text search parameter of a GET tool, or `null` when it is not
 * search-shaped. An author can override via `transports.get.queryParam`: a string
 * names it explicitly, `null` opts the tool OUT of search-shaping.
 *
 * Inference, in order: a conventionally-named string param (`q`, `query`, …); else
 * the sole required string param; else the sole string param overall.
 */
export function pickSearchParam(
  params: readonly AgentToolParam[],
  override?: string | null,
): string | null {
  if (override === null) {
    return null;
  }
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  const strings = params.filter((p) => p.type === "string");
  const named = strings.find((p) =>
    SEARCH_PARAM_NAMES.has(p.name.toLowerCase()),
  );
  if (named) {
    return named.name;
  }
  const requiredStrings = strings.filter((p) => p.required);
  const soleRequired =
    requiredStrings.length === 1 ? requiredStrings[0] : undefined;
  if (soleRequired) {
    return soleRequired.name;
  }
  const soleString = strings.length === 1 ? strings[0] : undefined;
  if (soleString) {
    return soleString.name;
  }
  return null;
}

/** Project a registered GET-exposed tool to its declarative affordance. */
export function toAffordance(tool: GetExposedTool): AgentGetAffordance {
  return {
    urlPath: `${AGENT_GET_PREFIX}/${tool.path}`,
    name: tool.name,
    description: tool.description,
    queryParam: tool.queryParam,
    params: tool.params,
  };
}
