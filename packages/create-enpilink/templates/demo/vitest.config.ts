import path from "node:path";
import { defineConfig } from "vitest/config";

// Domain logic is plain TypeScript (no DOM), so a node environment is enough.
// The `@/` alias mirrors tsconfig + vite so domain tests can import `@/...`.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
