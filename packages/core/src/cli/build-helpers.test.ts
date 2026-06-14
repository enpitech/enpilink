// @vitest-environment node
// esbuild's invariant check on TextEncoder/Uint8Array trips jsdom's polyfill.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENTRY_WRAPPER_CONTENT,
  emitEntryWrapper,
  emitManifestModule,
  emitVercelBuildOutput,
  rewriteServerAliases,
  VERCEL_CONFIG,
  VERCEL_VC_CONFIG,
} from "./build-helpers.js";

function mkTmp(prefix = "enpilink-build-helpers-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("emitEntryWrapper", () => {
  it("writes dist/__entry.js that primes the manifest before importing user code", () => {
    const dir = mkTmp();
    emitEntryWrapper(dir);
    const out = readFileSync(path.join(dir, "__entry.js"), "utf-8");
    expect(out).toBe(ENTRY_WRAPPER_CONTENT);
    expect(out).toContain(
      'import { __setBuildManifest } from "enpilink/server"',
    );
    expect(out).toContain('import manifest from "./vite-manifest.js"');
    expect(out).toContain("__setBuildManifest(manifest)");
    // Dynamic import is load-bearing: `server.js` must evaluate after the
    // setter runs, so a static re-export wouldn't work.
    expect(out).toContain('await import("./server.js")');
    expect(out).toContain("export default userMod.default");
  });
});

describe("emitManifestModule", () => {
  it("inlines the JSON manifest as an ESM default export", () => {
    const dir = mkTmp();
    const inPath = path.join(dir, "manifest.json");
    const outPath = path.join(dir, "vite-manifest.js");
    const manifest = { "src/views/foo.tsx": { file: "assets/foo-abc.js" } };
    writeFileSync(inPath, JSON.stringify(manifest));
    emitManifestModule(inPath, outPath);
    const out = readFileSync(outPath, "utf-8");
    expect(out.startsWith("export default ")).toBe(true);
    const literal = out
      .slice("export default ".length)
      .trim()
      .replace(/;$/, "");
    expect(JSON.parse(literal)).toEqual(manifest);
  });
});

describe("rewriteServerAliases", () => {
  it("rewrites `@/` path aliases to relative imports in dist server JS", async () => {
    const root = mkTmp();
    mkdirSync(path.join(root, "src", "data"), { recursive: true });
    mkdirSync(path.join(root, "dist", "data"), { recursive: true });
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          outDir: "./dist",
          rootDir: "./src",
          paths: { "@/*": ["./src/*"] },
        },
        include: ["src"],
      }),
    );
    // tsc-alias resolves aliases against the *output* tree, so the target must
    // exist in dist/ (it normally does — tsc emits it).
    writeFileSync(path.join(root, "dist", "data", "index.js"), "export {};\n");
    writeFileSync(
      path.join(root, "dist", "server.js"),
      'import { TODAY } from "@/data/index.js";\nexport default TODAY;\n',
    );

    await rewriteServerAliases(root);

    const out = readFileSync(path.join(root, "dist", "server.js"), "utf-8");
    expect(out).not.toContain("@/data");
    expect(out).toContain("./data/index.js");
  });

  it("is a no-op when the project declares no `paths`", async () => {
    const root = mkTmp();
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { outDir: "./dist" } }),
    );
    const original = 'import { x } from "./local.js";\n';
    writeFileSync(path.join(root, "dist", "server.js"), original);

    await expect(rewriteServerAliases(root)).resolves.toBeUndefined();
    expect(readFileSync(path.join(root, "dist", "server.js"), "utf-8")).toBe(
      original,
    );
  });

  it("does nothing when there is no tsconfig.json", async () => {
    const root = mkTmp();
    await expect(rewriteServerAliases(root)).resolves.toBeUndefined();
  });
});

describe("emitVercelBuildOutput", () => {
  it("emits a Build Output API tree with bundled function and static assets", async () => {
    const root = mkTmp();
    mkdirSync(path.join(root, "dist", "assets"), { recursive: true });
    writeFileSync(
      path.join(root, "dist", "server.js"),
      "export default function handler(_req, res) { res.end('ok'); }\n",
    );
    // Minimal `dist/__entry.js` (the real wrapper imports `enpilink/server`,
    // which isn't resolvable in this test's tmp dir — the function-bundling
    // contract we care about here is just "bundle whatever `__entry.js`
    // imports into a single function file").
    writeFileSync(
      path.join(root, "dist", "__entry.js"),
      "const userMod = await import('./server.js');\nexport default userMod.default;\n",
    );
    writeFileSync(
      path.join(root, "dist", "assets", "view-abc.js"),
      "/* bundled view */\n",
    );

    await emitVercelBuildOutput(root);

    const outputDir = path.join(root, ".vercel", "output");
    const funcDir = path.join(outputDir, "functions", "mcp.func");

    expect(existsSync(path.join(funcDir, "index.js"))).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(funcDir, ".vc-config.json"), "utf-8")),
    ).toEqual(VERCEL_VC_CONFIG);
    expect(
      JSON.parse(readFileSync(path.join(funcDir, "package.json"), "utf-8")),
    ).toEqual({ type: "module" });
    expect(
      JSON.parse(readFileSync(path.join(outputDir, "config.json"), "utf-8")),
    ).toEqual(VERCEL_CONFIG);
    expect(
      readFileSync(
        path.join(outputDir, "static", "assets", "view-abc.js"),
        "utf-8",
      ),
    ).toContain("bundled view");
  });
});
