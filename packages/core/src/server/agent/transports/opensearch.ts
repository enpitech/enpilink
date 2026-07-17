import type { AgentGetAffordance } from "../represent.js";

/**
 * The OpenSearch description document (M7) — the standard, ~20-year-old way a site
 * DECLARES that it is searchable, referenced from the representation via
 * `<link rel="search" type="application/opensearchdescription+xml">`. PURE: builds
 * the XML from a search-shaped GET affordance. This is a STANDARD signal, not
 * prose — there is nothing here addressed to an agent.
 *
 * The template substitutes the OpenSearch `{searchTerms}` macro into the tool's
 * free-text query parameter, and offers both the markdown and HTML content types
 * against the same GET endpoint (the transport content-negotiates on `Accept`).
 */

/** XML-escape the five significant characters for element text and attributes. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the `?<queryParam>={searchTerms}` template URL for a search affordance,
 * optionally absolute against `baseUrl` (OpenSearch consumers prefer an absolute
 * template; a relative one still resolves against the description document's URL).
 */
export function searchTermsTemplate(
  aff: AgentGetAffordance,
  baseUrl?: string,
): string | null {
  if (!aff.queryParam) {
    return null;
  }
  const base = baseUrl ? baseUrl.replace(/\/+$/, "") : "";
  return `${base}${aff.urlPath}?${aff.queryParam}={searchTerms}`;
}

/**
 * Generate the OpenSearch description document for a search-shaped GET affordance.
 * Returns `null` for a non-search affordance (no free-text param). `baseUrl`, when
 * supplied, makes the templates absolute.
 */
export function openSearchXml(
  aff: AgentGetAffordance,
  opts?: { baseUrl?: string; shortName?: string; description?: string },
): string | null {
  const template = searchTermsTemplate(aff, opts?.baseUrl);
  if (!template) {
    return null;
  }
  const shortName = escapeXml(opts?.shortName ?? aff.name);
  const description = escapeXml(
    opts?.description ?? aff.description ?? `Search via ${aff.name}`,
  );
  const t = escapeXml(template);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">',
    `  <ShortName>${shortName}</ShortName>`,
    `  <Description>${description}</Description>`,
    `  <Url type="text/markdown" template="${t}"/>`,
    `  <Url type="application/json" template="${t}"/>`,
    `  <Url type="text/html" template="${t}"/>`,
    "</OpenSearchDescription>",
    "",
  ].join("\n");
}
