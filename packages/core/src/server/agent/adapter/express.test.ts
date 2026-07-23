import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActiveStorage, setActiveStorage } from "../../log-sink.js";
import { MemoryStorageAdapter } from "../../storage/memory.js";
import { getAgentCaptureGate, setAgentCaptureGate } from "../capture-gate.js";
import { stopRulesetClient } from "../ruleset/bootstrap.js";
import { setCurrentRuleset } from "../ruleset/holder.js";
import { INITIAL_RULESET } from "../ruleset/initial.js";
import {
  __resetAgentAdapterInstall,
  ensureAgentAdapterInstalled,
} from "./core.js";
import {
  __flushExpressAdapter,
  __resetExpressAdapter,
  agentCapture,
} from "./express.js";

/**
 * Raw HTTP GET that PRESERVES outgoing header-name casing (unlike `fetch`, whose
 * undici core lowercases header names) and returns status + body.
 */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] ?? ""),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A one-shot chat fetcher (eligible for serve) and a crawler (never served). */
const CHATGPT_USER = "ChatGPT-User/1.0";
const GOOGLEBOT = "Googlebot/2.1 (+http://www.google.com/bot.html)";

describe("enpilink/express agentCapture (end-to-end)", () => {
  let storage: MemoryStorageAdapter;
  let server: http.Server;
  let port: number;

  async function boot(
    handler: express.RequestHandler,
    routes?: (app: express.Express) => void,
  ): Promise<void> {
    const app = express();
    app.use(handler);
    routes?.(app);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  }

  beforeEach(async () => {
    __resetExpressAdapter();
    storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);
    setCurrentRuleset(INITIAL_RULESET);
  });

  afterEach(async () => {
    await __flushExpressAdapter();
    __resetExpressAdapter();
    if (server) {
      await new Promise<void>((r) => server.close(() => r()));
    }
    setActiveStorage(null);
    setCurrentRuleset(null);
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
  });

  /** Wait until storage has at least `n` captured rows (buffer flush is async). */
  async function waitForRows(n: number): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      await __flushExpressAdapter();
      const rows = await storage.queryAgentRequests();
      if (rows.length >= n) {
        return;
      }
    }
  }

  it("captures + classifies a request out of the box (one line, no McpServer)", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1 });
    await boot(agentCapture({ skipInstall: true }), (app) => {
      app.get("/", (_req, res) => res.status(200).send("ok"));
    });

    await rawGet(port, "/", {
      "Sec-Ch-Ua": '"Chromium";v="128"',
      "User-Agent": "GPTBot/1.0",
    });
    await waitForRows(1);

    const row = (await storage.queryAgentRequests()).find(
      (r) => r.path === "/",
    );
    expect(row?.status).toBe(200);
    expect(row?.outcome).toBe("resolved");
    expect(row?.agentFamily).toBe("gptbot");
    expect(row?.agentClass).toBe("crawler");
    expect(row?.rulesetVersion).toBe(INITIAL_RULESET.version);
    // Header casing survives (read from req.rawHeaders, not req.headers).
    const names = row?.headers.map((h) => h[0]) ?? [];
    expect(names).toContain("Sec-Ch-Ua");
    // IP hashed, never raw.
    expect(row?.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serves an eligible fetcher's would-be-404, records it as a rescued dead-end", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1, serve: true });
    await boot(agentCapture({ skipInstall: true }), (app) => {
      app.get("/", (_req, res) => res.status(200).send("ok"));
      // /missing has no route → would 404.
    });

    const res = await rawGet(port, "/missing", { "User-Agent": CHATGPT_USER });
    // Rescued: 200 + markdown representation instead of the 404.
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/markdown/);
    expect(res.body.length).toBeGreaterThan(0);

    await waitForRows(1);
    const row = (await storage.queryAgentRequests()).find(
      (r) => r.path === "/missing",
    );
    // Recorded as the dead-end it truly was, marked served.
    expect(row?.outcome).toBe("dead_end");
    expect(row?.served).toBe(true);
    expect(row?.agentClass).toBe("chat-fetcher");
  });

  it("GUARDRAIL: Googlebot's would-be-404 gets the REAL 404, untouched", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1, serve: true });
    await boot(agentCapture({ skipInstall: true }));

    const res = await rawGet(port, "/missing", { "User-Agent": GOOGLEBOT });
    // Crawler → never served. Real Express 404.
    expect(res.status).toBe(404);
    expect(res.contentType).not.toMatch(/text\/markdown/);

    await waitForRows(1);
    const row = (await storage.queryAgentRequests()).find(
      (r) => r.path === "/missing",
    );
    expect(row?.outcome).toBe("dead_end");
    expect(row?.served).toBeFalsy();
    expect(row?.agentClass).toBe("crawler");
  });

  it("re-encodes a real 2xx HTML page to markdown for an eligible fetcher only", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1, reencode: true });
    await boot(agentCapture({ skipInstall: true }), (app) => {
      app.get("/page", (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res
          .status(200)
          .send("<html><body><h1>Hello</h1><p>World</p></body></html>");
      });
    });

    const forAgent = await rawGet(port, "/page", {
      "User-Agent": CHATGPT_USER,
    });
    expect(forAgent.status).toBe(200);
    expect(forAgent.contentType).toMatch(/text\/markdown/);
    expect(forAgent.body).toContain("Hello");

    const forCrawler = await rawGet(port, "/page", { "User-Agent": GOOGLEBOT });
    expect(forCrawler.status).toBe(200);
    expect(forCrawler.contentType).toMatch(/text\/html/);
    expect(forCrawler.body).toContain("<h1>Hello</h1>");
  });

  it("captures NOTHING while the gate is off", async () => {
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
    await boot(agentCapture({ skipInstall: true }), (app) => {
      app.get("/", (_req, res) => res.status(200).send("ok"));
    });
    await rawGet(port, "/", {});
    await new Promise<void>((r) => setTimeout(r, 60));
    await __flushExpressAdapter();
    expect(await storage.queryAgentRequests()).toHaveLength(0);
  });
});

describe("enpilink/express storage auto-activation", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    __resetAgentAdapterInstall();
    setActiveStorage(null);
    // Ephemeral store (no disk artifact) and no ruleset network fetch in the test.
    process.env.ENPILINK_STORAGE = "memory";
    process.env.ENPILINK_CFG_AGENT_RULESET_ENABLED = "0";
    delete process.env.ENPILINK_ANALYTICS;
    delete process.env.ENPILINK_AGENT;
  });

  afterEach(async () => {
    stopRulesetClient();
    __resetAgentAdapterInstall();
    const s = getActiveStorage();
    setActiveStorage(null);
    if (s) {
      await s.close();
    }
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
    process.env = { ...savedEnv };
  });

  it("activates storage and enables capture WITHOUT ENPILINK_ANALYTICS", async () => {
    expect(getActiveStorage()).toBeNull();

    await ensureAgentAdapterInstalled({});

    // Storage was activated by the adapter itself (the M1 quirk handled).
    expect(getActiveStorage()).not.toBeNull();
    // Capture is ON by default — the one-line install IS the opt-in.
    expect(getAgentCaptureGate().enabled).toBe(true);
  });

  it("honors an explicit enabled:false", async () => {
    await ensureAgentAdapterInstalled({ enabled: false });
    expect(getActiveStorage()).not.toBeNull();
    expect(getAgentCaptureGate().enabled).toBe(false);
  });
});
