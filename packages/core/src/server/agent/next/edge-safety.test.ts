import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE edge-safety guarantee (M8): the `enpilink/next` entry, and everything it
 * transitively pulls in AT RUNTIME, must import NO `node:*`, NO Express, NO
 * storage adapter, NO `better-sqlite3`/`pg` — otherwise Next's edge bundler
 * fails (or silently ships a broken middleware). Types don't count: a
 * statement-level `import type` is fully erased under `verbatimModuleSyntax`, so
 * the pure `capture.ts`/`detect.ts` can reference `storage/types.js` for TYPES
 * without loading it at runtime.
 *
 * This test statically walks the RUNTIME import graph from `next/index.ts`
 * (following relative value-imports, skipping `import type`) and asserts nothing
 * forbidden is reachable. It scans SOURCE (not `dist`), so it runs in the unit
 * lane before any build.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "index.ts");

/** Bare specifiers that must never appear in the edge runtime graph. */
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

/** Resolved relative files whose presence in the edge graph is a Node leak. */
const FORBIDDEN_PATH_SUBSTRINGS = [
  "/storage/",
  "/config/",
  "log-sink",
  "express-middleware",
  "agent/ingest",
  "agent/route",
  "response-transform",
  "/transports/",
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

describe("enpilink/next edge-safety", () => {
  const { bare, files } = walk(ENTRY);

  it("pulls in NO forbidden bare module (node:*, express, sqlite, pg, …)", () => {
    const offenders = [...bare].filter((spec) =>
      FORBIDDEN_BARE.some((re) => re.test(spec)),
    );
    expect(
      offenders,
      `forbidden bare imports: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("pulls in NO Node-only source file (storage, config, express adapter, …)", () => {
    const offenders = [...files].filter((f) =>
      FORBIDDEN_PATH_SUBSTRINGS.some((sub) => f.includes(sub)),
    );
    expect(
      offenders,
      `forbidden runtime files: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("reaches only the pure edge core (capture-edge, beacon, capture, detect)", () => {
    // Sanity: the graph is exactly the entry + the 4 pure modules — no surprises.
    const basenames = [...files].map((f) => f.split("/agent/")[1] ?? f).sort();
    expect(basenames).toEqual([
      "capture.ts",
      "detect.ts",
      "edge/beacon.ts",
      "edge/capture-edge.ts",
      "next/index.ts",
    ]);
  });
});
