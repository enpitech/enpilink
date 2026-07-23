import { describe, expect, it } from "vitest";
import type { HeaderPair } from "../../storage/types.js";
import { classify } from "../detect.js";
import { INITIAL_RULESET } from "./initial.js";
import {
  EdgeRulesetValidationError,
  parseRulesetEdge,
  safeParseRulesetEdge,
} from "./validate-edge.js";

/** The initial ruleset as it arrives off the wire — a plain JSON object. */
function wireArtifact(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(INITIAL_RULESET)) as Record<string, unknown>;
}

/** A ChatGPT-User request (no Sec-Fetch — a one-shot chat fetcher). */
const CHATGPT_HEADERS: HeaderPair[] = [
  [
    "User-Agent",
    "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com)",
  ],
  ["Accept", "*/*"],
];

describe("parseRulesetEdge (zod-free edge validator)", () => {
  it("accepts a real artifact and returns a usable Ruleset", () => {
    const rs = parseRulesetEdge(wireArtifact());
    expect(rs.version).toBe(INITIAL_RULESET.version);
    expect(rs.uaPatterns.length).toBe(INITIAL_RULESET.uaPatterns.length);
    expect(rs.shapeRules.length).toBe(INITIAL_RULESET.shapeRules.length);
  });

  it("classifies BYTE-IDENTICALLY to the zod-validated ruleset", () => {
    const edgeRuleset = parseRulesetEdge(wireArtifact());
    const viaEdge = classify(edgeRuleset, CHATGPT_HEADERS);
    const viaNode = classify(INITIAL_RULESET, CHATGPT_HEADERS);
    expect(viaEdge.family).toBe(viaNode.family);
    expect(viaEdge.class).toBe(viaNode.class);
    expect(viaEdge.confidence).toBe(viaNode.confidence);
    expect(viaEdge.family).toBe("chatgpt-user");
    expect(viaEdge.class).toBe("chat-fetcher");
  });

  it('defaults a UA pattern\'s `flags` to "i" when the artifact omits it', () => {
    const artifact = wireArtifact();
    // A minimal valid artifact whose one UA rule has NO flags field.
    const minimal = {
      version: "test-1",
      uaPatterns: [
        {
          id: "gptbot",
          pattern: "GPTBot",
          family: "gptbot",
          class: "crawler",
          confidence: "ua-only",
        },
      ],
      shapeRules: (artifact.shapeRules as unknown[]).slice(-1),
      ipRanges: { vendorLists: {}, familyToVendor: {} },
    };
    const rs = parseRulesetEdge(minimal);
    expect(rs.uaPatterns[0]?.flags).toBe("i");
    // And a lowercase UA still matches (case-insensitive via the defaulted flag).
    expect(classify(rs, [["User-Agent", "gptbot/1.0"]]).family).toBe("gptbot");
  });

  it("is lenient about a missing/malformed ipRanges (the edge never reads it)", () => {
    const artifact = wireArtifact();
    Reflect.deleteProperty(artifact, "ipRanges");
    const rs = parseRulesetEdge(artifact);
    expect(rs.ipRanges).toEqual({ vendorLists: {}, familyToVendor: {} });
  });

  it("REJECTS a corrupt artifact instead of crashing the classifier", () => {
    expect(() => parseRulesetEdge(null)).toThrow(EdgeRulesetValidationError);
    expect(() => parseRulesetEdge({})).toThrow(/version/);
    expect(() =>
      parseRulesetEdge({ version: "", uaPatterns: [], shapeRules: [] }),
    ).toThrow(/version/);
    expect(() =>
      parseRulesetEdge({ version: "v", uaPatterns: {}, shapeRules: [] }),
    ).toThrow(/uaPatterns/);
    // A UA rule with an unknown class.
    expect(() =>
      parseRulesetEdge({
        version: "v",
        uaPatterns: [
          {
            id: "x",
            pattern: "X",
            family: "x",
            class: "wizard",
            confidence: "ua-only",
          },
        ],
        shapeRules: [],
      }),
    ).toThrow(/class/);
    // A UA rule whose regex does not compile.
    expect(() =>
      parseRulesetEdge({
        version: "v",
        uaPatterns: [
          {
            id: "x",
            pattern: "(",
            family: "x",
            class: "crawler",
            confidence: "ua-only",
          },
        ],
        shapeRules: [],
      }),
    ).toThrow(/compile/);
    // A shape rule with an unknown `when`.
    expect(() =>
      parseRulesetEdge({
        version: "v",
        uaPatterns: [],
        shapeRules: [
          {
            id: "x",
            when: "moon-phase",
            family: null,
            class: "unknown",
            confidence: "none",
          },
        ],
      }),
    ).toThrow(/when/);
  });

  it("safeParseRulesetEdge NEVER throws — it degrades to { ok: false }", () => {
    const good = safeParseRulesetEdge(wireArtifact());
    expect(good.ok).toBe(true);

    const bad = safeParseRulesetEdge({ version: 42 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toBeInstanceOf(EdgeRulesetValidationError);
    }
    // Even a wildly wrong input (a function, a symbol container) never throws.
    expect(() => safeParseRulesetEdge(() => {})).not.toThrow();
    expect(safeParseRulesetEdge(Symbol("x") as unknown).ok).toBe(false);
  });
});
