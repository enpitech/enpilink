import { BookOpen, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/components/ui/cn.js";
import { Input } from "@/components/ui/input.js";
import { GUIDES } from "./guides.js";
import { GuideMarkdown } from "./markdown.js";

/**
 * Docs tab (M8). Renders the repo's `docs/guides/*.mdx` IN-APP (single-sourced
 * at build time via `guides.ts`, so it works in the prod admin too). Layout:
 * a left sub-nav listing the guides (titles from frontmatter) with a search /
 * filter over titles + descriptions, and the rendered Markdown on the right.
 *
 * Reads files, not MCP — so (like the Dashboard) it is reachable without an MCP
 * connection. In prod it sits under the same admin mount, so it inherits the
 * bearer gate automatically (the shell is served, the app renders these inlined
 * guides client-side — no extra data-API call).
 */
function Docs() {
  const [query, setQuery] = useState("");
  const [activeSlug, setActiveSlug] = useState<string | null>(
    GUIDES[0]?.slug ?? null,
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return GUIDES;
    }
    return GUIDES.filter(
      (g) =>
        g.title.toLowerCase().includes(q) ||
        g.description?.toLowerCase().includes(q),
    );
  }, [query]);

  const active = useMemo(
    () => GUIDES.find((g) => g.slug === activeSlug) ?? filtered[0] ?? GUIDES[0],
    [activeSlug, filtered],
  );

  if (GUIDES.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <p className="text-sm text-muted-foreground">No guides found.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-canvas" data-testid="docs">
      {/* Sub-nav: search + guide list */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-canvas-border bg-background">
        <div className="border-b border-canvas-border p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <BookOpen className="size-3.5" />
            Guides
          </div>
          <Input
            size="sm"
            placeholder="Search guides…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            leadingIcon={<Search />}
            aria-label="Search guides"
            data-testid="docs-search"
          />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              No guides match “{query}”.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((g) => {
                const isActive = g.slug === active?.slug;
                return (
                  <li key={g.slug}>
                    <button
                      type="button"
                      onClick={() => setActiveSlug(g.slug)}
                      data-testid={`docs-nav-${g.slug}`}
                      data-state={isActive ? "active" : undefined}
                      className={cn(
                        "w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                        isActive
                          ? "bg-accent font-medium text-[#2f9e91] dark:text-[#5fc7ba]"
                          : "text-foreground/80 hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      {g.title}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      </aside>

      {/* Rendered guide */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {active && (
          <article className="px-8 py-6" data-testid="docs-content">
            {active.description && (
              <p className="mb-6 text-sm text-muted-foreground">
                {active.description}
              </p>
            )}
            <GuideMarkdown body={`# ${active.title}\n\n${active.body}`} />
          </article>
        )}
      </div>
    </div>
  );
}

export default Docs;
