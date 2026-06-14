/**
 * Northwind brand tokens — the single source of truth referenced by the theme
 * primitives. The demo brand ("Northwind") is generic; the *framework*
 * attribution is enpitech, so the palette is enpitech's purple gradient.
 *
 * These mirror the CSS vars in `src/index.css`. Prefer Tailwind classes that
 * read the vars (e.g. `bg-primary`, `text-foreground`); use these raw tokens
 * only where an inline style needs a literal (e.g. the brand gradient).
 */
export const brand = {
  name: "Northwind",
  tagline: "Coffee, tea & good things — the demo store.",
  gradient: "linear-gradient(135deg, #4A00E0 0%, #8E2DE2 100%)",
  purple1: "#4A00E0",
  purple2: "#8E2DE2",
  border: "#8F2EE3",
  soft: "#BB81EE",
} as const;
