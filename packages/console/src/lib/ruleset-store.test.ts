import { describe, expect, it } from "vitest";
import { rulesetStatusSchema } from "./ruleset-store.js";

/**
 * Zod-schema tests for the D3 detection-ruleset status client, validated against
 * the exact shape `server/agent/ruleset/bootstrap.ts::RulesetStatus` returns.
 * Covers the three shapes the card must handle: a loaded ruleset, the `pending`
 * (loaded:false) shape, and the `{ enabled: false }` degrade shape.
 */

describe("rulesetStatusSchema", () => {
  it("parses a loaded status", () => {
    const parsed = rulesetStatusSchema.parse({
      enabled: true,
      loaded: true,
      version: "2026-07-23-a1b2c3d4e5",
      fetchedAt: 1_700_000_000_000,
      source: "network",
      mode: "live",
      ttlSeconds: 0,
      url: "https://cdn.enpitech.dev/agent/ruleset/v1.json",
      fetchEnabled: true,
    });
    expect(parsed.enabled).toBe(true);
    if (!parsed.enabled) {
      throw new Error("expected enabled status");
    }
    expect(parsed.loaded).toBe(true);
    expect(parsed.version).toBe("2026-07-23-a1b2c3d4e5");
    expect(parsed.source).toBe("network");
  });

  it("parses the pending shape (on, but no ruleset loaded yet)", () => {
    const parsed = rulesetStatusSchema.parse({
      enabled: true,
      loaded: false,
      version: null,
      fetchedAt: null,
      source: null,
      mode: "dev",
      ttlSeconds: 5,
      url: "http://127.0.0.1:9999/__enpilink/agents/ruleset",
      fetchEnabled: true,
    });
    if (!parsed.enabled) {
      throw new Error("expected enabled status");
    }
    expect(parsed.loaded).toBe(false);
    expect(parsed.version).toBeNull();
    expect(parsed.source).toBeNull();
  });

  it("parses the { enabled: false } degrade shape", () => {
    const parsed = rulesetStatusSchema.parse({ enabled: false });
    expect(parsed.enabled).toBe(false);
    expect(Object.keys(parsed)).toEqual(["enabled"]);
  });

  it("is tolerant of unknown extra fields (forward-compat)", () => {
    const parsed = rulesetStatusSchema.parse({
      enabled: true,
      loaded: true,
      version: "v",
      fetchedAt: 1,
      source: "cache",
      mode: "live",
      ttlSeconds: 0,
      url: "u",
      fetchEnabled: true,
      futureField: { rollups: 3 },
    });
    expect(parsed.enabled).toBe(true);
  });

  it("rejects an invalid source enum", () => {
    const bad = {
      enabled: true,
      loaded: true,
      version: "v",
      fetchedAt: 1,
      source: "carrier-pigeon",
      mode: "live",
      ttlSeconds: 0,
      url: "u",
      fetchEnabled: true,
    };
    expect(rulesetStatusSchema.safeParse(bad).success).toBe(false);
  });
});
