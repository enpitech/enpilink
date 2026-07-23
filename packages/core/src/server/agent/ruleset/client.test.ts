import { describe, expect, it, vi } from "vitest";
import {
  type ActivateMeta,
  parseMaxAge,
  RulesetClient,
  type RulesetClientConfig,
  type RulesetFetchResponse,
} from "./client.js";
import { parseRuleset } from "./schema.js";
import type { Ruleset } from "./types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A minimal valid ruleset that names GPTBot; `version` is parameterised. */
function ruleset(version: string, cls = "crawler"): Ruleset {
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

const RS_V1 = ruleset("v1");
const RS_V2 = ruleset("v2", "tool");

/** Build a `fetch`-style ok response wrapping a ruleset body + Cache-Control. */
function okResponse(
  body: unknown,
  cacheControl: string | null = null,
): RulesetFetchResponse {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (n) => (n.toLowerCase() === "cache-control" ? cacheControl : null),
    },
    json: async () => body,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield a macrotask so pending microtasks/`start()` chains settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

function baseConfig(
  over: Partial<RulesetClientConfig> = {},
): RulesetClientConfig {
  return {
    enabled: true,
    url: "https://cdn.test/ruleset.json",
    ttlSeconds: 0,
    timeoutMs: 1000,
    mode: "live",
    ...over,
  };
}

// ── THE HEADLINE: the response path never awaits a fetch ──────────────────────

describe("RulesetClient — never blocks (the headline guarantee)", () => {
  it("a HANGING fetch never delays classification (getRuleset stays synchronous)", async () => {
    const pending = deferred<RulesetFetchResponse>();
    const fetchImpl = vi.fn(() => pending.promise);
    const client = new RulesetClient({
      getConfig: () => baseConfig(),
      fetchImpl,
    });

    // Kick the (never-resolving) fetch.
    await client.start();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Classification reads the held ruleset SYNCHRONOUSLY while the fetch hangs.
    const t0 = performance.now();
    const held = client.getRuleset();
    const elapsed = performance.now() - t0;

    expect(held).toBeNull(); // no ruleset yet → pending is correct, not a guess
    expect(elapsed).toBeLessThan(20); // did NOT wait on the hanging fetch

    // Even after a full macrotask, still not blocked / still pending.
    await tick();
    expect(client.getRuleset()).toBeNull();

    // Let it land → it swaps in only once fetched AND validated.
    pending.resolve(okResponse(RS_V1, "max-age=300"));
    await client.whenIdle();
    expect(client.getRuleset()?.version).toBe("v1");
  });

  it("measures: a 300ms fetch does not add to a classify read", async () => {
    const slow = vi.fn(async (): Promise<RulesetFetchResponse> => {
      await new Promise((r) => setTimeout(r, 300));
      return okResponse(RS_V1);
    });
    const client = new RulesetClient({
      getConfig: () => baseConfig(),
      fetchImpl: slow,
    });
    await client.start(); // fetch now in flight for ~300ms

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      client.getRuleset(); // a classify-equivalent read
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50); // 1000 reads still complete while fetch runs

    await client.whenIdle();
    expect(client.getRuleset()?.version).toBe("v1");
  });

  it("a REJECTING fetch leaves classification pending (no throw onto the caller)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const onError = vi.fn();
    const client = new RulesetClient({
      getConfig: () => baseConfig(),
      fetchImpl,
      onError,
    });
    // start() + the refresh it triggers must not reject.
    await expect(client.start()).resolves.toBeUndefined();
    await client.whenIdle();
    expect(client.getRuleset()).toBeNull(); // pending, loud + detectable
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "fetch");
  });
});

// ── Stale-while-revalidate ────────────────────────────────────────────────────

describe("RulesetClient — stale-while-revalidate", () => {
  it("serves v1 for the entire duration of a refresh to v2, swaps only after v2 validates", async () => {
    let clock = 0;
    const now = () => clock;
    const second = deferred<RulesetFetchResponse>();
    const fetchImpl = vi
      .fn<() => Promise<RulesetFetchResponse>>()
      .mockResolvedValueOnce(okResponse(RS_V1, "max-age=10")) // TTL 10s
      .mockReturnValueOnce(second.promise); // v2, controlled

    const client = new RulesetClient({
      getConfig: () => baseConfig(),
      fetchImpl,
      now,
    });
    await client.start();
    await client.whenIdle();
    expect(client.getRuleset()?.version).toBe("v1");

    // Advance past the 10s TTL → a nudge schedules the v2 refresh.
    clock = 11_000;
    client.maybeRefresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // While the v2 fetch is in flight, classification STILL uses v1.
    expect(client.getRuleset()?.version).toBe("v1");
    await tick();
    expect(client.getRuleset()?.version).toBe("v1");

    // v2 lands + validates → now it swaps.
    second.resolve(okResponse(RS_V2, "max-age=10"));
    await client.whenIdle();
    expect(client.getRuleset()?.version).toBe("v2");
  });

  it("does not refetch while still within TTL (a nudge is a no-op)", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => okResponse(RS_V1, "max-age=300"));
    const client = new RulesetClient({
      getConfig: () => baseConfig(),
      fetchImpl,
      now: () => clock,
    });
    await client.start();
    await client.whenIdle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = 100_000; // still < 300s
    client.maybeRefresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // fresh → no refetch
  });

  it("single-flights concurrent refreshes", async () => {
    const pending = deferred<RulesetFetchResponse>();
    const fetchImpl = vi.fn(() => pending.promise);
    const client = new RulesetClient({
      getConfig: () => baseConfig(),
      fetchImpl,
    });
    void client.refresh();
    void client.refresh();
    void client.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // deduped
    pending.resolve(okResponse(RS_V1));
    await client.whenIdle();
  });
});

// ── Validation gate ───────────────────────────────────────────────────────────

describe("RulesetClient — validation gate", () => {
  it("REJECTS a corrupt artifact and keeps the last-good ruleset", async () => {
    let clock = 0;
    const onError = vi.fn();
    const fetchImpl = vi
      .fn<() => Promise<RulesetFetchResponse>>()
      .mockResolvedValueOnce(okResponse(RS_V1, "max-age=10"))
      .mockResolvedValueOnce(okResponse({ not: "a ruleset" }, "max-age=10"));
    const client = new RulesetClient({
      getConfig: () => baseConfig(),
      fetchImpl,
      now: () => clock,
      onError,
    });
    await client.start();
    await client.whenIdle();
    expect(client.getRuleset()?.version).toBe("v1");

    clock = 11_000;
    await client.refresh(); // fetches the corrupt artifact
    expect(onError).toHaveBeenCalledWith(expect.anything(), "validate");
    expect(client.getRuleset()?.version).toBe("v1"); // last-good preserved
  });

  it("a corrupt artifact on the FIRST load leaves the holder empty (never a guess)", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ garbage: true }));
    const client = new RulesetClient({
      getConfig: () => baseConfig(),
      fetchImpl,
    });
    await client.start();
    await client.whenIdle();
    expect(client.getRuleset()).toBeNull();
  });
});

// ── TTL / Cache-Control / dev-live mode / timeout ─────────────────────────────

describe("RulesetClient — TTL, mode, and timeout", () => {
  it("honors Cache-Control max-age in live mode", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => okResponse(RS_V1, "max-age=50"));
    const client = new RulesetClient({
      getConfig: () => baseConfig(),
      fetchImpl,
      now: () => clock,
    });
    await client.start();
    await client.whenIdle();

    clock = 49_000; // still fresh (< 50s)
    client.maybeRefresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = 51_000; // now stale
    client.maybeRefresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("ttlSeconds OVERRIDE wins over Cache-Control", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => okResponse(RS_V1, "max-age=9999"));
    const client = new RulesetClient({
      getConfig: () => baseConfig({ ttlSeconds: 20 }),
      fetchImpl,
      now: () => clock,
    });
    await client.start();
    await client.whenIdle();

    clock = 21_000; // past the 20s override even though max-age was 9999
    client.maybeRefresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("dev mode uses a short TTL regardless of a long Cache-Control", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => okResponse(RS_V1, "max-age=9999"));
    const client = new RulesetClient({
      getConfig: () => baseConfig({ mode: "dev" }),
      fetchImpl,
      now: () => clock,
    });
    await client.start();
    await client.whenIdle();

    clock = 6_000; // > DEV_TTL_MS (5s)
    client.maybeRefresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung fetch after timeoutMs and treats it as a failed refresh", async () => {
    const onError = vi.fn();
    // A fetch that only settles when its abort signal fires.
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<RulesetFetchResponse>((_res, rej) => {
          init.signal.addEventListener("abort", () =>
            rej(new Error("aborted")),
          );
        }),
    );
    const client = new RulesetClient({
      getConfig: () => baseConfig({ timeoutMs: 15 }),
      fetchImpl,
      onError,
    });
    await client.start();
    await client.whenIdle();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "fetch");
    expect(client.getRuleset()).toBeNull();
  });

  it("disabled config never fetches", async () => {
    const fetchImpl = vi.fn(async () => okResponse(RS_V1));
    const client = new RulesetClient({
      getConfig: () => baseConfig({ enabled: false }),
      fetchImpl,
    });
    await client.start();
    await tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.getRuleset()).toBeNull();
  });
});

// ── onActivate semantics ──────────────────────────────────────────────────────

describe("RulesetClient — activation", () => {
  it("fires onActivate on first load and on a version change, but not on a same-version refetch", async () => {
    let clock = 0;
    const activations: ActivateMeta[] = [];
    const fetchImpl = vi
      .fn<() => Promise<RulesetFetchResponse>>()
      .mockResolvedValueOnce(okResponse(RS_V1, "max-age=10"))
      .mockResolvedValueOnce(okResponse(RS_V1, "max-age=10")) // same version
      .mockResolvedValueOnce(okResponse(RS_V2, "max-age=10")); // new version
    const client = new RulesetClient({
      getConfig: () => baseConfig(),
      fetchImpl,
      now: () => clock,
      onActivate: (_rs, meta) => activations.push(meta),
    });

    await client.start();
    await client.whenIdle(); // v1 first load
    clock = 11_000;
    await client.refresh(); // v1 again — no activation
    clock = 22_000;
    await client.refresh(); // v2 — version change

    expect(activations).toHaveLength(2);
    expect(activations[0]).toMatchObject({
      firstLoad: true,
      versionChanged: false,
    });
    expect(activations[1]).toMatchObject({
      firstLoad: false,
      versionChanged: true,
      previousVersion: "v1",
    });
  });
});

// ── parseMaxAge ───────────────────────────────────────────────────────────────

describe("parseMaxAge", () => {
  it("parses max-age, handles no-cache/no-store, and null", () => {
    expect(parseMaxAge("max-age=300")).toBe(300);
    expect(parseMaxAge("public, max-age=60, s-maxage=120")).toBe(60);
    expect(parseMaxAge("no-store")).toBe(0);
    expect(parseMaxAge("no-cache")).toBe(0);
    expect(parseMaxAge("public")).toBeNull();
    expect(parseMaxAge(null)).toBeNull();
  });
});
