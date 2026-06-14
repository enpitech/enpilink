# Northwind Kitchen-Sink — Brand

The demo brand is generic; the **framework** attribution is enpitech, so the
palette is enpitech's. Tokens live in `src/views/theme/brand.ts` and the CSS
vars in `src/index.css`. Views compose from the primitives in
`src/views/theme/primitives.tsx` — do not hardcode colors per view.

## Palette (enpitech)
- Primary gradient: **`#4A00E0` → `#8E2DE2`** (purple). Border/accent `#8F2EE3`,
  soft `#BB81EE`.
- Light: background `#F8F8FC`, card `#FFFFFF`, body text `#1E1645`.
- Dark: background `#090715`, card `#130C38`, body `#F4F1FB`.
- Semantic: success `#1AAE6F`, warning/accent `#FF941F`, danger `#E5484D`.
- Font: **Ubuntu** (`--font-sans`).

## Branding rule (from the repo CONTEXT.md)
- **enpilink** is shown as a **plain text wordmark** — never a fabricated icon.
- The only real logo image is the **Enpitech** mark
  (`src/assets/enpitech-logo.png`), used as a "powered by Enpitech" badge
  (`PoweredByEnpitech` in `src/views/theme/Logo.tsx`). A `*.png`/`*.svg` ambient
  module (`src/assets.d.ts`) lets tsc import it.
- The **Northwind** demo brand uses a simple gradient text wordmark + a coffee
  emoji (`Logo` in the same file). No fabricated marks, no avatar placeholders.
