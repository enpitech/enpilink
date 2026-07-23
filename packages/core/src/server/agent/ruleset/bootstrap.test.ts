import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveStorage } from "../../log-sink.js";
import { MemoryStorageAdapter } from "../../storage/memory.js";
import type { AgentRequestRecord } from "../../storage/types.js";
import { setAgentCaptureGate } from "../capture-gate.js";
import {
  bootstrapRulesetClient,
  getRulesetClient,
  maybeRefreshRuleset,
  stopRulesetClient,
} from "./bootstrap.js";
import type { CachedRuleset, RulesetCacheStore } from "./cache-store.js";
import { NoopRulesetCacheStore } from "./cache-store.js";
import type { RulesetFetchResponse } from "./client.js";
import { getCurrentRuleset, setCurrentRuleset } from "./holder.js";
import { parseRuleset } from "./schema.js";
import type { Ruleset } from "./types.js";

// ── Fixtures / helpers ────────────────────────────────────────────────────────

function ruleset(version: string, cls: string): Ruleset {
  return parseRuleset({
    version,
    uaPatterns: [
      {
        id: "gptbot",
        pattern: "GPTBot",
        family: "gptbot",
        class: cls,
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
}
const RS_V1 = ruleset("v1", "crawler");
const RS_V2 = ruleset("v2", "tool");

function okResponse(
  body: unknown,
  cacheControl = "max-age=10",
): RulesetFetchResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => cacheControl },
    json: async () => body,
  };
}

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

/** A cache store pre-seeded with one fresh entry (never persists). */
function seededCacheStore(entry: CachedRuleset): RulesetCacheStore {
  return {
    load: async () => entry,
    save: async () => {},
  };
}

/** The gate the ruleset client reads its config from. */
function gate(over: Record<string, unknown> = {}): void {
  setAgentCaptureGate({
    enabled: true,
    sampleRate: 1,
    rulesetEnabled: true,
    rulesetUrl: "https://cdn.test/ruleset.json",
    rulesetTtlSeconds: 0,
    rulesetTimeoutMs: 1000,
    rulesetMode: "live",
    ...over,
  });
}

beforeEach(() => {
  setCurrentRuleset(null);
});
afterEach(() => {
  stopRulesetClient();
  setCurrentRuleset(null);
  setActiveStorage(null);
  setAgentCaptureGate({ enabled: false, sampleRate: 1 });
});

// ── Holder wiring + backfill ──────────────────────────────────────────────────

describe("bootstrapRulesetClient — holder + backfill wiring", () => {
  it("populates the holder and backfills pending rows on first load", async () => {
    gate();
    const storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);
    await storage.recordAgentRequests([
      pendingGptbot("/a"),
      pendingGptbot("/b"),
    ]);

    bootstrapRulesetClient({
      cacheStore: new NoopRulesetCacheStore(),
      fetchImpl: async () => okResponse(RS_V1),
    });
    await getRulesetClient()?.whenIdle();
    // backfill runs fire-and-forget off onActivate — let its microtasks settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(getCurrentRuleset()?.version).toBe("v1");
    for (const r of await storage.queryAgentRequests()) {
      expect(r.agentFamily).toBe("gptbot");
      expect(r.agentClass).toBe("crawler");
      expect(r.rulesetVersion).toBe("v1");
    }
  });

  it("re-runs backfill on a version change", async () => {
    gate();
    const storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);
    await storage.recordAgentRequests([pendingGptbot("/a")]);

    let clock = 0;
    const fetchImpl = vi
      .fn<() => Promise<RulesetFetchResponse>>()
      .mockResolvedValueOnce(okResponse(RS_V1))
      .mockResolvedValueOnce(okResponse(RS_V2));

    bootstrapRulesetClient({
      cacheStore: new NoopRulesetCacheStore(),
      fetchImpl,
      now: () => clock,
    });
    await getRulesetClient()?.whenIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect((await storage.queryAgentRequests())[0]?.rulesetVersion).toBe("v1");

    // Advance past TTL + force a refresh → v2 → backfill re-runs.
    clock = 20_000;
    await getRulesetClient()?.refresh();
    await new Promise((r) => setTimeout(r, 0));

    expect(getCurrentRuleset()?.version).toBe("v2");
    const row = (await storage.queryAgentRequests())[0];
    expect(row?.agentClass).toBe("tool");
    expect(row?.rulesetVersion).toBe("v2");
  });

  it("works with no active storage (backfill is a safe no-op)", async () => {
    gate();
    setActiveStorage(null);
    bootstrapRulesetClient({
      cacheStore: new NoopRulesetCacheStore(),
      fetchImpl: async () => okResponse(RS_V1),
    });
    await getRulesetClient()?.whenIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(getCurrentRuleset()?.version).toBe("v1"); // holder still populated
  });
});

// ── Enable flag + agent-surface gating ────────────────────────────────────────

describe("bootstrapRulesetClient — gating", () => {
  it("never fetches when agent.ruleset.enabled is off", async () => {
    gate({ rulesetEnabled: false });
    const fetchImpl = vi.fn(async () => okResponse(RS_V1));
    bootstrapRulesetClient({
      cacheStore: new NoopRulesetCacheStore(),
      fetchImpl,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getCurrentRuleset()).toBeNull();
  });

  it("stays dormant at boot when the agent surface is off, then lazy-starts on a nudge", async () => {
    gate({ enabled: false, serve: false, rulesetEnabled: true });
    const fetchImpl = vi.fn(async () => okResponse(RS_V1));
    bootstrapRulesetClient({
      cacheStore: new NoopRulesetCacheStore(),
      fetchImpl,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).not.toHaveBeenCalled(); // dormant at boot

    // A captured-request nudge (classification is happening) starts it.
    maybeRefreshRuleset();
    await new Promise((r) => setTimeout(r, 0));
    await getRulesetClient()?.whenIdle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getCurrentRuleset()?.version).toBe("v1");
  });

  it("starts at boot when serve is on even if capture is off", async () => {
    gate({ enabled: false, serve: true, rulesetEnabled: true });
    const fetchImpl = vi.fn(async () => okResponse(RS_V1));
    bootstrapRulesetClient({
      cacheStore: new NoopRulesetCacheStore(),
      fetchImpl,
    });
    await getRulesetClient()?.whenIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ── Restart warmth via the cache seam ─────────────────────────────────────────

describe("bootstrapRulesetClient — warm from cache", () => {
  it("warms the holder from a fresh cached entry without a network fetch", async () => {
    gate();
    const fetchImpl = vi.fn(async () => okResponse(RS_V2));
    bootstrapRulesetClient({
      cacheStore: seededCacheStore({
        body: RS_V1,
        fetchedAt: Date.now(),
        maxAgeSeconds: 3600,
      }),
      fetchImpl,
      now: () => Date.now(),
    });
    await getRulesetClient()?.whenIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(getCurrentRuleset()?.version).toBe("v1"); // from cache
    expect(fetchImpl).not.toHaveBeenCalled(); // fresh → no network
  });
});
