import { describe, expect, it, vi } from "vitest";
import { MemoryRulesetCacheStore } from "./edge-cache.js";
import type { EdgeFetcher, EdgeFetchResponse } from "./edge-client.js";
import { EdgeRulesetClient } from "./edge-client.js";
import { INITIAL_RULESET } from "./initial.js";

/** The initial ruleset as a plain wire object. */
function artifact(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(INITIAL_RULESET)) as Record<string, unknown>;
}

/** A 200 fetch response carrying `body`. */
function okResponse(body: unknown, cacheControl?: string): EdgeFetchResponse {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (n) =>
        n.toLowerCase() === "cache-control" ? (cacheControl ?? null) : null,
    },
    json: async () => body,
  };
}

describe("EdgeRulesetClient", () => {
  it("holds nothing until refreshed, then serves the fetched+validated ruleset", async () => {
    const fetchImpl: EdgeFetcher = async () => okResponse(artifact());
    const client = new EdgeRulesetClient({
      enabled: true,
      url: "x",
      fetchImpl,
    });
    expect(client.getRuleset()).toBeNull();
    await client.refreshInBackground();
    expect(client.getRuleset()?.version).toBe(INITIAL_RULESET.version);
    expect(client.getStatus().source).toBe("network");
  });

  it("THE LATENCY LAW: getRuleset() is synchronous and never waits on a fetch", async () => {
    // A fetch that hangs until aborted (so nothing dangles after the timeout).
    const fetchImpl: EdgeFetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    const client = new EdgeRulesetClient({
      enabled: true,
      url: "x",
      timeoutMs: 20,
      fetchImpl,
    });
    const pending = client.refreshInBackground(); // do NOT await — fetch is hung
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      client.getRuleset();
    }
    const elapsed = performance.now() - t0;
    expect(client.getRuleset()).toBeNull(); // still empty; the fetch is in-flight
    expect(elapsed).toBeLessThan(50);
    await pending; // resolves once the timeout aborts the hung fetch
  });

  it("warms from the cross-isolate cache with NO network fetch (source=cache)", async () => {
    const cacheStore = new MemoryRulesetCacheStore();
    await cacheStore.save({
      body: artifact(),
      fetchedAt: Date.now(),
      maxAgeSeconds: 3600,
    });
    const fetchImpl = vi.fn<EdgeFetcher>(async () => {
      throw new Error("should not fetch when warm + disabled");
    });
    const client = new EdgeRulesetClient({
      enabled: false, // network off — cache-only
      url: "x",
      cacheStore,
      fetchImpl,
    });
    await client.refreshInBackground();
    expect(client.getRuleset()?.version).toBe(INITIAL_RULESET.version);
    expect(client.getStatus().source).toBe("cache");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("persists a fetched artifact for a warm cold-isolate restart", async () => {
    const cacheStore = new MemoryRulesetCacheStore();
    const client = new EdgeRulesetClient({
      enabled: true,
      url: "x",
      cacheStore,
      fetchImpl: async () => okResponse(artifact()),
    });
    await client.refreshInBackground();
    expect((await cacheStore.load())?.body).toEqual(artifact());
  });

  it("DEGRADES on a corrupt artifact — keeps the last-good ruleset, never throws", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    let call = 0;
    const fetchImpl: EdgeFetcher = async () => {
      call += 1;
      return call === 1
        ? okResponse(artifact()) // good
        : okResponse({ version: 42 }); // corrupt (version not a string)
    };
    const onError = vi.fn();
    const client = new EdgeRulesetClient({
      enabled: true,
      url: "x",
      mode: "dev", // short 5s TTL so the second refresh is allowed
      now,
      fetchImpl,
      onError,
    });
    await client.refreshInBackground();
    expect(client.getRuleset()?.version).toBe(INITIAL_RULESET.version);

    clock += 6_000; // advance past the dev TTL
    await client.refreshInBackground();
    // The corrupt artifact NEVER became live — the last-good ruleset still serves.
    expect(client.getRuleset()?.version).toBe(INITIAL_RULESET.version);
    expect(onError).toHaveBeenCalledWith(expect.anything(), "validate");
  });

  it("NO BASELINE: a failing fetch leaves the ruleset empty (pending), never throws", async () => {
    const client = new EdgeRulesetClient({
      enabled: true,
      url: "x",
      timeoutMs: 20,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    await expect(client.refreshInBackground()).resolves.toBeUndefined();
    expect(client.getRuleset()).toBeNull();
  });

  it("fires onActivate exactly once on first load", async () => {
    const onActivate = vi.fn();
    const client = new EdgeRulesetClient({
      enabled: true,
      url: "x",
      onActivate,
      fetchImpl: async () => okResponse(artifact()),
    });
    await client.refreshInBackground();
    await client.refreshInBackground(); // same version — no re-activate
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(
      expect.objectContaining({ version: INITIAL_RULESET.version }),
      expect.objectContaining({ firstLoad: true, source: "network" }),
    );
  });
});
