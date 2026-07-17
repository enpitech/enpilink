import { describe, expect, it } from "vitest";
import { htmlToMarkdown, safeHtmlToMarkdown } from "./html-to-markdown.js";

describe("htmlToMarkdown", () => {
  it("renders headings at the right level", () => {
    expect(htmlToMarkdown("<h1>Title</h1>")).toBe("# Title\n");
    expect(htmlToMarkdown("<h2>Sub</h2>")).toBe("## Sub\n");
    expect(htmlToMarkdown("<h3>Deeper</h3>")).toBe("### Deeper\n");
  });

  it("renders paragraphs separated by blank lines", () => {
    expect(htmlToMarkdown("<p>One</p><p>Two</p>")).toBe("One\n\nTwo\n");
  });

  it("collapses insignificant whitespace inside a paragraph", () => {
    expect(htmlToMarkdown("<p>a   b\n  c</p>")).toBe("a b c\n");
  });

  it("renders links as [text](href)", () => {
    expect(htmlToMarkdown('<p>See <a href="/x">the shop</a>.</p>')).toBe(
      "See [the shop](/x).\n",
    );
  });

  it("drops a link's markup when it has no href, keeping the text", () => {
    expect(htmlToMarkdown("<p>plain <a>label</a> here</p>")).toBe(
      "plain label here\n",
    );
  });

  it("renders bold and italic", () => {
    expect(htmlToMarkdown("<p><strong>bold</strong> <em>it</em></p>")).toBe(
      "**bold** *it*\n",
    );
    expect(htmlToMarkdown("<p><b>b</b> <i>i</i></p>")).toBe("**b** *i*\n");
  });

  it("renders inline and block code", () => {
    expect(htmlToMarkdown("<p>run <code>npm i</code></p>")).toBe(
      "run `npm i`\n",
    );
    expect(htmlToMarkdown("<pre>line1\nline2</pre>")).toBe(
      "```\nline1\nline2\n```\n",
    );
  });

  it("renders an unordered list", () => {
    expect(htmlToMarkdown("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b\n");
  });

  it("renders an ordered list", () => {
    expect(htmlToMarkdown("<ol><li>a</li><li>b</li></ol>")).toBe(
      "1. a\n2. b\n",
    );
  });

  it("indents a nested list under its item", () => {
    const md = htmlToMarkdown("<ul><li>top<ul><li>child</li></ul></li></ul>");
    expect(md).toBe("- top\n  - child\n");
  });

  it("renders a blockquote with > prefixes", () => {
    expect(htmlToMarkdown("<blockquote><p>quoted</p></blockquote>")).toBe(
      "> quoted\n",
    );
  });

  it("renders a simple table with a header separator", () => {
    const md = htmlToMarkdown(
      "<table><tr><th>Name</th><th>Price</th></tr><tr><td>Mug</td><td>€5</td></tr></table>",
    );
    expect(md).toBe("| Name | Price |\n| --- | --- |\n| Mug | €5 |\n");
  });

  it("drops <script>, <style> and <head> contents entirely", () => {
    const html =
      "<head><title>T</title></head><body><script>alert(1)</script><style>.x{}</style><p>visible</p></body>";
    expect(htmlToMarkdown(html)).toBe("visible\n");
  });

  it("drops HTML comments", () => {
    expect(htmlToMarkdown("<p>a<!-- secret -->b</p>")).toBe("ab\n");
  });

  it("decodes named and numeric entities", () => {
    expect(htmlToMarkdown("<p>Tom &amp; Jerry &#8364;5 &#x2014; end</p>")).toBe(
      "Tom & Jerry €5 — end\n",
    );
  });

  it("preserves the facts of a realistic product page", () => {
    const html = `<!doctype html><html><head><title>Shop</title>
      <meta name="x" content="y"></head>
      <body><nav><a href="/">Home</a></nav>
      <h1>Widgets</h1>
      <ul><li>Blue widget €5</li><li>Red widget €7</li></ul>
      <script>track()</script></body></html>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("# Widgets");
    expect(md).toContain("- Blue widget €5");
    expect(md).toContain("- Red widget €7");
    expect(md).not.toContain("track()");
    expect(md).not.toContain("<script");
  });

  it("survives malformed / unclosed markup without throwing (facts kept)", () => {
    const md = htmlToMarkdown("<p>unclosed <b>bold <i>and italic</p><h2>Next");
    expect(md).toContain("unclosed");
    expect(md).toContain("Next");
  });

  it("passes plain text (no tags) straight through", () => {
    expect(htmlToMarkdown("just text")).toBe("just text\n");
  });
});

describe("safeHtmlToMarkdown", () => {
  it("returns markdown for real content", () => {
    expect(safeHtmlToMarkdown("<h1>Hi</h1>")).toBe("# Hi\n");
  });

  it("returns null for content that yields nothing (fall back to original)", () => {
    expect(safeHtmlToMarkdown("")).toBeNull();
    expect(safeHtmlToMarkdown("<head><style>.x{}</style></head>")).toBeNull();
    expect(safeHtmlToMarkdown("   \n  ")).toBeNull();
  });
});
