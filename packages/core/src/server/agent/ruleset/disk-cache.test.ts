import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedRuleset } from "./cache-store.js";
import { RulesetClient, type RulesetFetchResponse } from "./client.js";
import { DiskRulesetCacheStore } from "./disk-cache.js";
import { INITIAL_RULESET } from "./initial.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "enpilink-ruleset-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DiskRulesetCacheStore", () => {
  it("round-trips a cache entry through the file, creating the dir", async () => {
    const file = join(dir, "nested", "ruleset-cache.json");
    const store = new DiskRulesetCacheStore(file);
    const entry: CachedRuleset = {
      body: INITIAL_RULESET,
      fetchedAt: 1_700_000_000_000,
      maxAgeSeconds: 300,
    };
    await store.save(entry);
    const loaded = await store.load();
    expect(loaded).toEqual(entry);
  });

  it("returns null for an absent file", async () => {
    const store = new DiskRulesetCacheStore(join(dir, "nope.json"));
    expect(await store.load()).toBeNull();
  });

  it("returns null for a malformed / non-entry file (no throw)", async () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ this is not json");
    expect(await new DiskRulesetCacheStore(file).load()).toBeNull();
    writeFileSync(file, JSON.stringify({ unexpected: "shape" }));
    expect(await new DiskRulesetCacheStore(file).load()).toBeNull();
  });
});

describe("restart warmth — a fresh client instance loads from disk without a network fetch", () => {
  function okResponse(body: unknown): RulesetFetchResponse {
    return {
      ok: true,
      status: 200,
      headers: { get: () => "max-age=3600" },
      json: async () => body,
    };
  }
  const config = () => ({
    enabled: true,
    url: "https://cdn.test/ruleset.json",
    ttlSeconds: 0,
    timeoutMs: 1000,
    mode: "live" as const,
  });

  it("warms the holder from disk and does NOT fetch while the cache is fresh", async () => {
    const file = join(dir, "ruleset-cache.json");
    let clock = 1_000_000;

    // First client: fetch v-disk, which writes the disk cache.
    const store1 = new DiskRulesetCacheStore(file);
    const fetch1 = vi.fn(async () => okResponse(INITIAL_RULESET));
    const c1 = new RulesetClient({
      getConfig: config,
      cacheStore: store1,
      fetchImpl: fetch1,
      now: () => clock,
    });
    await c1.start();
    await c1.whenIdle();
    expect(fetch1).toHaveBeenCalledTimes(1);
    expect(c1.getRuleset()?.version).toBe(INITIAL_RULESET.version);

    // "Restart": a brand-new client + store on the SAME file, clock barely moved
    // (cache still within the 3600s max-age).
    clock += 5_000;
    const store2 = new DiskRulesetCacheStore(file);
    const fetch2 = vi.fn(async () => okResponse(INITIAL_RULESET));
    const activated: string[] = [];
    const c2 = new RulesetClient({
      getConfig: config,
      cacheStore: store2,
      fetchImpl: fetch2,
      now: () => clock,
      onActivate: (rs) => activated.push(rs.version),
    });
    await c2.start();
    await c2.whenIdle();

    // Warmed instantly from disk; NO network fetch (cache still fresh).
    expect(c2.getRuleset()?.version).toBe(INITIAL_RULESET.version);
    expect(activated).toEqual([INITIAL_RULESET.version]); // first-load activation
    expect(fetch2).not.toHaveBeenCalled();
  });

  it("warms from disk then refreshes in the background when the cached copy is stale", async () => {
    const file = join(dir, "ruleset-cache.json");

    // Seed a STALE disk entry by hand (fetchedAt far in the past, short max-age).
    await new DiskRulesetCacheStore(file).save({
      body: INITIAL_RULESET,
      fetchedAt: 0,
      maxAgeSeconds: 10,
    });

    const clock = 1_000_000; // way past the 10s max-age
    const fetch2 = vi.fn(async () => okResponse(INITIAL_RULESET));
    const c = new RulesetClient({
      getConfig: config,
      cacheStore: new DiskRulesetCacheStore(file),
      fetchImpl: fetch2,
      now: () => clock,
    });
    await c.start();
    // Warmed from disk immediately (served during revalidation)...
    expect(c.getRuleset()?.version).toBe(INITIAL_RULESET.version);
    // ...and a background refresh was kicked because the disk copy was stale.
    await c.whenIdle();
    expect(fetch2).toHaveBeenCalledTimes(1);
  });
});
