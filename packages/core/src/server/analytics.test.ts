import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyticsEnabled,
  createAnalyticsMiddleware,
  installAnalytics,
} from "./analytics.js";
import { getActiveStorage, serverLog, setActiveStorage } from "./log-sink.js";
import { MemoryStorageAdapter } from "./storage/memory.js";
import type { AnalyticsEvent } from "./storage/types.js";

/** Flush the fire-and-forget recordEvent/appendLog microtasks. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A fixed clock: 1000 at start, +5ms on the second read. */
function fixedClock(): () => number {
  const ticks = [1000, 1005];
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)] as number;
}

describe("analyticsEnabled", () => {
  const original = process.env.ENPILINK_ANALYTICS;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.ENPILINK_ANALYTICS;
    } else {
      process.env.ENPILINK_ANALYTICS = original;
    }
  });

  it("is off by default", () => {
    delete process.env.ENPILINK_ANALYTICS;
    expect(analyticsEnabled()).toBe(false);
  });

  it("accepts 1/true/yes/on (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " True "]) {
      process.env.ENPILINK_ANALYTICS = v;
      expect(analyticsEnabled()).toBe(true);
    }
  });

  it("rejects other values", () => {
    for (const v of ["0", "false", "", "off", "no"]) {
      process.env.ENPILINK_ANALYTICS = v;
      expect(analyticsEnabled()).toBe(false);
    }
  });
});

describe("createAnalyticsMiddleware", () => {
  let store: MemoryStorageAdapter;
  beforeEach(async () => {
    store = new MemoryStorageAdapter({ cap: 100 });
    await store.init();
  });

  it("records a tool_call event on success with tool, ms, ok", async () => {
    const mw = createAnalyticsMiddleware(store, fixedClock());
    const result = { content: [{ type: "text", text: "hi" }] };
    const ret = await mw(
      { method: "tools/call", params: { name: "greet" } },
      undefined,
      async () => result,
    );
    await flush();

    expect(ret).toBe(result);
    const [e] = await store.queryEvents({});
    expect(e).toMatchObject<Partial<AnalyticsEvent>>({
      type: "tool_call",
      tool: "greet",
      method: "tools/call",
      ms: 5,
      ok: true,
    });
    expect(e?.ts).toBe(1000);
    expect(e?.error).toBeUndefined();
  });

  it("records ok=false when the result has isError", async () => {
    const mw = createAnalyticsMiddleware(store, fixedClock());
    await mw(
      { method: "tools/call", params: { name: "boom" } },
      undefined,
      async () => ({ isError: true, content: [] }),
    );
    await flush();
    const [e] = await store.queryEvents({});
    expect(e).toMatchObject({ tool: "boom", ok: false });
  });

  it("records the event AND rethrows on a thrown error", async () => {
    const mw = createAnalyticsMiddleware(store, fixedClock());
    await expect(
      mw(
        { method: "tools/call", params: { name: "kaboom" } },
        undefined,
        async () => {
          throw new Error("nope");
        },
      ),
    ).rejects.toThrow("nope");
    await flush();
    const [e] = await store.queryEvents({});
    expect(e).toMatchObject({ tool: "kaboom", ok: false, error: "nope" });
  });

  it("captures the method but no tool for non-tools/call requests", async () => {
    const mw = createAnalyticsMiddleware(store, fixedClock());
    await mw({ method: "tools/list", params: {} }, undefined, async () => ({
      tools: [],
    }));
    await flush();
    const [e] = await store.queryEvents({});
    expect(e?.method).toBe("tools/list");
    expect(e?.tool).toBeUndefined();
  });

  it("never breaks the call when storage.recordEvent throws", async () => {
    const broken = new MemoryStorageAdapter();
    await broken.init();
    broken.recordEvent = async () => {
      throw new Error("storage down");
    };
    const mw = createAnalyticsMiddleware(broken, fixedClock());
    const result = { content: [] };
    await expect(
      mw(
        { method: "tools/call", params: { name: "x" } },
        undefined,
        async () => result,
      ),
    ).resolves.toBe(result);
    await flush();
  });
});

describe("installAnalytics gating", () => {
  const originalAnalytics = process.env.ENPILINK_ANALYTICS;
  const originalStorage = process.env.ENPILINK_STORAGE;

  beforeEach(() => {
    setActiveStorage(null);
  });
  afterEach(() => {
    setActiveStorage(null);
    if (originalAnalytics === undefined) {
      delete process.env.ENPILINK_ANALYTICS;
    } else {
      process.env.ENPILINK_ANALYTICS = originalAnalytics;
    }
    if (originalStorage === undefined) {
      delete process.env.ENPILINK_STORAGE;
    } else {
      process.env.ENPILINK_STORAGE = originalStorage;
    }
  });

  it("returns null and creates no adapter when disabled", async () => {
    delete process.env.ENPILINK_ANALYTICS;
    const result = await installAnalytics();
    expect(result).toBeNull();
    expect(getActiveStorage()).toBeNull();
  });

  it("does NOT create a sqlite db file when disabled", async () => {
    delete process.env.ENPILINK_ANALYTICS;
    process.env.ENPILINK_STORAGE = "sqlite";
    const dbPath = `${process.cwd()}/enpilink.db`;
    const preexisting = existsSync(dbPath);
    await installAnalytics();
    if (!preexisting) {
      expect(existsSync(dbPath)).toBe(false);
    }
  });

  it("resolves + inits + registers the active storage when enabled", async () => {
    process.env.ENPILINK_ANALYTICS = "1";
    process.env.ENPILINK_STORAGE = "memory";
    const result = await installAnalytics();
    expect(result).not.toBeNull();
    expect(result?.entry.filter).toBe("request");
    expect(typeof result?.entry.handler).toBe("function");
    expect(getActiveStorage()).toBe(result?.storage);
    await result?.storage.close();
  });
});

describe("serverLog capture", () => {
  beforeEach(() => setActiveStorage(null));
  afterEach(() => setActiveStorage(null));

  it("is a no-op sink (no storage) when no active storage", () => {
    expect(() => serverLog("info", "hello")).not.toThrow();
  });

  it("mirrors logs to the active storage when set", async () => {
    const store = new MemoryStorageAdapter();
    await store.init();
    setActiveStorage(store);
    serverLog("error", "boom", { code: 1 });
    await flush();
    const [l] = await store.queryLogs({});
    expect(l).toMatchObject({ level: "error", msg: "boom" });
    expect(l?.data).toEqual({ code: 1 });
    await store.close();
  });

  it("swallows storage errors", async () => {
    const store = new MemoryStorageAdapter();
    await store.init();
    store.appendLog = async () => {
      throw new Error("down");
    };
    setActiveStorage(store);
    expect(() => serverLog("info", "x")).not.toThrow();
    await flush();
    await store.close();
  });
});
