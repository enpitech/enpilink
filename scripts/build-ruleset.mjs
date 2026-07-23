#!/usr/bin/env node
/**
 * Build the enpitech detection-ruleset artifact from the maintained corpus and
 * emit the static JSON ready to upload to the CDN (D3).
 *
 * WHAT IS CODE vs WHAT IS A DEPLOY STEP:
 *   - CODE (this script + `packages/core/.../ruleset/publish.ts`): assemble the
 *     corpus, compute a content-addressed version, VALIDATE, and write the file.
 *   - DEPLOY (an ops step, NOT code): upload the emitted `dist/ruleset/v1.json`
 *     to the public CDN at `https://cdn.enpitech.dev/agent/ruleset/v1.json` with
 *     the `Cache-Control` you want (the central freshness dial). Clients fetch
 *     that stable URL; the artifact's `version` FIELD changes on each data change.
 *
 * ADDING A NEW AGENT SIGNATURE (the whole point):
 *   1. Edit the corpus in ONE place — `packages/core/src/server/agent/ruleset/
 *      initial.ts` (a new `uaPatterns`/`shapeRules` entry, or an
 *      `ipRanges.familyToVendor` mapping).
 *   2. `pnpm -F enpilink build` (compile the corpus), then `pnpm build:ruleset`.
 *   3. The version bumps AUTOMATICALLY (it embeds a hash of the data), so
 *      backfill re-classifies existing rows once clients fetch the new artifact.
 *   4. Upload the emitted file (the deploy step above).
 *
 * THE #1 RULE (backfill fires only on a `version` change) is enforced
 * structurally: the version is content-addressed, and this script re-checks that
 * the emitted `version` still encodes its content (`assertVersionMatchesContent`)
 * AND that an unchanged version never ships changed bytes (the latest.json diff).
 *
 * Usage: node scripts/build-ruleset.mjs   (run after `pnpm -F enpilink build`)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const __dirname = dirname(new URL(import.meta.url).pathname);
const rootDir = dirname(__dirname);

const PUBLISH_DIST = join(
  rootDir,
  "packages/core/dist/server/agent/ruleset/publish.js",
);
if (!existsSync(PUBLISH_DIST)) {
  console.error(
    "Error: packages/core/dist is missing. Build core first:\n" +
      "  pnpm -F enpilink build\n" +
      "then re-run: pnpm build:ruleset",
  );
  process.exit(1);
}

const { buildRulesetArtifact, assertVersionMatchesContent, ARTIFACT_SCHEMA_VERSION } =
  await import(pathToFileURL(PUBLISH_DIST).href);

const art = buildRulesetArtifact();

// Belt-and-braces: the freshly stamped artifact MUST satisfy the #1-rule guard.
assertVersionMatchesContent(art.body);

const outDir = join(rootDir, "dist", "ruleset");
mkdirSync(join(outDir, "by-version"), { recursive: true });

const stablePath = join(outDir, art.filename); // e.g. dist/ruleset/v1.json
const archivePath = join(outDir, "by-version", `${art.version}.json`);
const manifestPath = join(outDir, "manifest.json");
const latestPath = join(outDir, "latest.json");

// #1-RULE CROSS-RUN GUARD: a previously published version must never map to
// DIFFERENT bytes. With content-addressed versions this can only trip on a
// corrupted/hand-edited artifact — which is exactly what we want to catch loudly.
if (existsSync(latestPath)) {
  try {
    const prev = JSON.parse(readFileSync(latestPath, "utf8"));
    if (prev.version === art.version && prev.json !== art.json) {
      console.error(
        `Error: version "${art.version}" was already published with DIFFERENT ` +
          "content. A data change must bump the version (re-run after editing " +
          "the corpus). Refusing to publish.",
      );
      process.exit(1);
    }
    if (prev.version === art.version) {
      console.log(`No data change — version ${art.version} is up to date.`);
    }
  } catch {
    // A corrupt latest.json is not fatal; we overwrite it below.
  }
}

const manifest = {
  schemaVersion: ARTIFACT_SCHEMA_VERSION,
  version: art.version,
  filename: art.filename,
  bytes: Buffer.byteLength(art.json, "utf8"),
  generatedAt: new Date().toISOString(),
};

writeFileSync(stablePath, art.json);
writeFileSync(archivePath, art.json);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
// latest.json keeps the raw JSON alongside the version so the cross-run guard
// above can diff bytes without re-reading the emitted file.
writeFileSync(
  latestPath,
  `${JSON.stringify({ version: art.version, json: art.json }, null, 2)}\n`,
);

console.log(`Built ruleset artifact:`);
console.log(`  version:  ${art.version}`);
console.log(`  file:     dist/ruleset/${art.filename}  (${manifest.bytes} bytes)`);
console.log(`  archive:  dist/ruleset/by-version/${art.version}.json`);
console.log(`  manifest: dist/ruleset/manifest.json`);
console.log("");
console.log("DEPLOY (ops step, not code): upload dist/ruleset/" + art.filename);
console.log(
  "  → https://cdn.enpitech.dev/agent/ruleset/" +
    art.filename +
    "  with your Cache-Control.",
);
