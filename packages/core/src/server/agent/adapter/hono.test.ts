import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveStorage } from "../../log-sink.js";
import { MemoryStorageAdapter } from "../../storage/memory.js";
import { setAgentCaptureGate } from "../capture-gate.js";
import { setCurrentRuleset } from "../ruleset/holder.js";
import { INITIAL_RULESET } from "../ruleset/initial.js";
import {
  __flushHonoAdapter,
  __resetHonoAdapter,
  agentCapture,
  type HonoContextLike,
  type HonoMiddleware,
} from "./hono.js";

/**
 * Hono isn't a repo dependency (the adapter is typed structurally, like
 * `enpilink/next`), so these tests drive the middleware against a faithful
 * `@hono/node-server` context: `c.env.incoming.rawHeaders` (original casing/order),
 * a Web `Request`, and a mutable `c.res` that `next()` populates like a route (or
 * Hono's default 404).
 */

const CHATGPT_USER = "ChatGPT-User/1.0";
const GOOGLEBOT = "Googlebot/2.1 (+http://www.google.com/bot.html)";

/** Flatten a header map into Node's `[name, value, name, value, …]` rawHeaders. */
function flatHeaders(h: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(h)) {
    out.push(k, v);
  }
  return out;
}

interface CtxOpts {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  /** Original-casing raw headers (defaults to a flatten of `headers`). */
  rawHeaders?: string[];
  /** Omit the Node incoming binding to exercise the Web-Headers fallback path. */
  edgeOnly?: boolean;
}

function makeCtx(opts: CtxOpts): HonoContextLike {
  const headers = opts.headers ?? {};
  const req = new Request(`http://localhost${opts.path}`, {
    method: opts.method ?? "GET",
    headers,
  });
  const ctx: HonoContextLike = {
    req: { raw: req, method: opts.method ?? "GET", path: opts.path },
    // Pre-set to a placeholder; `next()` replaces it like a real route.
    res: new Response(null, { status: 200 }),
  };
  if (!opts.edgeOnly) {
    ctx.env = {
      incoming: {
        rawHeaders: opts.rawHeaders ?? flatHeaders(headers),
        httpVersion: "1.1",
        socket: { remoteAddress: "127.0.0.1" },
      },
    };
  }
  return ctx;
}

/** Run the middleware; `downstream` sets `c.res` like a matched route / 404. */
async function run(
  mw: HonoMiddleware,
  c: HonoContextLike,
  downstream: (c: HonoContextLike) => void,
): Promise<void> {
  await mw(c, async () => {
    downstream(c);
  });
}

/** A route that 404s (nothing matched). */
function notFound(c: HonoContextLike): void {
  c.res = new Response("404 Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** A route that returns a 2xx HTML page. */
function htmlPage(c: HonoContextLike): void {
  c.res = new Response("<html><body><h1>Hello</h1><p>World</p></body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("enpilink/hono agentCapture", () => {
  let storage: MemoryStorageAdapter;

  beforeEach(async () => {
    __resetHonoAdapter();
    storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);
    setCurrentRuleset(INITIAL_RULESET);
  });

  afterEach(async () => {
    await __flushHonoAdapter();
    __resetHonoAdapter();
    setActiveStorage(null);
    setCurrentRuleset(null);
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
    await storage.close();
  });

  async function waitForRows(n: number): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      await __flushHonoAdapter();
      if ((await storage.queryAgentRequests()).length >= n) {
        return;
      }
    }
  }

  it("captures + classifies, preserving raw header casing from the Node incoming", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1 });
    const mw = agentCapture({ skipInstall: true });
    const c = makeCtx({
      path: "/",
      // Title-cased Sec-Ch-Ua must survive via c.env.incoming.rawHeaders.
      rawHeaders: [
        "Sec-Ch-Ua",
        '"Chromium";v="128"',
        "User-Agent",
        "GPTBot/1.0",
      ],
      headers: { "user-agent": "GPTBot/1.0" },
    });
    await run(mw, c, (ctx) => {
      ctx.res = new Response("ok", { status: 200 });
    });

    await waitForRows(1);
    const row = (await storage.queryAgentRequests()).find(
      (r) => r.path === "/",
    );
    expect(row?.status).toBe(200);
    expect(row?.outcome).toBe("resolved");
    expect(row?.agentFamily).toBe("gptbot");
    expect(row?.agentClass).toBe("crawler");
    expect(row?.httpVersion).toBe("1.1");
    // Full Node fidelity: original casing survived.
    expect(row?.headers.map((h) => h[0])).toContain("Sec-Ch-Ua");
    expect(row?.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serves an eligible fetcher's would-be-404 and records the rescued dead-end", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1, serve: true });
    const mw = agentCapture({ skipInstall: true });
    const c = makeCtx({
      path: "/missing",
      headers: { "user-agent": CHATGPT_USER },
    });
    await run(mw, c, notFound);

    expect(c.res.status).toBe(200);
    expect(c.res.headers.get("content-type")).toMatch(/text\/markdown/);
    expect((await c.res.text()).length).toBeGreaterThan(0);

    await waitForRows(1);
    const row = (await storage.queryAgentRequests()).find(
      (r) => r.path === "/missing",
    );
    expect(row?.outcome).toBe("dead_end");
    expect(row?.served).toBe(true);
    expect(row?.agentClass).toBe("chat-fetcher");
  });

  it("GUARDRAIL: Googlebot's would-be-404 stays the REAL 404, untouched", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1, serve: true });
    const mw = agentCapture({ skipInstall: true });
    const c = makeCtx({
      path: "/missing",
      headers: { "user-agent": GOOGLEBOT },
    });
    await run(mw, c, notFound);

    expect(c.res.status).toBe(404);
    expect(c.res.headers.get("content-type")).not.toMatch(/text\/markdown/);

    await waitForRows(1);
    const row = (await storage.queryAgentRequests()).find(
      (r) => r.path === "/missing",
    );
    expect(row?.outcome).toBe("dead_end");
    expect(row?.served).toBeFalsy();
    expect(row?.agentClass).toBe("crawler");
  });

  it("re-encodes a 2xx HTML page to markdown for an eligible fetcher only", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1, reencode: true });
    const mw = agentCapture({ skipInstall: true });

    const agentCtx = makeCtx({
      path: "/page",
      headers: { "user-agent": CHATGPT_USER },
    });
    await run(mw, agentCtx, htmlPage);
    expect(agentCtx.res.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(await agentCtx.res.text()).toContain("Hello");

    const crawlerCtx = makeCtx({
      path: "/page",
      headers: { "user-agent": GOOGLEBOT },
    });
    await run(mw, crawlerCtx, htmlPage);
    expect(crawlerCtx.res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await crawlerCtx.res.text()).toContain("<h1>Hello</h1>");
  });

  it("falls back to Web Headers when no Node incoming is present (edge-shaped)", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1 });
    const mw = agentCapture({ skipInstall: true });
    const c = makeCtx({
      path: "/",
      headers: { "user-agent": "GPTBot/1.0" },
      edgeOnly: true,
    });
    await run(mw, c, (ctx) => {
      ctx.res = new Response("ok", { status: 200 });
    });

    await waitForRows(1);
    const row = (await storage.queryAgentRequests()).find(
      (r) => r.path === "/",
    );
    // UA-named families classify identically on the degraded path.
    expect(row?.agentFamily).toBe("gptbot");
    // Degraded fidelity: Web Headers are lowercased.
    expect(row?.headers.map((h) => h[0])).toContain("user-agent");
  });
});
