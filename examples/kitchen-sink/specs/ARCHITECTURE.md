# Northwind Kitchen-Sink — Architecture

Mirrors the sibling-mock file pattern.

```
examples/kitchen-sink/
├── package.json          # type:module, node>=22; enpilink + @enpilink/console workspace deps
├── tsconfig.json         # extends "enpilink/tsconfig", @/* path alias, includes .enpilink/**/*.d.ts
├── vite.config.ts        # enpilink() + react() + tailwindcss(); @ alias
├── vitest.config.ts      # node env, @ alias, src/**/*.test.ts
├── src/
│   ├── server.ts         # ONE McpServer, chained .registerTool(), TOOL_MODES map, exports AppType
│   ├── helpers.ts        # generateHelpers<AppType>() → useToolInfo/useCallTool; re-exports useSendFollowUpMessage/useNotify/useIntent
│   ├── index.css         # enpitech purple brand vars + full-bleed frame bg + Ubuntu
│   ├── assets.d.ts       # ambient *.png/*.svg module so tsc imports the logo
│   ├── assets/enpitech-logo.png   # the only real logo image ("powered by Enpitech")
│   ├── data/index.ts     # deterministic mock data (Northwind products/orders/customer), frozen TODAY, stable ids, no RNG
│   ├── domain/           # pure deterministic logic + colocated *.test.ts
│   │   ├── catalog.ts / catalog.test.ts   # filter/sort/price/quoteCart/summarizeOrders
│   │   ├── auth.ts / auth.test.ts         # mock OTP verify
│   │   └── id.ts                          # FNV-1a stable id helpers
│   └── views/            # one view per tool + theme/
│       ├── home / catalog / product / cart / checkout / orders / account / signin / features (.tsx)
│       └── theme/        # brand.ts (tokens), primitives.tsx (Frame/Card/Button/Badge/Stat/SectionTitle), Logo.tsx (wordmark + PoweredByEnpitech)
├── specs/                # PLAN / CONTEXT / BRAND / ARCHITECTURE / DEMO / SYSTEM_PROMPT / EXAMPLES + assets/
└── README.md
```

## Server conventions
- One `McpServer`, tools **chained** with `.registerTool()` (required for view-type
  inference — `.enpilink/views.d.ts` narrows `ViewName`).
- Each handler returns BOTH `structuredContent` (typed, for the view) and
  `content` (text, for the model), registered with a `view: { component }`.
- Tools that a view calls via `useCallTool` carry
  `_meta: { "openai/widgetAccessible": true }` (`WIDGET_ACCESSIBLE`).
- `TOOL_MODES` is an app-level metadata table (`any`/`auth`); enpilink's
  `registerTool` has no `mode` field. Nothing is hard-gated in this demo.

## View conventions
- Views import all in-widget hooks from `@/helpers.js` (typed `useToolInfo` /
  `useCallTool`, plus the re-exported `useSendFollowUpMessage` / `useNotify` /
  `useIntent`) — except the no-AppType host hooks (`useViewState`,
  `useDisplayMode`, `useRequestModal`, `useRequestSize`, `useFiles`,
  `useDownload`, `useUser`, `useOpenExternal`) which come from `enpilink/web`.
- `useNotify` / `useIntent` are async + best-effort and **never throw** (no status
  object, no `.catch` needed).

## Build note
`enpilink build` compiles the server with `tsc -b`, which does **not** rewrite
`@/` path aliases in the emitted server JS. So the build script is
`enpilink build && tsc-alias -p tsconfig.json` — `tsc-alias` rewrites `@/…` to
relative paths in `dist/` so `node dist/__entry.js` resolves the server's data/
domain imports. (Views go through Vite, where the alias already works.)
The prod entry reads the port from `__PORT` (default 3000).
