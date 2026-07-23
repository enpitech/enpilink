import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveStorage } from "../log-sink.js";
import { MemoryStorageAdapter } from "../storage/memory.js";
import { backfillClassification } from "./backfill.js";
import { setAgentCaptureGate } from "./capture-gate.js";
import {
  type AgentCaptureHandle,
  installAgentCapture,
  pruneAgentData,
} from "./express-middleware.js";
import { IpRangeVerifier, type Vendor } from "./ip-ranges.js";
import { INITIAL_RULESET } from "./ruleset/initial.js";

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
    // Inject the initial ruleset so classification runs (the holder is empty by
    // default → rows would be `pending`). The pending path is covered separately.
    handle = installAgentCapture(app, {
      getStorage: () => storage,
      getRuleset: () => INITIAL_RULESET,
    });
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

  it("classifies a GPTBot request as gptbot / crawler / ua-only", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1 });
    await rawGet(port, "/", { "User-Agent": "GPTBot/1.0" });
    await waitForRows(1);
    const row = (await storage.queryAgentRequests()).find(
      (r) => r.path === "/",
    );
    expect(row?.agentFamily).toBe("gptbot");
    expect(row?.agentClass).toBe("crawler");
    // No IP tier ran (flag off) → the UA claim stays unverified/spoofable.
    expect(row?.confidence).toBe("ua-only");
    expect(row?.meta?.spoof).toBeUndefined();
    // Classified rows are stamped with the ruleset version that produced them.
    expect(row?.rulesetVersion).toBe(INITIAL_RULESET.version);
  });

  it("classifies a browser-shaped request as human-or-browser (unnamed)", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1 });
    await rawGet(port, "/", {
      // LOWERCASE client hints + full Sec-Fetch = a real browser shape.
      "sec-ch-ua": '"Chromium";v="149", "Google Chrome";v="149"',
      "sec-ch-ua-mobile": "?0",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    });
    await waitForRows(1);
    const row = (await storage.queryAgentRequests()).find(
      (r) => r.path === "/",
    );
    expect(row?.agentClass).toBe("human-or-browser");
    expect(row?.agentFamily).toBeUndefined();
    expect(row?.confidence).toBe("shape");
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

describe("installAgentCapture — the optional IP tier (agent.verifyIpRanges)", () => {
  let storage: MemoryStorageAdapter;
  let handle: AgentCaptureHandle;
  let server: http.Server;
  let port: number;
  const OPENAI_URL = "https://openai.com/chatgpt-user.json";

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);

    // A verifier pre-loaded with OpenAI's published ChatGPT-User range (the real
    // `52.153.130.64/28` from the probe), served from a stub — no network.
    const lists: Record<Vendor, readonly string[]> = {
      openai: [OPENAI_URL],
      google: [],
      anthropic: [],
      perplexity: [],
    };
    const ipVerifier = new IpRangeVerifier({
      vendorLists: lists,
      fetchJson: async (url) =>
        url === OPENAI_URL
          ? { prefixes: [{ ipv4Prefix: "52.153.130.64/28" }] }
          : {},
    });
    await ipVerifier.refresh("openai");

    const app = express();
    handle = installAgentCapture(app, {
      getStorage: () => storage,
      ipVerifier,
      getRuleset: () => INITIAL_RULESET,
    });
    app.get("/", (_req, res) => {
      res.status(200).send("ok");
    });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
    // Enable capture AND the IP tier.
    setAgentCaptureGate({ enabled: true, sampleRate: 1, verifyIpRanges: true });
  });

  afterEach(async () => {
    await handle.stop();
    await new Promise<void>((r) => server.close(() => r()));
    setActiveStorage(null);
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
    await storage.close();
  });

  async function firstRow() {
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      await handle.stop();
      const rows = await storage.queryAgentRequests();
      if (rows.length >= 1) {
        return rows.find((r) => r.path === "/");
      }
    }
    return undefined;
  }

  it("ChatGPT-User from an OpenAI IP → ip-verified", async () => {
    await rawGet(port, "/", {
      "User-Agent":
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0",
      // Cloudflare's authoritative client IP header (resolveClientIp prefers it).
      "CF-Connecting-IP": "52.153.130.71",
    });
    const row = await firstRow();
    expect(row?.agentFamily).toBe("chatgpt-user");
    expect(row?.confidence).toBe("ip-verified");
    expect(row?.meta?.spoof).toBeUndefined();
  });

  it("GPTBot UA from a NON-OpenAI IP → NOT ip-verified, flagged as a spoof", async () => {
    await rawGet(port, "/", {
      "User-Agent": "GPTBot/1.0",
      "CF-Connecting-IP": "8.8.8.8",
    });
    const row = await firstRow();
    expect(row?.agentFamily).toBe("gptbot");
    // Stays at the spoofable UA-only tier — the IP did not back the claim.
    expect(row?.confidence).toBe("ua-only");
    expect(row?.meta?.spoof).toBe(true);
  });
});

describe("installAgentCapture — the capture/classify split (no ruleset → pending)", () => {
  let storage: MemoryStorageAdapter;
  let handle: AgentCaptureHandle;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);

    const app = express();
    // NO ruleset loaded (getRuleset returns null) — the no-baseline default.
    handle = installAgentCapture(app, {
      getStorage: () => storage,
      getRuleset: () => null,
    });
    app.get("/", (_req, res) => {
      res.status(200).send("ok");
    });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
    setAgentCaptureGate({ enabled: true, sampleRate: 1 });
  });

  afterEach(async () => {
    await handle.stop();
    await new Promise<void>((r) => server.close(() => r()));
    setActiveStorage(null);
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
    await storage.close();
  });

  async function firstRow() {
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      await handle.stop();
      const rows = await storage.queryAgentRequests();
      if (rows.length >= 1) {
        return rows.find((r) => r.path === "/");
      }
    }
    return undefined;
  }

  it("captures the raw row but leaves classification PENDING (distinguishable from unknown)", async () => {
    await rawGet(port, "/", { "User-Agent": "GPTBot/1.0" });
    const row = await firstRow();
    // Capture is ruleset-INDEPENDENT — the raw row is fully written.
    expect(row?.status).toBe(200);
    expect(row?.outcome).toBe("resolved");
    expect(row?.ua).toBe("GPTBot/1.0");
    expect(row?.ipHash).toMatch(/^[0-9a-f]{64}$/);
    // But classification is deferred: pending, NOT a wrong "unknown" verdict.
    expect(row?.confidence).toBe("pending");
    expect(row?.agentFamily).toBeUndefined();
    expect(row?.agentClass).toBeUndefined();
    expect(row?.rulesetVersion).toBeUndefined();
  });

  it("backfill labels the pending row once a ruleset is available", async () => {
    await rawGet(port, "/", { "User-Agent": "GPTBot/1.0" });
    const pending = await firstRow();
    expect(pending?.confidence).toBe("pending");

    // A ruleset arrives (as D2 would deliver it) → backfill re-classifies.
    const result = await backfillClassification(storage, INITIAL_RULESET);
    expect(result.reclassified).toBe(1);

    const row = (await storage.queryAgentRequests()).find(
      (r) => r.path === "/",
    );
    expect(row?.agentFamily).toBe("gptbot");
    expect(row?.agentClass).toBe("crawler");
    expect(row?.confidence).toBe("ua-only");
    expect(row?.rulesetVersion).toBe(INITIAL_RULESET.version);
  });
});
