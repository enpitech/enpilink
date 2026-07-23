import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../storage/memory.js";
import type { AgentRequestRecord } from "../storage/types.js";
import { backfillClassification } from "./backfill.js";
import { parseRuleset } from "./ruleset/schema.js";

/** Ruleset A — names GPTBot as a crawler. */
const RS_A = parseRuleset({
  version: "A",
  uaPatterns: [
    {
      id: "gptbot",
      pattern: "GPTBot",
      family: "gptbot",
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
});

/** Ruleset B — a DIFFERENT version that reclassifies GPTBot as a `tool`. */
const RS_B = parseRuleset({
  version: "B",
  uaPatterns: [
    {
      id: "gptbot",
      pattern: "GPTBot",
      family: "gptbot",
      class: "tool",
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
});

/** Ruleset C — version C that names NOTHING, so GPTBot falls to unknown (clears family). */
const RS_C = parseRuleset({
  version: "C",
  uaPatterns: [],
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
});

/** A raw, PENDING GPTBot capture (as the middleware writes when no ruleset loads). */
function pendingGptbot(path: string): AgentRequestRecord {
  return {
    ts: Date.now(),
    siteId: "default",
    method: "GET",
    path,
    status: 200,
    outcome: "resolved",
    httpVersion: "1.1",
    headers: [["User-Agent", "GPTBot/1.0"]],
    ua: "GPTBot/1.0",
    confidence: "pending",
  };
}

describe("backfillClassification", () => {
  let storage: MemoryStorageAdapter;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    await storage.init();
  });

  it("classifies PENDING rows once a ruleset is available", async () => {
    await storage.recordAgentRequests([
      pendingGptbot("/a"),
      pendingGptbot("/b"),
    ]);
    // Precondition: both rows are pending, unclassified, unversioned.
    for (const r of await storage.queryAgentRequests()) {
      expect(r.confidence).toBe("pending");
      expect(r.agentFamily).toBeUndefined();
      expect(r.rulesetVersion).toBeUndefined();
    }

    const result = await backfillClassification(storage, RS_A);
    expect(result.reclassified).toBe(2);

    for (const r of await storage.queryAgentRequests()) {
      expect(r.agentFamily).toBe("gptbot");
      expect(r.agentClass).toBe("crawler");
      expect(r.confidence).toBe("ua-only");
      expect(r.rulesetVersion).toBe("A");
    }
  });

  it("is idempotent — a row already at the current version is not re-touched", async () => {
    await storage.recordAgentRequests([pendingGptbot("/a")]);
    expect((await backfillClassification(storage, RS_A)).reclassified).toBe(1);
    // Second run against the SAME version finds nothing stale.
    expect((await backfillClassification(storage, RS_A)).reclassified).toBe(0);
  });

  it("RE-classifies on a ruleset version change", async () => {
    await storage.recordAgentRequests([pendingGptbot("/a")]);
    await backfillClassification(storage, RS_A); // → gptbot/crawler @A

    const changed = await backfillClassification(storage, RS_B);
    expect(changed.reclassified).toBe(1);
    const row = (await storage.queryAgentRequests())[0];
    expect(row?.agentClass).toBe("tool"); // reclassified under B
    expect(row?.rulesetVersion).toBe("B");
  });

  it("CLEARS a previously-named family when the new ruleset no longer names it", async () => {
    await storage.recordAgentRequests([pendingGptbot("/a")]);
    await backfillClassification(storage, RS_A); // gptbot named

    await backfillClassification(storage, RS_C); // C names nothing
    const row = (await storage.queryAgentRequests())[0];
    expect(row?.agentFamily).toBeUndefined(); // family cleared
    expect(row?.agentClass).toBe("unknown");
    expect(row?.rulesetVersion).toBe("C");
  });

  it("is a safe no-op on a null storage / an adapter lacking the methods", async () => {
    expect(await backfillClassification(null, RS_A)).toEqual({
      reclassified: 0,
      pages: 0,
    });
    // An adapter that predates D1 (no backfill methods).
    const legacy = { recordAgentRequests: async () => {} } as never;
    expect(await backfillClassification(legacy, RS_A)).toEqual({
      reclassified: 0,
      pages: 0,
    });
  });

  it("pages through a large backlog to completion", async () => {
    const many = Array.from({ length: 25 }, (_, i) => pendingGptbot(`/p${i}`));
    await storage.recordAgentRequests(many);
    const result = await backfillClassification(storage, RS_A, {
      batchSize: 10,
    });
    expect(result.reclassified).toBe(25);
    expect(result.pages).toBe(3); // 10 + 10 + 5
    const remaining = await storage.queryUnclassifiedAgentRequests({
      rulesetVersion: "A",
    });
    expect(remaining).toHaveLength(0);
  });
});

describe("storage backfill primitives (memory)", () => {
  let storage: MemoryStorageAdapter;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    await storage.init();
  });

  it("queryUnclassifiedAgentRequests returns pending + wrong-version rows, oldest-first", async () => {
    await storage.recordAgentRequests([pendingGptbot("/first")]);
    await storage.recordAgentRequests([
      {
        ...pendingGptbot("/second"),
        confidence: "ua-only",
        rulesetVersion: "A",
      },
    ]);
    // Current version is B → both /first (NULL) and /second (A) are stale.
    const stale = await storage.queryUnclassifiedAgentRequests({
      rulesetVersion: "B",
    });
    expect(stale.map((r) => r.path)).toEqual(["/first", "/second"]);
    // A row already at B would be excluded.
    const staleForA = await storage.queryUnclassifiedAgentRequests({
      rulesetVersion: "A",
    });
    expect(staleForA.map((r) => r.path)).toEqual(["/first"]);
  });

  it("updateAgentClassifications targets a row by id and clears family on null", async () => {
    await storage.recordAgentRequests([pendingGptbot("/a")]);
    const [row] = await storage.queryAgentRequests();
    const id = row?.id as number;
    await storage.updateAgentClassifications([
      {
        id,
        agentFamily: null,
        agentClass: "unknown",
        confidence: "none",
        rulesetVersion: "Z",
      },
    ]);
    const [updated] = await storage.queryAgentRequests();
    expect(updated?.agentFamily).toBeUndefined();
    expect(updated?.confidence).toBe("none");
    expect(updated?.rulesetVersion).toBe("Z");
  });
});
