import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveStorage } from "../log-sink.js";
import { MemoryStorageAdapter } from "../storage/memory.js";
import type { HeaderPair } from "../storage/types.js";
import { setAgentCaptureGate } from "./capture-gate.js";
import { classify } from "./detect.js";
import {
  type AgentCaptureHandle,
  installAgentCapture,
} from "./express-middleware.js";
import {
  agentServeEligibility,
  decideAgentServe,
  installAgentRouting,
} from "./route.js";

/** Real classifier output for representative header sets (grounds the tests in
 * M2's actual behaviour rather than hand-built stubs). */
const CHATGPT: HeaderPair[] = [
  [
    "User-Agent",
    "Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0",
  ],
];
const GOOGLEBOT: HeaderPair[] = [["User-Agent", "Googlebot/2.1"]];
const CURL: HeaderPair[] = [["User-Agent", "curl/8.7.1"]];
const HUMAN: HeaderPair[] = [
  ["sec-ch-ua", '"Chromium";v="149"'],
  ["Sec-Fetch-Site", "none"],
  ["Sec-Fetch-Mode", "navigate"],
  ["Sec-Fetch-Dest", "document"],
  [
    "User-Agent",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  ],
];

describe("decideAgentServe (the guardrail, pure)", () => {
  const base = { serve: true, method: "GET", path: "/", accept: "*/*" };

  it("is a no-op when serving is disabled (off by default)", () => {
    const d = decideAgentServe({
      ...base,
      serve: false,
      detection: classify(CHATGPT),
    });
    expect(d.action).toBe("pass");
  });

  it("serves a chat-fetcher its representation", () => {
    const d = decideAgentServe({ ...base, detection: classify(CHATGPT) });
    expect(d).toEqual({ action: "serve", encoding: "markdown" });
  });

  it("ALWAYS passes a crawler through — the cloaking guardrail", () => {
    expect(
      decideAgentServe({ ...base, detection: classify(GOOGLEBOT) }).action,
    ).toBe("pass");
    // Even an explicit markdown Accept does NOT differentiate a crawler.
    expect(
      decideAgentServe({
        ...base,
        accept: "text/markdown",
        detection: classify(GOOGLEBOT),
      }).action,
    ).toBe("pass");
  });

  it("passes human-or-browser through (no way to tell a human apart)", () => {
    const d = decideAgentServe({
      ...base,
      accept: "text/html,application/xhtml+xml,*/*",
      detection: classify(HUMAN),
    });
    expect(d.action).toBe("pass");
  });

  it("serves markdown to ANY non-crawler that explicitly asks for it", () => {
    const d = decideAgentServe({
      ...base,
      accept: "text/markdown",
      detection: classify(CURL),
    });
    expect(d).toEqual({ action: "serve", encoding: "markdown" });
  });

  it("does not serve a plain tool that did not ask for markdown", () => {
    const d = decideAgentServe({ ...base, detection: classify(CURL) });
    expect(d.action).toBe("pass");
  });

  it("never intercepts the /mcp endpoint or the admin plane", () => {
    for (const path of ["/mcp", "/__enpilink/config", "/.well-known/x"]) {
      const d = decideAgentServe({
        ...base,
        path,
        detection: classify(CHATGPT),
      });
      expect(d.action).toBe("pass");
    }
  });

  it("passes static subresources through (never clobbers an asset/API file)", () => {
    for (const path of ["/style.css", "/app.js", "/robots.txt", "/data.json"]) {
      const d = decideAgentServe({
        ...base,
        path,
        detection: classify(CHATGPT),
      });
      expect(d.action).toBe("pass");
    }
  });

  it("leaves non-GET methods entirely alone", () => {
    const d = decideAgentServe({
      ...base,
      method: "POST",
      detection: classify(CHATGPT),
    });
    expect(d.action).toBe("pass");
  });

  it("negotiates HTML for a strict text/html client (no wildcard)", () => {
    const d = decideAgentServe({
      ...base,
      accept: "text/html",
      detection: classify(CHATGPT),
    });
    expect(d).toEqual({ action: "serve", encoding: "html" });
  });
});

describe("agentServeEligibility (the shared guardrail, pure)", () => {
  const base = { method: "GET", path: "/", accept: "*/*" };

  it("is eligible for a chat fetcher, encoding markdown by default", () => {
    expect(
      agentServeEligibility({ ...base, detection: classify(CHATGPT) }),
    ).toEqual({ eligible: true, encoding: "markdown", reason: "eligible" });
  });

  it("negotiates HTML for a strict text/html chat fetcher", () => {
    const e = agentServeEligibility({
      ...base,
      accept: "text/html",
      detection: classify(CHATGPT),
    });
    expect(e).toEqual({ eligible: true, encoding: "html", reason: "eligible" });
  });

  it("is NEVER eligible for a crawler (Googlebot) — the guardrail", () => {
    expect(
      agentServeEligibility({ ...base, detection: classify(GOOGLEBOT) }),
    ).toMatchObject({ eligible: false, reason: "crawler" });
  });

  it("is NEVER eligible for human-or-browser", () => {
    expect(
      agentServeEligibility({
        ...base,
        accept: "text/html,application/xhtml+xml,*/*",
        detection: classify(HUMAN),
      }),
    ).toMatchObject({ eligible: false });
  });

  it("is ineligible for a subresource, an excluded surface, and non-GET", () => {
    expect(
      agentServeEligibility({
        ...base,
        path: "/app.js",
        detection: classify(CHATGPT),
      }),
    ).toMatchObject({ eligible: false, reason: "subresource" });
    expect(
      agentServeEligibility({
        ...base,
        path: "/mcp",
        detection: classify(CHATGPT),
      }),
    ).toMatchObject({ eligible: false, reason: "excluded-path" });
    expect(
      agentServeEligibility({
        ...base,
        method: "POST",
        detection: classify(CHATGPT),
      }),
    ).toMatchObject({ eligible: false, reason: "non-get" });
  });
});

/** Raw HTTP GET returning status + body + content-type (preserves the header
 * casing detection depends on, unlike `fetch`). */
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

describe("installAgentRouting (trailing 404-rescue fallback, end-to-end)", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    const app = express();
    // User routes FIRST: a real 2xx route must respond BEFORE the fallback runs,
    // so its content passes through untouched. The fallback is installed LAST.
    app.get("/", (_req, res) => {
      res.status(200).send("NORMAL HOMEPAGE");
    });
    app.get("/products/blue", (_req, res) => {
      res.status(200).send("NORMAL PRODUCT PAGE");
    });
    installAgentRouting(app, {
      getTools: () => [
        {
          name: "search_catalog",
          description: "Search the product catalog.",
          params: [{ name: "q", required: true, type: "string" }],
        },
      ],
      // `facts` come only from the code declaration; title/description are
      // supplied by the gate below (config) to prove config precedence.
      getSiteInfo: () => ({ facts: ["Ships worldwide"] }),
      getServerName: () => "fallback-name",
    });

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
  });

  it("does nothing while agent.serve is off — a would-be-404 stays a 404", async () => {
    setAgentCaptureGate({ enabled: false, sampleRate: 1, serve: false });
    const res = await rawGet(port, "/nope", {
      "User-Agent": "ChatGPT-User/1.0",
    });
    expect(res.status).toBe(404);
    expect(res.contentType).not.toContain("text/markdown");
  });

  describe("with agent.serve on", () => {
    beforeEach(() => {
      setAgentCaptureGate({
        enabled: false,
        sampleRate: 1,
        serve: true,
        siteTitle: "Acme Store",
        siteDescription: "Sells running shoes.",
      });
    });

    it("RESCUES a chat fetcher's would-be-404 with a self-sufficient markdown doc", async () => {
      const res = await rawGet(port, "/nope", {
        "User-Agent": "Mozilla/5.0; compatible; ChatGPT-User/1.0",
      });
      // A missing page becomes a useful 200 answer for the one-shot agent.
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("text/markdown");
      // Names the app (config title) + the tool + the code-declared fact.
      expect(res.body).toContain("Acme Store");
      expect(res.body).toContain("search_catalog");
      expect(res.body).toContain("Ships worldwide");
    });

    it("passes a REAL 2xx route through UNTOUCHED (never replaces real content)", async () => {
      const home = await rawGet(port, "/", {
        "User-Agent": "Mozilla/5.0; compatible; ChatGPT-User/1.0",
      });
      expect(home.status).toBe(200);
      expect(home.body).toBe("NORMAL HOMEPAGE");
      expect(home.contentType).not.toContain("text/markdown");
      const prod = await rawGet(port, "/products/blue", {
        "User-Agent": "ChatGPT-User/1.0",
      });
      expect(prod.body).toBe("NORMAL PRODUCT PAGE");
    });

    it("gives Googlebot the REAL 404 on a missing URL — never rescued (guardrail)", async () => {
      const withLayer = await rawGet(port, "/nope", {
        "User-Agent": "Googlebot/2.1",
      });
      // Byte-identical to the same request with serving OFF: no differentiation.
      setAgentCaptureGate({ enabled: false, sampleRate: 1, serve: false });
      const noLayer = await rawGet(port, "/nope", {
        "User-Agent": "Googlebot/2.1",
      });
      expect(withLayer.status).toBe(404);
      expect(withLayer.contentType).not.toContain("text/markdown");
      expect(withLayer.body).toBe(noLayer.body);
      expect(withLayer.status).toBe(noLayer.status);
    });

    it("gives a real browser the real 404 on a missing URL", async () => {
      const res = await rawGet(port, "/nope", {
        "sec-ch-ua": '"Chromium";v="149"',
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*",
      });
      expect(res.status).toBe(404);
      expect(res.contentType).not.toContain("text/markdown");
    });

    it("honours Accept: text/markdown as a RESCUE only, never over real content", async () => {
      // Real route: real content passes through even with a markdown ask.
      const real = await rawGet(port, "/", {
        "User-Agent": "curl/8.7.1",
        Accept: "text/markdown",
      });
      expect(real.body).toBe("NORMAL HOMEPAGE");
      // Missing route: the markdown ask rescues the would-be-404.
      const missing = await rawGet(port, "/nope", {
        "User-Agent": "curl/8.7.1",
        Accept: "text/markdown",
      });
      expect(missing.status).toBe(200);
      expect(missing.contentType).toContain("text/markdown");
      expect(missing.body).toContain("search_catalog");
    });

    it("makes every MISSING deep path a front door (rescued, no product page seen)", async () => {
      const res = await rawGet(port, "/products/does-not-exist", {
        "User-Agent": "ChatGPT-User/1.0",
      });
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("text/markdown");
      expect(res.body).toContain("search_catalog");
      expect(res.body).not.toContain("NORMAL PRODUCT PAGE");
    });
  });
});

describe("honest 404-rescue recording (capture + routing together)", () => {
  let storage: MemoryStorageAdapter;
  let handle: AgentCaptureHandle;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);

    const app = express();
    // Capture FIRST (constructor order): it registers `res.on("finish", record)`
    // at request entry, so it reads the locals the trailing fallback sets.
    handle = installAgentCapture(app, { getStorage: () => storage });
    app.get("/", (_req, res) => {
      res.status(200).send("HOME");
    });
    // Rescue fallback LAST.
    installAgentRouting(app, {
      getTools: () => [{ name: "search_catalog", params: [] }],
      getSiteInfo: () => ({ title: "Acme", description: "Sells shoes." }),
      getServerName: () => "srv",
    });

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;

    // Both capture AND serving on (they share one gate).
    setAgentCaptureGate({
      enabled: true,
      sampleRate: 1,
      serve: true,
      siteTitle: "Acme",
      siteDescription: "Sells shoes.",
    });
  });

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

  it("records a rescued would-be-404 as dead_end + served=1, status 200", async () => {
    const res = await rawGet(port, "/nope", {
      "User-Agent": "Mozilla/5.0; compatible; ChatGPT-User/1.0",
    });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/markdown");

    const row = await waitForRow("/nope");
    // The honest record: 200 sent, but outcome is the pre-rescue dead-end, and
    // the served flag marks it as rescued — so deadEndRate stays truthful and the
    // served+dead_end segment counts as `rescuedDeadEnds`.
    expect(row?.status).toBe(200);
    expect(row?.outcome).toBe("dead_end");
    expect(row?.served).toBe(true);
    expect(row?.servedEncoding).toBe("markdown");
  });

  it("records a human's real 404 as dead_end + served unset (never rescued)", async () => {
    const res = await rawGet(port, "/nope", {
      "sec-ch-ua": '"Chromium";v="149"',
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,*/*",
    });
    expect(res.status).toBe(404);

    const row = await waitForRow("/nope");
    expect(row?.status).toBe(404);
    expect(row?.outcome).toBe("dead_end");
    expect(row?.served).toBeUndefined();
  });
});
