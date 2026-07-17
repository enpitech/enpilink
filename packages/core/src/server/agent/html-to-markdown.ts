/**
 * A minimal, dependency-free HTML → Markdown converter (M6, Piece 2).
 *
 * The agent surface can OPTIONALLY re-encode a real route's HTML response to
 * markdown for detected AI chat fetchers (behind `agent.reencode`, off by
 * default). This is a pure RE-ENCODING of the app's OWN content — same facts,
 * fewer tokens (markdown is ~80% smaller than the equivalent HTML) — so it is
 * clean under the cloaking guardrail: it changes the ENCODING, never the claims.
 *
 * ── Why hand-rolled instead of a library ──────────────────────────────────────
 * `turndown` is the de-facto standard, but it pulls in a full DOM implementation
 * (`@mixmark-io/domino`) — hundreds of KB shipped into every enpilink app (and
 * bundled for the edge in M8) for a default-OFF nicety. enpilink is a framework
 * whose runtime deps become the user's bundle weight, so a small, zero-dependency,
 * ESM-native converter is the better trade here. The brief explicitly sanctions
 * "a minimal, well-tested converter for the common tags … and note the
 * limitation."
 *
 * ── Scope + limitation (stated honestly) ──────────────────────────────────────
 * It handles the tags that carry an agent's FACTS: headings, paragraphs, lists
 * (nested), links, images, emphasis/strong, inline + block code, blockquotes,
 * horizontal rules, and simple tables. `<script>`/`<style>`/`<head>`/`<svg>`/
 * comments are dropped. Unknown/other tags are treated as transparent containers,
 * so their TEXT (the facts) always survives even when structure does not. It is
 * NOT a spec-complete HTML5 parser: exotic or malformed markup degrades to plain
 * text extraction rather than perfect structure. The caller ({@link
 * safeHtmlToMarkdown}) turns any failure or empty output into a null so the
 * middleware falls back to serving the ORIGINAL HTML untouched — a bad conversion
 * can never harm the response.
 *
 * Pure: `string -> string`, no I/O, no Node globals — reusable from a future edge
 * adapter, like `capture.ts` / `represent.ts`.
 */

/** A parsed node: an element with children, or a text leaf. */
type Node =
  | { kind: "text"; text: string }
  | { kind: "el"; tag: string; attrs: Map<string, string>; children: Node[] };

/** HTML void elements — never have children, never a closing tag. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Elements whose CONTENT is dropped wholesale (tag and everything up to its
 * matching close). Script/style are non-markup; the rest carry no agent-facing
 * facts and would only add noise (or, for `<head>`, a pile of meta tags).
 */
const SKIP_CONTENT_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "head",
  "iframe",
  "object",
  "canvas",
  "math",
]);

/** Block-level tags that force a paragraph break around their content. */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dd",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "body",
  "html",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  deg: "°",
  euro: "€",
  pound: "£",
  cent: "¢",
  middot: "·",
  bull: "•",
};

/** Decode the HTML entities that carry meaning in prose (named + numeric). */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : m;
  });
}

// ── Parse: HTML string → a lightweight node tree ─────────────────────────────

/** Parse a tag's attributes (only what we need; `href`/`src`/`alt` in practice). */
function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop.
  while ((m = re.exec(raw)) !== null) {
    const name = (m[1] ?? "").toLowerCase();
    if (!name) {
      continue;
    }
    let value = m[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    attrs.set(name, decodeEntities(value));
  }
  return attrs;
}

/** Parse an HTML fragment/document into a node tree. Never throws on bad input. */
function parse(html: string): Node[] {
  const root: Node = {
    kind: "el",
    tag: "#root",
    attrs: new Map(),
    children: [],
  };
  const stack: Extract<Node, { kind: "el" }>[] = [root];
  const top = () => stack[stack.length - 1] as Extract<Node, { kind: "el" }>;

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      pushText(top(), html.slice(i));
      break;
    }
    if (lt > i) {
      pushText(top(), html.slice(i, lt));
    }

    // Comment / CDATA / doctype — skip.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      // A stray "<" with no closing ">": treat the rest as text.
      pushText(top(), html.slice(lt));
      break;
    }
    const inner = html.slice(lt + 1, gt);

    if (inner[0] === "/") {
      // Closing tag: pop to the nearest matching open (tolerant of bad nesting).
      const tag = inner.slice(1).trim().toLowerCase();
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s]?.tag === tag) {
          stack.length = s;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    // Opening tag.
    const selfClose = inner.endsWith("/");
    const body = selfClose ? inner.slice(0, -1) : inner;
    const spaceIdx = body.search(/\s/);
    const tag = (spaceIdx === -1 ? body : body.slice(0, spaceIdx))
      .trim()
      .toLowerCase();
    if (!tag) {
      i = gt + 1;
      continue;
    }
    const attrsRaw = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1);

    if (SKIP_CONTENT_TAGS.has(tag)) {
      // Drop the element and everything up to its matching close tag.
      const close = new RegExp(`</${tag}\\s*>`, "i");
      close.lastIndex = gt + 1;
      const rest = html.slice(gt + 1);
      const mm = close.exec(rest);
      i = mm ? gt + 1 + mm.index + mm[0].length : n;
      continue;
    }

    const el: Extract<Node, { kind: "el" }> = {
      kind: "el",
      tag,
      attrs: parseAttrs(attrsRaw),
      children: [],
    };
    top().children.push(el);
    if (!selfClose && !VOID_TAGS.has(tag)) {
      stack.push(el);
    }
    i = gt + 1;
  }
  return root.children;
}

function pushText(parent: Extract<Node, { kind: "el" }>, raw: string): void {
  if (raw.length === 0) {
    return;
  }
  parent.children.push({ kind: "text", text: decodeEntities(raw) });
}

// ── Render: node tree → markdown ─────────────────────────────────────────────

/** Collect the raw text content of a node (for `<pre>`/`<code>` verbatim). */
function textContent(node: Node): string {
  if (node.kind === "text") {
    return node.text;
  }
  return node.children.map(textContent).join("");
}

/** Render a node's INLINE (phrasing) representation — one line, no block breaks. */
function renderInline(node: Node): string {
  if (node.kind === "text") {
    return node.text;
  }
  const inner = () => node.children.map(renderInline).join("");
  switch (node.tag) {
    case "br":
      return " ";
    case "strong":
    case "b": {
      const t = inner().trim();
      return t ? `**${t}**` : "";
    }
    case "em":
    case "i": {
      const t = inner().trim();
      return t ? `*${t}*` : "";
    }
    case "code": {
      const t = textContent(node).trim();
      return t ? `\`${t}\`` : "";
    }
    case "a": {
      const href = node.attrs.get("href");
      const t = inner().trim();
      if (href && t) {
        return `[${t}](${href})`;
      }
      return t;
    }
    case "img": {
      const src = node.attrs.get("src");
      const alt = (node.attrs.get("alt") ?? "").trim();
      return src ? `![${alt}](${src})` : alt;
    }
    default:
      return inner();
  }
}

/** Collapse inline whitespace to single spaces and trim — for one text line. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Render a list of sibling nodes into block strings (mixed inline/block). */
function renderContainer(children: readonly Node[]): string[] {
  const blocks: string[] = [];
  let inlineBuf = "";
  const flush = (): void => {
    const text = collapse(inlineBuf);
    if (text) {
      blocks.push(text);
    }
    inlineBuf = "";
  };
  for (const child of children) {
    if (child.kind === "el" && isBlock(child.tag)) {
      flush();
      blocks.push(...renderBlock(child));
    } else {
      inlineBuf += renderInline(child);
    }
  }
  flush();
  return blocks;
}

function isBlock(tag: string): boolean {
  return BLOCK_TAGS.has(tag);
}

/** Indent every line of a block by `pad` spaces (for nested list items). */
function indent(block: string, pad: string): string {
  return block
    .split("\n")
    .map((line) => (line.length ? pad + line : line))
    .join("\n");
}

/** Render a list (`ul`/`ol`), including nested lists, into ONE block string. */
function renderList(
  el: Extract<Node, { kind: "el" }>,
  ordered: boolean,
): string {
  const lines: string[] = [];
  let idx = 1;
  for (const child of el.children) {
    if (child.kind !== "el" || child.tag !== "li") {
      continue;
    }
    const itemBlocks = renderContainer(child.children);
    const marker = ordered ? `${idx}. ` : "- ";
    idx++;
    if (itemBlocks.length === 0) {
      lines.push(marker.trimEnd());
      continue;
    }
    const [first, ...rest] = itemBlocks;
    lines.push(`${marker}${first}`);
    const pad = " ".repeat(marker.length);
    for (const b of rest) {
      lines.push(indent(b, pad));
    }
  }
  return lines.join("\n");
}

/** Render a simple table into a markdown table block. */
function renderTable(el: Extract<Node, { kind: "el" }>): string {
  const rows: string[][] = [];
  const collectRows = (node: Node): void => {
    if (node.kind !== "el") {
      return;
    }
    if (node.tag === "tr") {
      const cells: string[] = [];
      for (const c of node.children) {
        if (c.kind === "el" && (c.tag === "td" || c.tag === "th")) {
          cells.push(collapse(c.children.map(renderInline).join("")));
        }
      }
      rows.push(cells);
      return;
    }
    for (const c of node.children) {
      collectRows(c);
    }
  };
  collectRows(el);
  const [header, ...body] = rows;
  if (!header) {
    return "";
  }
  const width = Math.max(...rows.map((r) => r.length));
  const fmt = (r: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const out = [fmt(header), `| ${Array(width).fill("---").join(" | ")} |`];
  for (const r of body) {
    out.push(fmt(r));
  }
  return out.join("\n");
}

/** Render one block-level element into block strings. */
function renderBlock(el: Extract<Node, { kind: "el" }>): string[] {
  const tag = el.tag;
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    const text = collapse(el.children.map(renderInline).join(""));
    return text ? [`${"#".repeat(level)} ${text}`] : [];
  }
  switch (tag) {
    case "hr":
      return ["---"];
    case "ul":
      return blockOrEmpty(renderList(el, false));
    case "ol":
      return blockOrEmpty(renderList(el, true));
    case "pre": {
      const code = textContent(el).replace(/\n+$/, "");
      return code ? [`\`\`\`\n${code}\n\`\`\``] : [];
    }
    case "blockquote": {
      const inner = renderContainer(el.children);
      if (inner.length === 0) {
        return [];
      }
      return [indent(inner.join("\n\n"), "> ")];
    }
    case "table":
      return blockOrEmpty(renderTable(el));
    default:
      // p / div / section / li-as-container / unknown block: transparent — its
      // children are rendered as blocks so nested structure survives.
      return renderContainer(el.children);
  }
}

function blockOrEmpty(s: string): string[] {
  return s.trim() ? [s] : [];
}

/**
 * Convert an HTML string to markdown. Pure and total for well-formed input;
 * tolerant (never throws) for malformed input. Prefer {@link safeHtmlToMarkdown}
 * at a call site that must fall back to the original HTML on a poor conversion.
 */
export function htmlToMarkdown(html: string): string {
  const tree = parse(html);
  const blocks = renderContainer(tree);
  const body = blocks.join("\n\n").replace(/[ \t]+$/gm, "");
  return body ? `${body}\n` : "";
}

/**
 * Convert HTML to markdown, returning `null` when the conversion throws OR yields
 * effectively no content. A `null` tells the re-encode middleware to serve the
 * ORIGINAL HTML untouched — so a broken/empty conversion is guardrail-safe: the
 * agent is never handed less than it would have gotten with the flag off.
 */
export function safeHtmlToMarkdown(html: string): string | null {
  try {
    const md = htmlToMarkdown(html);
    return md.trim().length > 0 ? md : null;
  } catch {
    return null;
  }
}
