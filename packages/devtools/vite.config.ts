import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // The Docs tab imports the repo's `docs/guides/*.mdx` at build time via
    // `import.meta.glob` (see `components/layout/docs/guides.ts`). Those files
    // live OUTSIDE this package (at the monorepo root), so the dev server must
    // be allowed to read from two levels up. `import.meta.glob` resolves at
    // transform time in `vite build`, so the prod bundle inlines the guides
    // and the Docs tab works in the prod admin too (no runtime file access).
    fs: {
      allow: [path.resolve(__dirname, "../..")],
    },
    proxy: {
      "/__enpilink": {
        target: new URL(
          process.env.VITE_MCP_SERVER_URL || "http://localhost:3000",
        ).origin,
        changeOrigin: true,
      },
    },
  },
});
