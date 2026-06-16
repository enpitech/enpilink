/**
 * Single-sources the repo's documentation guides into the devtools bundle.
 *
 * The guides live OUTSIDE this package at `docs/guides/*.mdx` (the same files
 * Mintlify renders for the hosted docs site). Rather than duplicate them, we
 * import their raw text at BUILD TIME via Vite's `import.meta.glob` with
 * `query: "?raw", eager: true`. Because the glob is resolved at transform time
 * (both in `vite` dev and `vite build`), the guide text is inlined into the
 * prod bundle — so the Docs tab works in the production admin too, with no
 * runtime file-system access. (`vite.config.ts` adds `server.fs.allow` so the
 * dev server can also read these out-of-package files.)
 *
 * The path is relative to THIS file:
 *   packages/devtools/src/components/layout/docs/ -> ../../../../../../docs/guides
 */

// Vite-injected glob type (kept local so the file type-checks without
// depending on `vite/client` ambient types in every tsconfig).
type GlobImport = (
  pattern: string,
  options: { query: string; eager: true; import: "default" },
) => Record<string, string>;

const rawGuides = (import.meta as unknown as { glob: GlobImport }).glob(
  "../../../../../../docs/guides/*.mdx",
  {
    query: "?raw",
    eager: true,
    import: "default",
  },
);

export type Guide = {
  /** slug derived from the file name (e.g. "observability"). */
  slug: string;
  /** Title from frontmatter, falling back to a humanized slug. */
  title: string;
  /** Optional description from frontmatter. */
  description?: string;
  /** Markdown body with the frontmatter block stripped. */
  body: string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Minimal YAML-ish frontmatter reader for `key: value` lines (quotes trimmed). */
function parseFrontmatter(raw: string): {
  data: Record<string, string>;
  body: string;
} {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { data: {}, body: raw };
  }
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      data[key] = value;
    }
  }
  return { data, body: raw.slice(match[0].length) };
}

function humanize(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function slugFromPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.mdx$/, "");
}

/**
 * All guides, parsed once at module load, sorted alphabetically by title.
 * Stable across renders so the sub-nav order is deterministic.
 */
export const GUIDES: ReadonlyArray<Guide> = Object.entries(rawGuides)
  .map(([path, raw]) => {
    const slug = slugFromPath(path);
    const { data, body } = parseFrontmatter(raw);
    return {
      slug,
      title: data.title ?? humanize(slug),
      description: data.description || undefined,
      body,
    };
  })
  .sort((a, b) => a.title.localeCompare(b.title));
