import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HeaderPair } from "../storage/types.js";
import { setAgentCaptureGate } from "./capture-gate.js";
import { classify } from "./detect.js";
import { decideAgentServe, installAgentRouting } from "./route.js";

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

describe("installAgentRouting (Express, end-to-end)", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    const app = express();
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
    app.get("/", (_req, res) => {
      res.status(200).send("NORMAL HOMEPAGE");
    });
    app.get("/products/blue", (_req, res) => {
      res.status(200).send("NORMAL PRODUCT PAGE");
    });

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
  });

  it("does nothing while agent.serve is off (default)", async () => {
    setAgentCaptureGate({ enabled: false, sampleRate: 1, serve: false });
    const res = await rawGet(port, "/", { "User-Agent": "ChatGPT-User/1.0" });
    expect(res.body).toBe("NORMAL HOMEPAGE");
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

    it("serves a self-sufficient markdown doc to a chat fetcher", async () => {
      const res = await rawGet(port, "/", {
        "User-Agent": "Mozilla/5.0; compatible; ChatGPT-User/1.0",
      });
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("text/markdown");
      // Names the app (config title) + the tool + the code-declared fact.
      expect(res.body).toContain("Acme Store");
      expect(res.body).toContain("search_catalog");
      expect(res.body).toContain("Ships worldwide");
      // It REPLACED the normal page — the whole point for a one-shot agent.
      expect(res.body).not.toContain("NORMAL HOMEPAGE");
    });

    it("gives Googlebot the NORMAL page, byte-identical to no-agent-layer", async () => {
      const withLayer = await rawGet(port, "/", {
        "User-Agent": "Googlebot/2.1",
      });
      // Compare against the same request with serving OFF.
      setAgentCaptureGate({ enabled: false, sampleRate: 1, serve: false });
      const noLayer = await rawGet(port, "/", {
        "User-Agent": "Googlebot/2.1",
      });
      expect(withLayer.body).toBe("NORMAL HOMEPAGE");
      expect(withLayer.body).toBe(noLayer.body);
      expect(withLayer.status).toBe(noLayer.status);
    });

    it("gives a real browser the normal page", async () => {
      const res = await rawGet(port, "/", {
        "sec-ch-ua": '"Chromium";v="149"',
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*",
      });
      expect(res.body).toBe("NORMAL HOMEPAGE");
    });

    it("honours Accept: text/markdown regardless of UA", async () => {
      const res = await rawGet(port, "/", {
        "User-Agent": "curl/8.7.1",
        Accept: "text/markdown",
      });
      expect(res.contentType).toContain("text/markdown");
      expect(res.body).toContain("search_catalog");
    });

    it("makes every entry point a front door (deep path, no homepage seen)", async () => {
      const res = await rawGet(port, "/products/blue", {
        "User-Agent": "ChatGPT-User/1.0",
      });
      expect(res.contentType).toContain("text/markdown");
      expect(res.body).toContain("search_catalog");
      expect(res.body).not.toContain("NORMAL PRODUCT PAGE");
    });
  });
});
