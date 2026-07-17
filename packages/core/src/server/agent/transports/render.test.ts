import { describe, expect, it } from "vitest";
import {
  badRequestMarkdown,
  rateLimitMarkdown,
  renderGetResult,
  usageLine,
} from "./render.js";

describe("renderGetResult", () => {
  it("uses the tool's own render when structured content is present", () => {
    const out = renderGetResult(
      { structuredContent: { n: 2 } },
      (sc) => `count=${(sc as { n: number }).n}`,
    );
    expect(out).toBe("count=2");
  });

  it("joins text content blocks when there is no render", () => {
    const out = renderGetResult({
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    });
    expect(out).toBe("a\nb");
  });

  it("falls back to a JSON block of the structured content", () => {
    const out = renderGetResult({ structuredContent: { a: 1 } });
    expect(out).toContain("```json");
    expect(out).toContain('"a": 1');
  });
});

describe("usageLine", () => {
  it("shows only the required params as a call template", () => {
    expect(
      usageLine("/agent/search", [
        { name: "q", required: true, type: "string" },
        { name: "limit", required: false, type: "number" },
      ]),
    ).toBe("GET /agent/search?q={string}");
  });
});

describe("badRequestMarkdown", () => {
  it("describes the parameters and the call shape, never imperatively", () => {
    const md = badRequestMarkdown({
      urlPath: "/agent/search",
      params: [
        { name: "q", required: true, type: "string" },
        { name: "limit", required: false, type: "number" },
      ],
      detail: "limit must be a number ≤ 50.",
    });
    expect(md).toContain("# Bad request");
    expect(md).toContain("limit must be a number ≤ 50.");
    expect(md).toContain("`q` (string, required)");
    expect(md).toContain("GET /agent/search?q={string}");
    expect(md.toLowerCase()).not.toContain("you must");
  });
});

describe("rateLimitMarkdown", () => {
  it("states the retry window", () => {
    const md = rateLimitMarkdown({
      urlPath: "/agent/search",
      retryAfterSeconds: 5,
    });
    expect(md).toContain("# Too many requests");
    expect(md).toContain("Retry after 5 seconds");
  });
});
