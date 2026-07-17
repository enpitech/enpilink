import { describe, expect, it } from "vitest";
import type { AgentToolParam } from "../represent.js";
import { pickSearchParam, toAffordance } from "./affordance.js";
import { openSearchXml } from "./opensearch.js";
import type { GetExposedTool } from "./types.js";

describe("pickSearchParam", () => {
  it("picks a conventionally-named free-text param", () => {
    expect(
      pickSearchParam([
        { name: "q", required: true, type: "string" },
        { name: "limit", required: false, type: "number" },
      ]),
    ).toBe("q");
  });

  it("picks the sole required string param", () => {
    expect(
      pickSearchParam([{ name: "term", required: true, type: "string" }]),
    ).toBe("term");
  });

  it("returns null when there is no single free-text param", () => {
    expect(
      pickSearchParam([
        { name: "sku", required: true, type: "string" },
        { name: "warehouse", required: true, type: "string" },
      ]),
    ).toBeNull();
    expect(pickSearchParam([])).toBeNull();
  });

  it("honours an explicit override and an explicit opt-out", () => {
    expect(
      pickSearchParam([{ name: "x", required: true, type: "string" }], "x"),
    ).toBe("x");
    expect(
      pickSearchParam([{ name: "q", required: true, type: "string" }], null),
    ).toBeNull();
  });
});

describe("openSearchXml", () => {
  const searchParams: AgentToolParam[] = [
    { name: "q", required: true, type: "string" },
  ];
  const aff = {
    urlPath: "/agent/search",
    name: "search_catalog",
    description: "Search the catalog.",
    queryParam: "q",
    params: searchParams,
  };

  it("builds a description document with a {searchTerms} template", () => {
    const xml = openSearchXml(aff, { baseUrl: "https://shop.test" });
    expect(xml).toContain("<OpenSearchDescription");
    expect(xml).toContain(
      'type="text/markdown" template="https://shop.test/agent/search?q={searchTerms}"',
    );
    expect(xml).toContain("<ShortName>search_catalog</ShortName>");
  });

  it("returns null for a non-search affordance", () => {
    expect(openSearchXml({ ...aff, queryParam: null })).toBeNull();
  });
});

describe("toAffordance", () => {
  it("projects an exposed tool to its declarative affordance", () => {
    const tool: GetExposedTool = {
      name: "search_catalog",
      path: "search",
      description: "Search the catalog.",
      params: [{ name: "q", required: true, type: "string" }],
      queryParam: "q",
      execute: async () => ({}),
    };
    expect(toAffordance(tool)).toEqual({
      urlPath: "/agent/search",
      name: "search_catalog",
      description: "Search the catalog.",
      queryParam: "q",
      params: [{ name: "q", required: true, type: "string" }],
    });
  });
});
