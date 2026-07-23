import { describe, expect, it } from "vitest";
import { getCurrentRuleset, setCurrentRuleset } from "./holder.js";
import { INITIAL_RULESET } from "./initial.js";
import {
  parseRuleset,
  RulesetValidationError,
  safeParseRuleset,
} from "./schema.js";

/** A minimal, schema-valid ruleset to mutate into invalid variants. */
const MINIMAL = {
  version: "test-1",
  uaPatterns: [
    {
      id: "foo",
      pattern: "Foo",
      family: "foo",
      class: "crawler",
      confidence: "ua-only",
    },
  ],
  shapeRules: [
    {
      id: "empty",
      when: "always",
      family: null,
      class: "unknown",
      confidence: "none",
    },
  ],
  ipRanges: { vendorLists: {}, familyToVendor: {} },
};

describe("parseRuleset — validation", () => {
  it("accepts a minimal ruleset and defaults regex flags to 'i'", () => {
    const rs = parseRuleset(MINIMAL);
    expect(rs.version).toBe("test-1");
    // `flags` is not in the input; the schema defaults it.
    expect(rs.uaPatterns[0]?.flags).toBe("i");
  });

  it("round-trips the initial ruleset (it is schema-valid)", () => {
    // INITIAL_RULESET is already parsed at import; re-parsing must not throw and
    // must preserve the version + rule counts.
    const rs = parseRuleset(INITIAL_RULESET);
    expect(rs.version).toBe(INITIAL_RULESET.version);
    expect(rs.uaPatterns.length).toBe(INITIAL_RULESET.uaPatterns.length);
    expect(rs.shapeRules.length).toBe(INITIAL_RULESET.shapeRules.length);
  });

  it("rejects a missing version", () => {
    const { version: _drop, ...noVersion } = MINIMAL;
    expect(() => parseRuleset(noVersion)).toThrow(RulesetValidationError);
  });

  it("rejects a UA pattern whose regex does not compile", () => {
    const bad = {
      ...MINIMAL,
      uaPatterns: [
        {
          id: "bad",
          pattern: "[(", // unterminated character class → SyntaxError
          family: "x",
          class: "crawler",
          confidence: "ua-only",
        },
      ],
    };
    expect(() => parseRuleset(bad)).toThrow(RulesetValidationError);
  });

  it("rejects an unknown top-level key (strict) so a corrupt artifact can't smuggle fields", () => {
    expect(() => parseRuleset({ ...MINIMAL, rogue: true })).toThrow(
      RulesetValidationError,
    );
  });

  it("safeParseRuleset reports success/failure without throwing", () => {
    expect(safeParseRuleset(MINIMAL).success).toBe(true);
    expect(safeParseRuleset({ version: 1 }).success).toBe(false);
  });
});

describe("the ruleset holder", () => {
  it("set → get → clear round-trips, and never defaults to a baseline", () => {
    // The holder is a dumb slot; whatever the file's prior state, set + clear
    // behave deterministically.
    setCurrentRuleset(INITIAL_RULESET);
    expect(getCurrentRuleset()).toBe(INITIAL_RULESET);
    setCurrentRuleset(null);
    expect(getCurrentRuleset()).toBeNull();
  });
});
