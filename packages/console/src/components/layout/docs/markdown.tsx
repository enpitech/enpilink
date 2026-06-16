import { useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
// Full Prism build (bundles all common languages) so guide code fences —
// bash/ts/tsx/json — highlight without per-language registration. PrismLight
// would silently fall back to plain text for unregistered languages.
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light";
import remarkGfm from "remark-gfm";
import { cn } from "@/components/ui/cn.js";

/**
 * Renders a documentation guide's Markdown body in-app.
 *
 * The guides are authored as Mintlify MDX. react-markdown is a CommonMark/GFM
 * renderer, not an MDX engine, so before rendering we `degradeMdx()` the source:
 * Mintlify-only JSX components (<Note>, <Tip>, <Warning>, <Info>, <Frame>, …)
 * are converted to plain Markdown (callout blockquotes / unwrapped content /
 * image syntax) so they render gracefully instead of leaking as raw text or
 * crashing. Anything we don't special-case is stripped of its wrapper tags so
 * the inner Markdown still renders.
 *
 * Code fences are highlighted with react-syntax-highlighter (already a devtools
 * dep) using a light Prism theme that matches the clean/teal aesthetic.
 */

/** Strip/convert Mintlify MDX components into plain Markdown. */
function degradeMdx(src: string): string {
  let out = src;

  // Callout components -> blockquote with a bold label (graceful, readable).
  const callouts: Array<[string, string]> = [
    ["Note", "Note"],
    ["Tip", "Tip"],
    ["Info", "Info"],
    ["Warning", "Warning"],
    ["Check", "Check"],
    ["Danger", "Warning"],
  ];
  for (const [tag, label] of callouts) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
    out = out.replace(re, (_m, inner: string) => {
      const lines = inner.trim().split(/\r?\n/);
      const quoted = lines.map((l) => `> ${l}`.trimEnd()).join("\n");
      return `\n> **${label}**\n>\n${quoted}\n`;
    });
  }

  // <Frame>…</Frame> — just unwrap (keep the inner image/content).
  out = out.replace(/<\/?Frame[^>]*>/g, "");

  // Bare <img src="..." alt="..." /> -> Markdown image.
  out = out.replace(
    /<img\s+[^>]*?src=["']([^"']+)["'][^>]*?(?:alt=["']([^"']*)["'][^>]*?)?\/?>/g,
    (_m, src2: string, alt: string | undefined) => `![${alt ?? ""}](${src2})`,
  );

  // Any other leftover self-closing / paired uppercase JSX tags: drop the tag
  // wrapper but keep inner text so nothing crashes and content survives.
  out = out.replace(/<\/?[A-Z][A-Za-z0-9]*(\s[^>]*)?\/?>/g, "");

  return out;
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-0 mb-4 text-2xl font-semibold text-foreground">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-8 mb-3 border-b border-canvas-border pb-1.5 text-lg font-semibold text-foreground">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-6 mb-2 font-medium text-base text-foreground">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="my-3 text-sm leading-relaxed text-foreground/85">
      {children}
    </p>
  ),
  ul: ({ children }) => (
    <ul className="my-3 ml-5 list-disc space-y-1.5 text-sm text-foreground/85">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 ml-5 list-decimal space-y-1.5 text-sm text-foreground/85">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => {
    // Internal Mintlify links (/guides/…) won't navigate in-app; render as a
    // muted reference so they don't look like dead external links.
    const external = href?.startsWith("http");
    return (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noreferrer noopener" : undefined}
        className="font-medium text-[#2f9e91] underline-offset-2 hover:underline dark:text-[#5fc7ba]"
      >
        {children}
      </a>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-4 rounded-md border border-[#b3e4dd] bg-[#3fb6a8]/8 px-4 py-2 text-sm text-foreground/85 dark:border-[#2f6f67] dark:bg-[#5fc7ba]/8">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-md border border-canvas-border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-canvas text-left">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border-b border-canvas-border px-3 py-2 font-medium text-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-canvas-border px-3 py-2 align-top text-foreground/85">
      {children}
    </td>
  ),
  img: ({ src, alt }) =>
    typeof src === "string" ? (
      <img
        src={src}
        alt={alt ?? ""}
        className="my-4 rounded-md border border-canvas-border"
      />
    ) : null,
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const text = String(children).replace(/\n$/, "");
    // Inline code (no language, single line) -> styled <code>.
    if (!match && !text.includes("\n")) {
      return (
        <code
          className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <SyntaxHighlighter
        language={match?.[1] ?? "text"}
        style={oneLight}
        customStyle={{
          margin: "1rem 0",
          borderRadius: "0.375rem",
          fontSize: "0.8125rem",
          border: "1px solid var(--color-canvas-border)",
          background: "var(--color-canvas)",
        }}
        codeTagProps={{ style: { fontFamily: "var(--font-mono, monospace)" } }}
      >
        {text}
      </SyntaxHighlighter>
    );
  },
};

export function GuideMarkdown({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  const processed = useMemo(() => degradeMdx(body), [body]);
  return (
    <div className={cn("max-w-3xl", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {processed}
      </Markdown>
    </div>
  );
}

export default GuideMarkdown;
