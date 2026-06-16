import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  createObservabilityRouter,
  percentile,
  summarize,
} from "./observability.js";
import { MemoryStorageAdapter } from "./storage/memory.js";
import type { AnalyticsEvent, StorageAdapter } from "./storage/types.js";

function ev(p: Partial<AnalyticsEvent>): AnalyticsEvent {
  return { ts: 0, type: "tool_call", ...p };
}

describe("percentile", () => {
  it("returns 0 for an empty sample", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
  });

  it("returns the single value for a one-element sample", () => {
    expect(percentile([42], 0.5)).toBe(42);
  });

  it("computes p50/p95 by nearest-rank interpolation", () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(s, 0.5)).toBeCloseTo(55, 5);
    expect(percentile(s, 0.95)).toBeCloseTo(95.5, 5);
  });

  it("tolerates a zero-latency sample (ms === 0)", () => {
    expect(percentile([0, 0, 0], 0.5)).toBe(0);
    expect(percentile([0, 10], 0.5)).toBe(5);
  });
});

describe("summarize", () => {
  it("aggregates totals, error rate, p50/p95, top tools, and buckets", () => {
    const base = 1_000_000;
    const events: AnalyticsEvent[] = [
      ev({ ts: base + 0, tool: "echo", ms: 10, ok: true }),
      ev({ ts: base + 1000, tool: "echo", ms: 20, ok: true }),
      ev({ ts: base + 2000, tool: "echo", ms: 30, ok: false }),
      ev({ ts: base + 70_000, tool: "search", ms: 100, ok: true }),
      ev({ ts: base + 71_000, tool: "search", ms: 0, ok: true }),
    ];

    const s = summarize(events, { since: base, bucketMs: 60_000 });

    expect(s.enabled).toBe(true);
    expect(s.total).toBe(5);
    expect(s.errors).toBe(1);
    expect(s.errorRate).toBeCloseTo(0.2, 5);
    // overall latencies sorted: [0,10,20,30,100]
    expect(s.p50).toBe(20);

    // Two 60s buckets: first has 3 (1 error), second has 2.
    expect(s.callsOverTime).toHaveLength(2);
    const [b0, b1] = s.callsOverTime;
    expect(b0).toMatchObject({ count: 3, errors: 1 });
    expect(b1).toMatchObject({ count: 2, errors: 0 });
    // Buckets oldest-first.
    expect(b0?.ts ?? 0).toBeLessThan(b1?.ts ?? 0);

    // Top tools: echo (3) then search (2).
    expect(s.topTools.map((t) => t.name)).toEqual(["echo", "search"]);
    const [t0, t1] = s.topTools;
    expect(t0).toMatchObject({ count: 3, errors: 1 });
    expect(t0?.errorRate ?? 0).toBeCloseTo(1 / 3, 5);
    expect(t1).toMatchObject({ count: 2, errors: 0 });
  });

  it("counts a thrown error (ok undefined + error set) as an error", () => {
    const s = summarize(
      [ev({ ts: 1, error: "boom" }), ev({ ts: 2, ok: true, ms: 5 })],
      { since: 0 },
    );
    expect(s.errors).toBe(1);
    expect(s.errorRate).toBe(0.5);
  });

  it("excludes timing-less events from percentiles but counts them in totals", () => {
    const s = summarize(
      [ev({ ts: 1, ok: true }), ev({ ts: 2, ok: true, ms: 50 })],
      { since: 0 },
    );
    expect(s.total).toBe(2);
    // Only one event has ms → p50 is that value.
    expect(s.p50).toBe(50);
  });

  it("returns zeroed aggregates (not NaN) for no events", () => {
    const s = summarize([], { since: 0 });
    expect(s).toMatchObject({
      total: 0,
      errors: 0,
      errorRate: 0,
      p50: 0,
      p95: 0,
      callsOverTime: [],
      topTools: [],
    });
  });

  it("falls back to method then 'unknown' for the tool name", () => {
    const s = summarize(
      [ev({ ts: 1, method: "initialize", ms: 1 }), ev({ ts: 2, ms: 1 })],
      { since: 0 },
    );
    const names = s.topTools.map((t) => t.name).sort();
    expect(names).toEqual(["initialize", "unknown"]);
  });
});

// --- Router behaviour (incl. the disabled/no-storage path) ---

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function mount(getStorage: () => StorageAdapter | null) {
  const app = express();
  app.use(createObservabilityRouter(getStorage));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  });
  return `http://127.0.0.1:${port}`;
}

describe("createObservabilityRouter (disabled / no storage)", () => {
  it("returns 200 { enabled: false } empty payloads, never 500", async () => {
    const url = await mount(() => null);

    const summary = await fetch(`${url}/__enpilink/observability/summary`);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      enabled: false,
      total: 0,
      callsOverTime: [],
      topTools: [],
    });

    const events = await fetch(`${url}/__enpilink/observability/events`);
    expect(events.status).toBe(200);
    expect(await events.json()).toEqual({ enabled: false, events: [] });

    const logs = await fetch(`${url}/__enpilink/observability/logs`);
    expect(logs.status).toBe(200);
    expect(await logs.json()).toEqual({ enabled: false, logs: [] });
  });
});

describe("createObservabilityRouter (with storage)", () => {
  it("serves a real summary + events from the active adapter", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init();
    await storage.recordEvent(
      ev({ ts: Date.now(), tool: "echo", ms: 5, ok: true }),
    );
    await storage.recordEvent(
      ev({ ts: Date.now(), tool: "echo", ms: 15, ok: false }),
    );

    const url = await mount(() => storage);

    const summary = await (
      await fetch(`${url}/__enpilink/observability/summary?since=0`)
    ).json();
    expect(summary.enabled).toBe(true);
    expect(summary.total).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.topTools[0].name).toBe("echo");

    const events = await (
      await fetch(`${url}/__enpilink/observability/events?since=0`)
    ).json();
    expect(events.enabled).toBe(true);
    expect(events.events).toHaveLength(2);
  });

  it("returns a 200 empty summary (not 500) when storage throws", async () => {
    const broken = {
      queryEvents: async () => {
        throw new Error("db down");
      },
    } as unknown as StorageAdapter;
    const url = await mount(() => broken);
    const res = await fetch(`${url}/__enpilink/observability/summary`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, total: 0 });
  });
});
