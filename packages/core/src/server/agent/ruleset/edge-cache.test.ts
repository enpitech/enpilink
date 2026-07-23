import { describe, expect, it } from "vitest";
import type { CachedRuleset } from "./cache-store.js";
import {
  CacheApiRulesetCacheStore,
  type EdgeCacheLike,
  type EdgeKvLike,
  KVRulesetCacheStore,
  MemoryRulesetCacheStore,
} from "./edge-cache.js";

/** A minimal in-memory Cloudflare-KV double. */
class FakeKv implements EdgeKvLike {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

/** A minimal Web-`Cache` double — clones on put/match like the real Cache API. */
class FakeCache implements EdgeCacheLike {
  readonly store = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    const r = this.store.get(request.url);
    return r ? r.clone() : undefined;
  }
  async put(request: Request, response: Response): Promise<void> {
    this.store.set(request.url, response.clone());
  }
}

/** A sample persisted entry — the body is opaque JSON to the store. */
function sampleEntry(): CachedRuleset {
  return {
    body: { version: "v-123", uaPatterns: [], shapeRules: [], ipRanges: {} },
    fetchedAt: 1_700_000_000_000,
    maxAgeSeconds: 3600,
  };
}

describe("KVRulesetCacheStore", () => {
  it("round-trips a validated entry through KV", async () => {
    const kv = new FakeKv();
    const store = new KVRulesetCacheStore({ kv });
    expect(await store.load()).toBeNull();
    await store.save(sampleEntry());
    expect(await store.load()).toEqual(sampleEntry());
  });

  it("returns null on absent / malformed KV values (never throws)", async () => {
    const kv = new FakeKv();
    const store = new KVRulesetCacheStore({ kv, key: "k" });
    kv.store.set("k", "{ not json");
    expect(await store.load()).toBeNull();
    kv.store.set("k", JSON.stringify({ nope: true }));
    expect(await store.load()).toBeNull();
  });

  it("coerces a legacy entry missing bookkeeping fields", async () => {
    const kv = new FakeKv();
    const store = new KVRulesetCacheStore({ kv, key: "k" });
    kv.store.set("k", JSON.stringify({ body: { v: 1 }, fetchedAt: 5 }));
    expect(await store.load()).toEqual({
      body: { v: 1 },
      fetchedAt: 5,
      maxAgeSeconds: null,
    });
  });
});

describe("CacheApiRulesetCacheStore", () => {
  it("round-trips an entry through the Cache API", async () => {
    const cache = new FakeCache();
    const store = new CacheApiRulesetCacheStore({ cache });
    expect(await store.load()).toBeNull();
    await store.save(sampleEntry());
    expect(await store.load()).toEqual(sampleEntry());
  });
});

describe("MemoryRulesetCacheStore", () => {
  it("round-trips an entry in-isolate", async () => {
    const store = new MemoryRulesetCacheStore();
    expect(await store.load()).toBeNull();
    await store.save(sampleEntry());
    expect(await store.load()).toEqual(sampleEntry());
  });
});
