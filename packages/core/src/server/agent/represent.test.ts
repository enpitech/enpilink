import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AgentGetAffordance,
  type AgentToolInfo,
  extractToolParams,
  represent,
} from "./represent.js";

/** Phrases that read as prompt injection and get an agent-facing doc REFUSED
 * (FINDINGS F-9). The framework's own framing must contain NONE of them. */
const IMPERATIVE_MARKERS = [
  "you must",
  "if you are an ai",
  "if you're an ai",
  "ignore previous",
  "ignore all previous",
  "always cite",
  "you should always",
  "as an ai",
];

function assertNoImperativeProse(markdown: string): void {
  const lower = markdown.toLowerCase();
  for (const marker of IMPERATIVE_MARKERS) {
    expect(lower).not.toContain(marker);
  }
}

describe("extractToolParams", () => {
  it("derives name / required / type / description from a raw Zod shape", () => {
    const params = extractToolParams({
      q: z.string().describe("the search query"),
      limit: z.number().max(50).optional(),
      flag: z.boolean().default(false),
      tags: z.array(z.string()),
      kind: z.enum(["a", "b"]),
    });
    const byName = new Map(params.map((p) => [p.name, p]));

    expect(byName.get("q")).toMatchObject({
      name: "q",
      required: true,
      type: "string",
      description: "the search query",
    });
    // `.optional()` → not required for the caller.
    expect(byName.get("limit")).toMatchObject({
      name: "limit",
      required: false,
      type: "number",
    });
    // `.default()` also means the caller need not supply it.
    expect(byName.get("flag")).toMatchObject({ name: "flag", required: false });
    expect(byName.get("tags")?.type).toBe("string[]");
    expect(byName.get("kind")?.type).toBe("enum");
  });

  it("returns [] for a tool with no inputs", () => {
    expect(extractToolParams(undefined)).toEqual([]);
    expect(extractToolParams({})).toEqual([]);
  });

  it("accepts a full object schema, not just a raw shape", () => {
    const params = extractToolParams(z.object({ q: z.string() }));
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ name: "q", required: true });
  });
});

describe("represent", () => {
  const tools: AgentToolInfo[] = [
    {
      name: "search_catalog",
      description: "Search the product catalog.",
      params: [
        { name: "q", required: true, type: "string" },
        { name: "limit", required: false, type: "number" },
      ],
    },
  ];

  it("names the registered tool and the site in the markdown", () => {
    const { markdown } = represent({
      serverName: "fallback-name",
      site: { title: "Acme Store", description: "Sells running shoes." },
      tools,
      path: "/products/blue-widget",
    });
    expect(markdown).toContain("# Acme Store");
    expect(markdown).toContain("Sells running shoes.");
    expect(markdown).toContain("search_catalog");
    expect(markdown).toContain("Search the product catalog.");
    // The call surface is described, declaratively.
    expect(markdown).toContain("q (string, required)");
    expect(markdown).toContain("limit (number, optional)");
  });

  it("emits NO imperative prose in its own framing (F-9)", () => {
    const { markdown } = represent({
      serverName: "srv",
      site: { title: "Acme", description: "A shop." },
      tools,
      path: "/",
    });
    assertNoImperativeProse(markdown);
  });

  it("falls back to the server name when the site declares no title", () => {
    const { markdown } = represent({
      serverName: "my-mcp-server",
      site: {},
      tools,
      path: "/",
    });
    expect(markdown).toContain("# my-mcp-server");
  });

  it("renders declared facts as bullets", () => {
    const { markdown } = represent({
      serverName: "srv",
      site: { title: "Acme", facts: ["Ships worldwide", "Prices in USD"] },
      tools: [],
      path: "/",
    });
    expect(markdown).toContain("- Ships worldwide");
    expect(markdown).toContain("- Prices in USD");
  });

  it("handles a site with no tools declared", () => {
    const { markdown } = represent({
      serverName: "srv",
      site: { title: "Acme" },
      tools: [],
      path: "/",
    });
    expect(markdown).toContain("This app currently declares no tools.");
  });

  it("produces markdown and HTML that carry the SAME facts (guardrail)", () => {
    const { markdown, html } = represent({
      serverName: "srv",
      site: { title: "Acme Store", description: "Sells shoes." },
      tools,
      path: "/",
    });
    // Both encodings name the tool and the site.
    for (const doc of [markdown, html]) {
      expect(doc).toContain("Acme Store");
      expect(doc).toContain("search_catalog");
      expect(doc).toContain("Search the product catalog.");
    }
    // The HTML is a real, self-contained document.
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Acme Store</title>");
    expect(html).toContain("<h1>Acme Store</h1>");
    assertNoImperativeProse(html);
  });

  it("HTML-escapes owner text so the document stays well-formed", () => {
    const { html } = represent({
      serverName: "srv",
      site: { title: "A & B <Store>", description: 'Quote"d' },
      tools: [],
      path: "/",
    });
    expect(html).toContain("A &amp; B &lt;Store&gt;");
    expect(html).not.toContain("<Store>");
  });
});

describe("represent — GET affordance declaration (M7, standard signals only)", () => {
  const affTools: AgentToolInfo[] = [
    {
      name: "search_catalog",
      description: "Search the product catalog.",
      params: [{ name: "q", required: true, type: "string" }],
    },
  ];
  const searchAff: AgentGetAffordance = {
    urlPath: "/agent/search",
    name: "search_catalog",
    description: "Search the product catalog.",
    queryParam: "q",
    params: [{ name: "q", required: true, type: "string" }],
  };
  const base = {
    serverName: "srv",
    site: { title: "Acme" },
    tools: affTools,
    path: "/",
  };

  it("declares a search affordance as JSON-LD SearchAction + rel=search in HTML", () => {
    const { html } = represent({ ...base, affordances: [searchAff] });
    expect(html).toContain('"@type": "SearchAction"');
    expect(html).toContain("search_term_string");
    expect(html).toContain('rel="search"');
    expect(html).toContain('type="application/opensearchdescription+xml"');
    expect(html).toContain("/agent/opensearch.xml");
    // Standard signals, never prose addressed to an agent.
    assertNoImperativeProse(html);
  });

  it("declares the affordance as a factual GET URL in markdown (no imperative prose)", () => {
    const { markdown } = represent({ ...base, affordances: [searchAff] });
    expect(markdown).toContain("Data endpoints");
    expect(markdown).toContain("GET /agent/search?q={query}");
    assertNoImperativeProse(markdown);
  });

  it("carries the affordance in BOTH encodings (cloaking guardrail)", () => {
    const { markdown, html } = represent({ ...base, affordances: [searchAff] });
    for (const doc of [markdown, html]) {
      expect(doc).toContain("/agent/search");
    }
  });

  it("declares a non-search GET tool as a plain Action / declarative link", () => {
    const stockAff: AgentGetAffordance = {
      urlPath: "/agent/stock",
      name: "check_stock",
      queryParam: null,
      params: [{ name: "sku", required: true, type: "string" }],
    };
    const { html, markdown } = represent({
      ...base,
      tools: [],
      affordances: [stockAff],
    });
    expect(html).toContain('"@type": "Action"');
    expect(html).toContain("/agent/stock?sku={sku}");
    expect(markdown).toContain("GET /agent/stock?sku={string}");
  });

  it("emits NO affordance signals when there are none (the default)", () => {
    const { html } = represent(base);
    expect(html).not.toContain("application/ld+json");
    expect(html).not.toContain('rel="search"');
  });
});
