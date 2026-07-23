import { describe, expect, it } from "vitest";
import { classify } from "../detect.js";
import { INITIAL_RULESET } from "./initial.js";
import {
  ARTIFACT_SCHEMA_VERSION,
  assertVersionMatchesContent,
  buildRulesetArtifact,
  RulesetVersionMismatchError,
  rulesetContentHash,
  versionFor,
} from "./publish.js";
import { parseRuleset } from "./schema.js";
import type { Ruleset } from "./types.js";

/** A corpus with one extra UA signature added — the "new agent" data change. */
function corpusWithExtraSignature(): Ruleset {
  return parseRuleset({
    ...INITIAL_RULESET,
    uaPatterns: [
      {
        id: "new-agent",
        pattern: "NewAgentBot",
        family: "new-agent",
        class: "crawler",
        confidence: "ua-only",
      },
      ...INITIAL_RULESET.uaPatterns,
    ],
  });
}

describe("buildRulesetArtifact", () => {
  it("emits a parseRuleset-valid, version-stamped artifact", () => {
    const art = buildRulesetArtifact();
    // The body validates against the D1 schema (a broken artifact is never built).
    expect(() => parseRuleset(art.body)).not.toThrow();
    // The JSON is the exact bytes we'd write/serve, and round-trips to the body.
    expect(JSON.parse(art.json)).toEqual(art.body);
    expect(art.json.endsWith("\n")).toBe(true);
    // The stable serving filename tracks the schema-major, not the content.
    expect(art.filename).toBe(`${ARTIFACT_SCHEMA_VERSION}.json`);
    expect(art.body.version).toBe(art.version);
  });

  it("stamps a CONTENT-ADDRESSED version (the #1-rule guard passes)", () => {
    const art = buildRulesetArtifact();
    expect(art.version.endsWith(rulesetContentHash(art.body))).toBe(true);
    expect(() => assertVersionMatchesContent(art.body)).not.toThrow();
  });

  it("is deterministic — same corpus yields byte-identical output", () => {
    const a = buildRulesetArtifact();
    const b = buildRulesetArtifact();
    expect(a.version).toBe(b.version);
    expect(a.json).toBe(b.json);
  });

  it("BUMPS the version when the ruleset DATA changes", () => {
    const before = buildRulesetArtifact();
    const after = buildRulesetArtifact({ corpus: corpusWithExtraSignature() });
    expect(after.version).not.toBe(before.version);
    // Only the content hash moved; the release tag prefix is unchanged.
    expect(after.version.split("-").slice(0, -1)).toEqual(
      before.version.split("-").slice(0, -1),
    );
  });

  it("does NOT change the version when only the release tag differs but data is equal", () => {
    // A same-data rebuild under a different tag changes only the prefix — the
    // hash suffix (what backfill keys on for re-classification) is stable.
    const a = buildRulesetArtifact({ releaseTag: "2026-07-23" });
    const b = buildRulesetArtifact({ releaseTag: "2099-01-01" });
    const hashA = a.version.split("-").at(-1);
    const hashB = b.version.split("-").at(-1);
    expect(hashA).toBe(hashB);
  });

  it("the built artifact classifies a known agent (it IS the real corpus)", () => {
    const art = buildRulesetArtifact();
    const det = classify(art.body, [["User-Agent", "GPTBot/1.1"]]);
    expect(det.family).toBe("gptbot");
    expect(det.class).toBe("crawler");
  });
});

describe("assertVersionMatchesContent (the #1 correctness rule)", () => {
  it("THROWS when content changed but the version did not", () => {
    const art = buildRulesetArtifact();
    // Simulate a maintainer who edited the DATA but kept the old version string.
    const tampered: Ruleset = parseRuleset({
      ...art.body,
      // keep art.body.version, but mutate a pattern's data
      uaPatterns: art.body.uaPatterns.map((p, i) =>
        i === 0 ? { ...p, pattern: `${p.pattern}-EDITED` } : p,
      ),
    });
    expect(tampered.version).toBe(art.version); // version deliberately unchanged
    expect(() => assertVersionMatchesContent(tampered)).toThrow(
      RulesetVersionMismatchError,
    );
  });

  it("passes for a freshly versioned artifact", () => {
    const art = buildRulesetArtifact({ corpus: corpusWithExtraSignature() });
    expect(() => assertVersionMatchesContent(art.body)).not.toThrow();
  });
});

describe("versionFor / rulesetContentHash", () => {
  it("is stable across key insertion order (hashes the DATA, not the layout)", () => {
    const reordered = parseRuleset({
      // Same content, different top-level key order.
      ipRanges: INITIAL_RULESET.ipRanges,
      shapeRules: INITIAL_RULESET.shapeRules,
      version: INITIAL_RULESET.version,
      uaPatterns: INITIAL_RULESET.uaPatterns,
    });
    expect(rulesetContentHash(reordered)).toBe(
      rulesetContentHash(INITIAL_RULESET),
    );
  });

  it("changes when array ORDER changes (first-match-wins is significant)", () => {
    const swapped = parseRuleset({
      ...INITIAL_RULESET,
      uaPatterns: [
        INITIAL_RULESET.uaPatterns[1],
        INITIAL_RULESET.uaPatterns[0],
        ...INITIAL_RULESET.uaPatterns.slice(2),
      ],
    });
    expect(rulesetContentHash(swapped)).not.toBe(
      rulesetContentHash(INITIAL_RULESET),
    );
  });

  it("versionFor ends with the content hash", () => {
    expect(versionFor(INITIAL_RULESET, "tag")).toBe(
      `tag-${rulesetContentHash(INITIAL_RULESET)}`,
    );
  });
});
