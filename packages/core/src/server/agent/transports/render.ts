import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolParam } from "../represent.js";
import type { GetToolResult } from "./types.js";

/**
 * GET-transport response rendering (M7, ARCHITECTURE §3.5). PURE. Turns a tool
 * result into the markdown body, and builds the agent-legible 400/429 bodies. All
 * DESCRIPTIVE, never imperative (FINDINGS F-9): the error bodies DESCRIBE the
 * parameters and show the call shape, the way an error message does — they never
 * command the agent ("you must …").
 */

/** Join a result's text content blocks into one string. */
function contentText(content: readonly ContentBlock[] | undefined): string {
  if (!content) {
    return "";
  }
  return content
    .filter((b): b is ContentBlock & { type: "text"; text: string } => {
      return (
        b.type === "text" && typeof (b as { text?: unknown }).text === "string"
      );
    })
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Render a tool result to markdown. Preference order: the tool's own `render`
 * (given its structured content) → the joined text content → a pretty-printed
 * JSON block of the structured content → an empty string (a valid "200 empty").
 */
export function renderGetResult(
  result: GetToolResult,
  render?: (structuredContent: unknown) => string,
): string {
  if (render && result.structuredContent !== undefined) {
    return render(result.structuredContent);
  }
  const text = contentText(result.content);
  if (text) {
    return text;
  }
  if (result.structuredContent !== undefined) {
    return [
      "```json",
      JSON.stringify(result.structuredContent, null, 2),
      "```",
      "",
    ].join("\n");
  }
  return "";
}

/** A friendly placeholder for a parameter in a URL template. */
function placeholder(p: AgentToolParam): string {
  return `{${p.type ?? "value"}}`;
}

/** `GET /agent/search?q={string}` — the required params as a call template. */
export function usageLine(
  urlPath: string,
  params: readonly AgentToolParam[],
): string {
  const required = params.filter((p) => p.required);
  const qs = required.map((p) => `${p.name}=${placeholder(p)}`).join("&");
  return qs ? `GET ${urlPath}?${qs}` : `GET ${urlPath}`;
}

/** A declarative bullet list of the parameters (name, type, required, doc). */
function parameterDoc(params: readonly AgentToolParam[]): string {
  if (params.length === 0) {
    return "This endpoint takes no parameters.";
  }
  return params
    .map((p) => {
      const bits = [p.type ?? "value", p.required ? "required" : "optional"];
      const desc = p.description ? ` — ${p.description}` : "";
      return `- \`${p.name}\` (${bits.join(", ")})${desc}`;
    })
    .join("\n");
}

/**
 * The 400 body: state what was wrong, describe the parameters, and show the call
 * shape. Descriptive — it reads like an error message, not a command.
 */
export function badRequestMarkdown(input: {
  urlPath: string;
  params: readonly AgentToolParam[];
  detail: string;
}): string {
  return [
    "# Bad request",
    "",
    input.detail,
    "",
    "## Parameters",
    "",
    parameterDoc(input.params),
    "",
    "## Usage",
    "",
    usageLine(input.urlPath, input.params),
    "",
  ].join("\n");
}

/** The 429 body: state the limit and the retry window. Descriptive. */
export function rateLimitMarkdown(input: {
  urlPath: string;
  retryAfterSeconds: number;
}): string {
  return [
    "# Too many requests",
    "",
    `This endpoint is rate limited. Retry after ${input.retryAfterSeconds} seconds.`,
    "",
    `Endpoint: ${input.urlPath}`,
    "",
  ].join("\n");
}
