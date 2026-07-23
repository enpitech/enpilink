import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE edge-safety guarantee (M8, extended for D4b): EVERY edge entry point — the
 * `enpilink/next` middleware, the `enpilink/cloudflare` Worker adapter, and the
 * edge ruleset client — and everything each transitively pulls in AT RUNTIME must
 * import NO `node:*`, NO Express, NO storage adapter, NO `better-sqlite3`/`pg`, and
 * crucially NO `zod` (the ruleset schema) — otherwise the edge bundler fails (or
 * silently ships a broken adapter). Types don't count: a statement-level
 * `import type` / `export type` is fully erased under `verbatimModuleSyntax`, so a
 * pure module can reference `storage/types.js` / `ruleset/types.js` for TYPES
 * without loading them at runtime.
 *
 * This test statically walks the RUNTIME import graph from EACH edge entry
 * (following relative value-imports, skipping `import type`) and asserts nothing
 * forbidden is reachable, plus an EXACT reachable-module snapshot for the three
 * headline entries so a new import can never sneak a Node dep in unnoticed. It
 * scans SOURCE (not `dist`), so it runs in the unit lane before any build.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Bare specifiers that must never appear in ANY edge runtime graph. */
const FORBIDDEN_BARE = [
  /^node:/,
  /^express$/,
  /^better-sqlite3$/,
  /^pg$/,
  /^@modelcontextprotocol\//,
  /^handlebars$/,
  /^jose$/,
  /^zod$/,
  /^fs$/,
  /^path$/,
  /^crypto$/,
  /^os$/,
  /^net$/,
];

/** Resolved relative files whose presence in an edge graph is a Node leak. */
const FORBIDDEN_PATH_SUBSTRINGS = [
  "/storage/",
  "/config/",
  "log-sink",
  "express-middleware",
  "agent/ingest",
  "agent/route",
  "agent/represent.ts",
  "response-transform",
  "/transports/",
  "ruleset/client",
  "ruleset/bootstrap",
  "ruleset/disk-cache",
  "ruleset/schema",
  "ruleset/publish",
  "ruleset/serve-router",
  "ruleset/holder",
  "ruleset/initial",
  "adapter/core",
];

/** Strip block + full-line comments so `@example` imports in JSDoc don't count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

interface Deps {
  /** Bare (non-relative) runtime specifiers. */
  bare: string[];
  /** Relative runtime specifiers (unresolved, `.js`). */
  relative: string[];
}

/** Extract RUNTIME import specifiers from a source file (skips `import type`). */
function runtimeImports(src: string): Deps {
  const clean = stripComments(src);
  const bare: string[] = [];
  const relative: string[] = [];
  const fromRe =
    /(?<kw>import|export)\s+(?<rest>[^;]*?)\sfrom\s*["'](?<spec>[^"']+)["']/g;
  const bareSideEffectRe = /(?<!\.)\bimport\s*["'](?<spec>[^"']+)["']/g;
  const dynRe = /import\(\s*["'](?<spec>[^"']+)["']\s*\)/g;

  for (const m of clean.matchAll(fromRe)) {
    const rest = m.groups?.rest ?? "";
    // Statement-level `import type ...` / `export type ...` is erased.
    if (/^type\b/.test(rest.trim())) {
      continue;
    }
    push(m.groups?.spec ?? "");
  }
  for (const m of clean.matchAll(bareSideEffectRe)) {
    push(m.groups?.spec ?? "");
  }
  for (const m of clean.matchAll(dynRe)) {
    push(m.groups?.spec ?? "");
  }
  return { bare, relative };

  function push(spec: string): void {
    if (spec === "") {
      return;
    }
    if (spec.startsWith(".")) {
      relative.push(spec);
    } else {
      bare.push(spec);
    }
  }
}

/** Walk the runtime graph from `entry`, collecting every reachable specifier. */
function walk(entry: string): { bare: Set<string>; files: Set<string> } {
  const bare = new Set<string>();
  const files = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    const src = readFileSync(file, "utf8");
    const { bare: b, relative } = runtimeImports(src);
    for (const s of b) {
      bare.add(s);
    }
    for (const rel of relative) {
      // Imports use `.js`; the source is `.ts`. Resolve next to the importer.
      const resolved = resolve(dirname(file), rel.replace(/\.js$/, ".ts"));
      stack.push(resolved);
    }
  }
  return { bare, files };
}

/** Basenames (relative to `/agent/`) of every file in a graph, sorted. */
function basenamesOf(files: Set<string>): string[] {
  return [...files].map((f) => f.split("/agent/")[1] ?? f).sort();
}

/** Every edge entry point that must stay Node-free. */
const ENTRIES: { name: string; entry: string }[] = [
  { name: "enpilink/next", entry: resolve(HERE, "index.ts") },
  {
    name: "enpilink/cloudflare",
    entry: resolve(HERE, "../cloudflare/index.ts"),
  },
  {
    name: "cloudflare/sink",
    entry: resolve(HERE, "../cloudflare/sink.ts"),
  },
  { name: "cloudflare/d1", entry: resolve(HERE, "../cloudflare/d1.ts") },
  {
    name: "ruleset/edge-client",
    entry: resolve(HERE, "../ruleset/edge-client.ts"),
  },
  {
    name: "ruleset/edge-cache",
    entry: resolve(HERE, "../ruleset/edge-cache.ts"),
  },
  {
    name: "ruleset/validate-edge",
    entry: resolve(HERE, "../ruleset/validate-edge.ts"),
  },
  {
    name: "serve-eligibility",
    entry: resolve(HERE, "../serve-eligibility.ts"),
  },
  { name: "represent-core", entry: resolve(HERE, "../represent-core.ts") },
];

describe("edge-safety: every edge entry stays Node-free", () => {
  for (const { name, entry } of ENTRIES) {
    describe(name, () => {
      const { bare, files } = walk(entry);

      it("pulls in NO forbidden bare module (node:*, express, sqlite, pg, zod, …)", () => {
        const offenders = [...bare].filter((spec) =>
          FORBIDDEN_BARE.some((re) => re.test(spec)),
        );
        expect(
          offenders,
          `${name} forbidden bare imports: ${offenders.join(", ")}`,
        ).toEqual([]);
      });

      it("pulls in NO Node-only source file (storage, config, route, zod schema, …)", () => {
        const offenders = [...files].filter((f) =>
          FORBIDDEN_PATH_SUBSTRINGS.some((sub) => f.includes(sub)),
        );
        expect(
          offenders,
          `${name} forbidden runtime files: ${offenders.join(", ")}`,
        ).toEqual([]);
      });
    });
  }
});

describe("edge-safety: exact reachable-module snapshots", () => {
  it("enpilink/next reaches only the pure capture + edge-ruleset-client core", () => {
    const { files } = walk(resolve(HERE, "index.ts"));
    expect(basenamesOf(files)).toEqual([
      "capture.ts",
      "detect.ts",
      "edge/beacon.ts",
      "edge/capture-edge.ts",
      "next/index.ts",
      "ruleset/edge-cache.ts",
      "ruleset/edge-client.ts",
      "ruleset/validate-edge.ts",
    ]);
  });

  it("enpilink/cloudflare reaches only the pure Worker core (capture, serve, ruleset, sinks)", () => {
    const { files } = walk(resolve(HERE, "../cloudflare/index.ts"));
    expect(basenamesOf(files)).toEqual([
      "capture.ts",
      "cloudflare/d1.ts",
      "cloudflare/index.ts",
      "cloudflare/sink.ts",
      "detect.ts",
      "edge/beacon.ts",
      "edge/capture-edge.ts",
      "html-to-markdown.ts",
      "represent-core.ts",
      "ruleset/edge-cache.ts",
      "ruleset/edge-client.ts",
      "ruleset/validate-edge.ts",
      "serve-eligibility.ts",
    ]);
  });

  it("the edge ruleset client reaches only the zod-free validator + cache stores", () => {
    const { files } = walk(resolve(HERE, "../ruleset/edge-client.ts"));
    expect(basenamesOf(files)).toEqual([
      "ruleset/edge-cache.ts",
      "ruleset/edge-client.ts",
      "ruleset/validate-edge.ts",
    ]);
  });
});
