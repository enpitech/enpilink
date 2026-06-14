import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Primes the manifest in enpilink's module scope, then dynamically imports
// `./server.js` so user code runs *after* the side channel is set. The
// dynamic import is load-bearing: a static `export { default } from ...` is
// hoisted with the rest of the static graph and would evaluate `server.js`
// before `__setBuildManifest` runs.
export const ENTRY_WRAPPER_CONTENT = `import { __setBuildManifest } from "enpilink/server";
import manifest from "./vite-manifest.js";

__setBuildManifest(manifest);

const userMod = await import("./server.js");
export default userMod.default;
`;

export function emitEntryWrapper(distDir: string): void {
  writeFileSync(path.join(distDir, "__entry.js"), ENTRY_WRAPPER_CONTENT);
}

export function emitManifestModule(
  manifestPath: string,
  outPath: string,
): void {
  const manifest = readFileSync(manifestPath, "utf-8");
  writeFileSync(outPath, `export default ${manifest};\n`);
}

// Rewrites TypeScript path aliases (e.g. `@/data` → `./data`) in the emitted
// server JS under `dist/`. `tsc` itself does NOT rewrite path aliases in the
// output, so a server that imports via `@/…` would throw ERR_MODULE_NOT_FOUND
// at `node dist/__entry.js`. We run tsc-alias programmatically against the
// project's tsconfig so `enpilink build` produces a runnable server regardless
// of whether the user uses path aliases — no `tsc-alias` in their own scripts.
//
// Safe to run unconditionally: tsc-alias uses TypeScript's own config parser
// and is a no-op when the project declares no `paths`. We only require a
// tsconfig.json to exist (it always does for an enpilink app).
export async function rewriteServerAliases(root: string): Promise<void> {
  const configFile = path.join(root, "tsconfig.json");
  if (!existsSync(configFile)) {
    return;
  }
  const { replaceTscAliasPaths } = await import("tsc-alias");
  await replaceTscAliasPaths({
    configFile,
    // The server's compiled JS lives in `dist/` (tsc `outDir`); rewrite aliases
    // to relative imports there.
    outDir: path.join(root, "dist"),
  });
}

export const VERCEL_FUNCTION_NAME = "mcp";

export const VERCEL_CONFIG: unknown = {
  version: 3,
  routes: [
    {
      src: "/assets/(.*)",
      headers: { "Access-Control-Allow-Origin": "*" },
      continue: true,
    },
    { handle: "filesystem" },
    { src: "/(.*)", dest: `/${VERCEL_FUNCTION_NAME}` },
  ],
};

export const VERCEL_VC_CONFIG: unknown = {
  runtime: "nodejs22.x",
  handler: "index.js",
  launcherType: "Nodejs",
  shouldAddHelpers: true,
};

// Emit a Build Output API tree under `.vercel/output/`. Bundling the server
// with esbuild produces a self-contained function bundle, so we don't ship
// `node_modules` and don't touch tracked paths like `api/` or `public/`.
//
// Entry is `dist/__entry.js` — the wrapper that primes the Vite manifest via
// `__setBuildManifest` before importing user code. Bundling `dist/server.js`
// directly would skip that priming and 500 on view resource reads when the
// function falls back to `readFileSync('dist/assets/.vite/manifest.json')`
// (Vercel functions don't ship `dist/`).
export async function emitVercelBuildOutput(root: string): Promise<void> {
  const outputDir = path.join(root, ".vercel", "output");
  const funcDir = path.join(
    outputDir,
    "functions",
    `${VERCEL_FUNCTION_NAME}.func`,
  );
  const staticAssetsDir = path.join(outputDir, "static", "assets");

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(funcDir, { recursive: true });

  const { build } = await import("esbuild");
  await build({
    entryPoints: [path.join(root, "dist", "__entry.js")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: path.join(funcDir, "index.js"),
    // Lets esbuild DCE dev-only branches that pull in vite/devtools.
    define: { "process.env.NODE_ENV": '"production"' },
    // Dev-only deps reachable from re-exports; safe to leave unresolved since
    // the code paths that touch them are eliminated by the NODE_ENV define.
    external: ["vite", "@enpilink/devtools"],
    banner: {
      // ESM bundles miss CJS interop globals that some deps reach for.
      js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
    },
  });

  writeFileSync(
    path.join(funcDir, ".vc-config.json"),
    `${JSON.stringify(VERCEL_VC_CONFIG, null, 2)}\n`,
  );
  writeFileSync(
    path.join(funcDir, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  );

  cpSync(path.join(root, "dist", "assets"), staticAssetsDir, {
    recursive: true,
  });

  writeFileSync(
    path.join(outputDir, "config.json"),
    `${JSON.stringify(VERCEL_CONFIG, null, 2)}\n`,
  );
}
