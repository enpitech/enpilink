import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveStorage } from "../log-sink.js";
import { MemoryStorageAdapter } from "../storage/memory.js";
import { setAgentCaptureGate } from "./capture-gate.js";
import {
  type AgentCaptureHandle,
  installAgentCapture,
  pruneAgentData,
} from "./express-middleware.js";

/**
 * Raw HTTP GET that PRESERVES outgoing header-name casing (unlike `fetch`, whose
 * undici core lowercases header names). This is essential: the test's whole
 * point is that title-cased `Sec-Ch-Ua` survives to storage.
 */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("installAgentCapture (Express, end-to-end)", () => {
  let storage: MemoryStorageAdapter;
  let handle: AgentCaptureHandle;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);

    const app = express();
    handle = installAgentCapture(app, { getStorage: () => storage });
    app.get("/", (_req, res) => {
      res.status(200).send("ok");
    });
    // Everything else falls through to Express's 404 finalhandler.

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await handle.stop();
    await new Promise<void>((r) => server.close(() => r()));
    setActiveStorage(null);
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
    await storage.close();
  });

  /** Wait until storage has at least `n` captured rows (buffer flush is async). */
  async function waitForRows(n: number): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      await handle.stop();
      const rows = await storage.queryAgentRequests();
      if (rows.length >= n) {
        return;
      }
    }
  }

  it("captures NOTHING while the gate is off (off by default)", async () => {
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
    await rawGet(port, "/", {});
    await new Promise<void>((r) => setTimeout(r, 60));
    await handle.stop();
    expect(await storage.queryAgentRequests()).toHaveLength(0);
  });

  it("captures exactly one resolved + one dead_end, preserving header casing + hashing the IP", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1 });

    // Title-cased Sec-Ch-Ua is the discriminator: a real Chrome sends it
    // lowercase, a disguised library title-cases it. It MUST survive verbatim.
    await rawGet(port, "/", {
      "Sec-Ch-Ua": '"Chromium";v="128"',
      "User-Agent": "GPTBot/1.0",
    });
    await rawGet(port, "/nope", { "User-Agent": "GPTBot/1.0" });

    await waitForRows(2);
    const rows = await storage.queryAgentRequests();
    expect(rows).toHaveLength(2);

    const byPath = new Map(rows.map((r) => [r.path, r]));
    const root = byPath.get("/");
    const nope = byPath.get("/nope");
    expect(root?.status).toBe(200);
    expect(root?.outcome).toBe("resolved");
    expect(nope?.status).toBe(404);
    expect(nope?.outcome).toBe("dead_end");

    // Header casing preserved (read from req.rawHeaders, not req.headers).
    const names = root?.headers.map((h) => h[0]) ?? [];
    expect(names).toContain("Sec-Ch-Ua");
    expect(names).not.toContain("sec-ch-ua");
    expect(root?.ua).toBe("GPTBot/1.0");
    expect(root?.httpVersion).toBe("1.1");

    // IP is hashed, never stored raw.
    expect(root?.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(root?.ipHash).not.toContain("127.0.0.1");
  });

  it("does not touch the events table (MCP dashboard stays clean)", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1 });
    await rawGet(port, "/", {});
    await waitForRows(1);
    expect(await storage.queryEvents({})).toHaveLength(0);
  });

  it("prune() with a 1-day window deletes rows older than the window", async () => {
    // Seed one fresh row and one that is 2 days old.
    const now = Date.now();
    await storage.recordAgentRequests([
      {
        ts: now,
        siteId: "default",
        method: "GET",
        path: "/fresh",
        status: 200,
        outcome: "resolved",
        httpVersion: "1.1",
        headers: [["Host", "x"]],
        confidence: "none",
      },
      {
        ts: now - 2 * 86_400_000,
        siteId: "default",
        method: "GET",
        path: "/stale",
        status: 200,
        outcome: "resolved",
        httpVersion: "1.1",
        headers: [["Host", "x"]],
        confidence: "none",
      },
    ]);
    expect(await storage.queryAgentRequests()).toHaveLength(2);

    const removed = await pruneAgentData(storage, 1, now);
    expect(removed).toBe(1);
    const left = await storage.queryAgentRequests();
    expect(left).toHaveLength(1);
    expect(left[0]?.path).toBe("/fresh");
  });
});
