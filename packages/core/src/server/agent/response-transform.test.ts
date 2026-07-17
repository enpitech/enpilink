import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveStorage } from "../log-sink.js";
import { MemoryStorageAdapter } from "../storage/memory.js";
import { setAgentCaptureGate } from "./capture-gate.js";
import {
  type AgentCaptureHandle,
  installAgentCapture,
} from "./express-middleware.js";
import { installAgentResponseTransform } from "./response-transform.js";

/** Raw HTTP GET preserving header casing (like route.test.ts). */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            contentType: String(res.headers["content-type"] ?? ""),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const CHATGPT = { "User-Agent": "Mozilla/5.0; compatible; ChatGPT-User/1.0" };
const GOOGLEBOT = { "User-Agent": "Googlebot/2.1" };
const HUMAN = {
  "sec-ch-ua": '"Chromium";v="149"',
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,*/*",
};

const TRANSFORM_OPTS = {
  getTools: () => [
    {
      name: "search_catalog",
      description: "Search the product catalog.",
      params: [{ name: "q", required: true, type: "string" }],
    },
  ],
  getSiteInfo: () => ({ facts: ["Ships worldwide"] }),
  getServerName: () => "srv",
};

const SHELL =
  '<!doctype html><html><head><title>App</title></head><body><div id="app"></div><script>boot()</script></body></html>';

describe("installAgentResponseTransform — SPA-replace (agent.spa)", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    const app = express();
    // Transform middleware FIRST (constructor order), then the app: an /api JSON
    // route, then a catch-all that serves the SPA shell on EVERY other path (the
    // gap the 404-rescue can't close — a 200 on every route).
    installAgentResponseTransform(app, TRANSFORM_OPTS);
    app.get("/api", (_req, res) => {
      res.json({ ok: true });
    });
    app.use((_req, res) => {
      res.status(200).type("html").send(SHELL);
    });

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
  });

  it("does nothing while agent.spa is off — the shell is served as-is", async () => {
    setAgentCaptureGate({ enabled: false, sampleRate: 1, spa: false });
    const res = await rawGet(port, "/products", CHATGPT);
    expect(res.body).toBe(SHELL);
    expect(res.contentType).not.toContain("text/markdown");
  });

  describe("with agent.spa on", () => {
    beforeEach(() => {
      setAgentCaptureGate({
        enabled: false,
        sampleRate: 1,
        spa: true,
        siteTitle: "Acme Store",
        siteDescription: "Sells running shoes.",
      });
    });

    it("REPLACES the shell with the declared representation for a chat fetcher", async () => {
      const res = await rawGet(port, "/products", CHATGPT);
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("text/markdown");
      // The declared source, not the empty shell.
      expect(res.body).toContain("Acme Store");
      expect(res.body).toContain("search_catalog");
      expect(res.body).toContain("Ships worldwide");
      expect(res.body).not.toContain('id="app"');
    });

    it("gives Googlebot the shell UNTOUCHED — the cloaking guardrail", async () => {
      const res = await rawGet(port, "/products", GOOGLEBOT);
      expect(res.body).toBe(SHELL);
      expect(res.contentType).not.toContain("text/markdown");
    });

    it("gives a real browser the shell untouched", async () => {
      const res = await rawGet(port, "/products", HUMAN);
      expect(res.body).toBe(SHELL);
      expect(res.contentType).not.toContain("text/markdown");
    });

    it("never touches a non-HTML (JSON) response, even for a chat fetcher", async () => {
      const res = await rawGet(port, "/api", CHATGPT);
      expect(res.contentType).toContain("application/json");
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });
  });
});

describe("installAgentResponseTransform — HTML re-encode (agent.reencode)", () => {
  let server: http.Server;
  let port: number;
  const PAGE = "<h1>Widgets</h1><ul><li>Blue widget €5</li></ul>";

  beforeEach(async () => {
    const app = express();
    installAgentResponseTransform(app, TRANSFORM_OPTS);
    app.get("/page", (_req, res) => {
      res.type("html").send(PAGE);
    });
    app.get("/api", (_req, res) => {
      res.json({ ok: true });
    });

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
  });

  it("passes HTML through for everyone while agent.reencode is off", async () => {
    setAgentCaptureGate({ enabled: false, sampleRate: 1, reencode: false });
    const res = await rawGet(port, "/page", CHATGPT);
    expect(res.body).toBe(PAGE);
    expect(res.contentType).toContain("text/html");
  });

  describe("with agent.reencode on", () => {
    beforeEach(() => {
      setAgentCaptureGate({ enabled: false, sampleRate: 1, reencode: true });
    });

    it("re-encodes HTML to markdown WITH THE SAME FACTS for a chat fetcher", async () => {
      const res = await rawGet(port, "/page", CHATGPT);
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("text/markdown");
      // Same facts, different encoding — the price survives, the tags are gone.
      expect(res.body).toContain("# Widgets");
      expect(res.body).toContain("Blue widget €5");
      expect(res.body).not.toContain("<h1>");
      expect(res.body).not.toContain("<ul>");
    });

    it("gives Googlebot the ORIGINAL HTML, byte-identical (guardrail)", async () => {
      const withLayer = await rawGet(port, "/page", GOOGLEBOT);
      expect(withLayer.body).toBe(PAGE);
      expect(withLayer.contentType).toContain("text/html");
      expect(withLayer.contentType).not.toContain("text/markdown");
    });

    it("gives a real browser the original HTML untouched", async () => {
      const res = await rawGet(port, "/page", HUMAN);
      expect(res.body).toBe(PAGE);
      expect(res.contentType).toContain("text/html");
    });

    it("never touches a JSON API response", async () => {
      const res = await rawGet(port, "/api", CHATGPT);
      expect(res.contentType).toContain("application/json");
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });

    it("never transforms a would-be-404 (only 2xx HTML) — real 404 passes", async () => {
      const res = await rawGet(port, "/missing", CHATGPT);
      expect(res.status).toBe(404);
      expect(res.contentType).not.toContain("text/markdown");
    });
  });
});

describe("response-transform telemetry (capture + transform together)", () => {
  let storage: MemoryStorageAdapter;
  let handle: AgentCaptureHandle;
  let server: http.Server;
  let port: number;

  async function boot(gateExtras: Record<string, unknown>): Promise<void> {
    storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);

    const app = express();
    handle = installAgentCapture(app, { getStorage: () => storage });
    installAgentResponseTransform(app, TRANSFORM_OPTS);
    app.get("/page", (_req, res) => {
      res.type("html").send("<h1>Widgets</h1>");
    });
    app.use((_req, res) => {
      res.status(200).type("html").send(SHELL);
    });

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;

    setAgentCaptureGate({ enabled: true, sampleRate: 1, ...gateExtras });
  }

  afterEach(async () => {
    await handle.stop();
    await new Promise<void>((r) => server.close(() => r()));
    setActiveStorage(null);
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
    await storage.close();
  });

  async function waitForRow(path: string) {
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      await handle.stop();
      const row = (await storage.queryAgentRequests()).find(
        (r) => r.path === path,
      );
      if (row) {
        return row;
      }
    }
    return undefined;
  }

  it("records a re-encoded response as resolved + meta.reencoded (not served)", async () => {
    await boot({ reencode: true });
    const res = await rawGet(port, "/page", CHATGPT);
    expect(res.contentType).toContain("text/markdown");

    const row = await waitForRow("/page");
    expect(row?.status).toBe(200);
    expect(row?.outcome).toBe("resolved");
    expect(row?.served).toBeUndefined();
    expect(row?.meta?.reencoded).toBe(true);
  });

  it("records an SPA-replaced shell as resolved + served + meta.spa", async () => {
    await boot({ spa: true, siteTitle: "Acme", siteDescription: "Shoes." });
    const res = await rawGet(port, "/anything", CHATGPT);
    expect(res.contentType).toContain("text/markdown");

    const row = await waitForRow("/anything");
    expect(row?.status).toBe(200);
    // A served 200 is a genuine resolve (distinct from the 404-rescue's dead_end).
    expect(row?.outcome).toBe("resolved");
    expect(row?.served).toBe(true);
    expect(row?.servedEncoding).toBe("markdown");
    expect(row?.meta?.spa).toBe(true);
  });
});
