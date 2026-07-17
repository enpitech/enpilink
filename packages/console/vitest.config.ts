import { defineConfig } from "vitest/config";

/**
 * Console unit tests (M5). The console is primarily typechecked (tsc) +
 * lint-gated (biome) + e2e-driven (playwright); this adds a light vitest lane
 * for pure logic — e.g. the agent-telemetry zod schema — that is cheaper to
 * cover as a unit test than an e2e. Mirrors the config used by `packages/core`
 * and `create-enpilink`. Test files live at `src/**\/*.test.ts` and are excluded
 * from the production `tsc -b` build (see `tsconfig.app.json`).
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
