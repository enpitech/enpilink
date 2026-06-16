#!/usr/bin/env node
/**
 * Update enpilink, @enpilink/console, and enpitech versions
 * in template and example apps
 *
 * Usage:
 *   node scripts/bump.js          # Uses latest published versions
 *   node scripts/bump.js 0.30.0   # Uses specific enpilink version
 */
import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);

function getVersion(packageName, expectedVersion, timeoutMs = 10_000) {
  if (!expectedVersion) {
    try {
      return execSync(`npm view ${packageName} version`, {
        encoding: "utf8",
      }).trim();
    } catch {
      console.error(
        `Error: Could not fetch latest version of ${packageName}. Aborting.`,
      );
      process.exit(1);
    }
  }

  let latest;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      latest = execSync(`npm view ${packageName} version`, {
        encoding: "utf8",
      }).trim();
    } catch {
      // no-op
    }
    if (latest === expectedVersion) {
      return latest;
    }
    console.log(
      `Waiting for ${packageName}@${expectedVersion} on npm (got ${latest ?? "error"})…`,
    );
    execSync("sleep 1");
  }

  if (!latest) {
    console.error(
      `Error: Could not fetch latest version of ${packageName}. Aborting.`,
    );
    process.exit(1);
  }

  console.error(
    `Timed out waiting for ${packageName}@${expectedVersion}, using ${latest}`,
  );
  return latest;
}

const explicitVersion = process.argv[2];
const enpilinkVersion = getVersion("enpilink", explicitVersion);
const consoleVersion = getVersion("@enpilink/console", explicitVersion);
const enpitechVersion = getVersion("enpitech");

const enpilinkRange = `^${enpilinkVersion}`;
const consoleRange = consoleVersion ? `^${consoleVersion}` : null;
const enpitechRange = enpitechVersion ? `^${enpitechVersion}` : null;

console.log(`enpilink:          ${enpilinkRange}`);
if (consoleRange) {
  console.log(`@enpilink/console: ${consoleRange}`);
}
if (enpitechRange) {
  console.log(`enpitech:               ${enpitechRange}`);
}

// Find all example package.json files dynamically
const exampleTargets = [];
for (const dirEntry of readdirSync(join(rootDir, "examples"), {
  withFileTypes: true,
})) {
  const packagePath = `examples/${dirEntry.name}/package.json`;
  if (dirEntry.isDirectory() && existsSync(join(rootDir, packagePath))) {
    exampleTargets.push(packagePath);
  }
}

const targets = [
  "packages/create-enpilink/templates/demo/package.json",
  "packages/create-enpilink/templates/blank/package.json",
  ...exampleTargets,
];

// Update @enpilink/console peer dependency in core package
if (consoleRange) {
  const corePackagePath = join(rootDir, "packages/core/package.json");
  if (existsSync(corePackagePath)) {
    const corePkg = JSON.parse(readFileSync(corePackagePath, "utf8"));
    if (corePkg.peerDependencies?.["@enpilink/console"]) {
      console.log("Updating: packages/core/package.json (peerDependencies)");
      corePkg.peerDependencies["@enpilink/console"] = consoleRange;
      writeFileSync(corePackagePath, JSON.stringify(corePkg, null, 2) + "\n");
    }
  }
}

for (const target of targets) {
  const file = join(rootDir, target);

  if (!existsSync(file)) {
    console.log(`Skipping (not found): ${target}`);
    continue;
  }

  console.log(`Updating: ${target}`);

  const pkg = JSON.parse(readFileSync(file, "utf8"));

  if (
    pkg.dependencies?.enpilink &&
    !pkg.dependencies.enpilink.startsWith("workspace:")
  ) {
    pkg.dependencies.enpilink = enpilinkRange;
  }

  if (
    consoleRange &&
    pkg.devDependencies?.["@enpilink/console"] &&
    !pkg.devDependencies["@enpilink/console"].startsWith("workspace:")
  ) {
    pkg.devDependencies["@enpilink/console"] = consoleRange;
  }

  if (enpitechRange && pkg.devDependencies?.enpitech) {
    pkg.devDependencies.enpitech = enpitechRange;
  }

  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
}

console.log("\nDone.");
