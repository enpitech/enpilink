import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnalyticsMiddleware } from "./analytics.js";
import {
  getCaptureGate,
  refreshCaptureGate,
  setCaptureGate,
} from "./capture-gate.js";
import { createConfigRouter } from "./config/index.js";
import { setActiveStorage } from "./log-sink.js";
import { MemoryStorageAdapter } from "./storage/memory.js";

/** Flush the fire-and-forget recordEvent microtask. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Issue a real HTTP request against an Express app on an ephemeral port. */
async function request(
  app: express.Express,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number }> {
  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** A fixed clock so latency is deterministic. */
function fixedClock(): () => number {
  const ticks = [1000, 1005];
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)] as number;
}

/** Call the middleware once (simulating a tool call). */
async function callTool(mw: ReturnType<typeof createAnalyticsMiddleware>) {
  await mw(
    { method: "tools/call", params: { name: "greet" } },
    undefined,
    async () => ({ content: [] }),
  );
  await flush();
}

describe("live analytics toggle (capture gate)", () => {
  const original = process.env.ENPILINK_ANALYTICS;

  beforeEach(() => {
    setActiveStorage(null);
    setCaptureGate({ enabled: false, sampleRate: 1 });
    delete process.env.ENPILINK_ANALYTICS;
  });
  afterEach(() => {
    setActiveStorage(null);
    setCaptureGate({ enabled: false, sampleRate: 1 });
    if (original === undefined) {
      delete process.env.ENPILINK_ANALYTICS;
    } else {
      process.env.ENPILINK_ANALYTICS = original;
    }
  });

  it("config write to analytics.enabled flips capture ON live (no restart)", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);
    // Capture middleware is installed against the live gate (the production
    // wiring) — initially gate is OFF.
    await refreshCaptureGate();
    expect(getCaptureGate().enabled).toBe(false);
    const mw = createAnalyticsMiddleware(storage, fixedClock());

    // A tool call while OFF records nothing.
    await callTool(mw);
    expect((await storage.queryEvents({})).length).toBe(0);

    // Toggle analytics.enabled ON via the config router (the UI path).
    const app = express();
    app.use(express.json());
    app.use(createConfigRouter()); // defaults to getActiveStorage()
    const put = await request(
      app,
      "PUT",
      "/__enpilink/config/analytics.enabled",
      {
        value: true,
      },
    );
    expect(put.status).toBe(200);

    // Gate flipped live — subsequent calls are captured WITHOUT a restart.
    expect(getCaptureGate().enabled).toBe(true);
    await callTool(mw);
    expect((await storage.queryEvents({})).length).toBe(1);

    // Toggle OFF again → capture stops; the existing row is not removed.
    const off = await request(
      app,
      "PUT",
      "/__enpilink/config/analytics.enabled",
      { value: false },
    );
    expect(off.status).toBe(200);
    expect(getCaptureGate().enabled).toBe(false);
    await callTool(mw);
    expect((await storage.queryEvents({})).length).toBe(1);

    await storage.close();
  });

  it("env override env-locks analytics.enabled (env > db)", async () => {
    process.env.ENPILINK_ANALYTICS = "1";
    const storage = new MemoryStorageAdapter();
    await storage.init();
    // Persist a DB value of false — the env override must still win.
    await storage.setConfig("analytics.enabled", false);
    setActiveStorage(storage);
    await refreshCaptureGate();
    expect(getCaptureGate().enabled).toBe(true);

    // The config UI must render the key env-locked (read-only) and a PUT must
    // be rejected with 409 (pinned via env).
    const app = express();
    app.use(express.json());
    app.use(createConfigRouter());
    const put = await request(
      app,
      "PUT",
      "/__enpilink/config/analytics.enabled",
      {
        value: true,
      },
    );
    expect(put.status).toBe(409);

    await storage.close();
  });

  it("sampleRate=0 records nothing even when enabled", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);
    setCaptureGate({ enabled: true, sampleRate: 0 });
    const mw = createAnalyticsMiddleware(storage, fixedClock(), null, {
      // RNG never matters at sampleRate 0; assert it's not even consulted by
      // forcing a value that would otherwise pass.
      rng: () => 0,
    });
    await callTool(mw);
    expect((await storage.queryEvents({})).length).toBe(0);
    await storage.close();
  });
});
