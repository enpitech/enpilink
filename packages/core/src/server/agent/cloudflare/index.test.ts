import { describe, expect, it, vi } from "vitest";
import type { AgentRequestRecord } from "../../storage/types.js";
import { INITIAL_RULESET } from "../ruleset/initial.js";
import {
  agentCapture,
  type CloudflareExecutionContext,
  type EdgeCaptureSink,
  type EdgeKvLike,
  KVRulesetCacheStore,
  type OriginHandler,
} from "./index.js";

const CHATGPT_UA =
  "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)";
const GOOGLEBOT_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

type Env = Record<string, unknown>;

/** A ctx double that collects `waitUntil` promises so a test can drain them. */
function fakeCtx(): {
  ctx: CloudflareExecutionContext;
  drain: () => Promise<unknown>;
} {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p) => promises.push(p) },
    drain: () => Promise.all(promises),
  };
}

/** A sink that collects everything written. */
class CollectSink implements EdgeCaptureSink {
  readonly records: AgentRequestRecord[] = [];
  async write(recs: AgentRequestRecord[]): Promise<void> {
    this.records.push(...recs);
  }
}

/** A minimal in-memory KV double. */
class FakeKv implements EdgeKvLike {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

function req(ua: string, path = "/missing", accept = "*/*"): Request {
  return new Request(`https://example.com${path}`, {
    method: "GET",
    headers: { "user-agent": ua, accept },
  });
}

/** Origin: 404 for `/missing`, 200 HTML otherwise. */
const origin: OriginHandler<Env> = (request) =>
  new Response(request.url.includes("/missing") ? "not found" : "ok", {
    status: request.url.includes("/missing") ? 404 : 200,
    headers: { "content-type": "text/html" },
  });

describe("agentCapture (Cloudflare Worker adapter)", () => {
  it("SERVES an eligible chat fetcher the representation, recorded as a rescued dead-end", async () => {
    const sink = new CollectSink();
    const worker = agentCapture<Env>({
      serve: true,
      site: { title: "Acme", description: "Acme's API and docs." },
      rulesetValue: INITIAL_RULESET,
      fetchOrigin: origin,
      sink: () => sink,
    });
    const { ctx, drain } = fakeCtx();

    const res = await worker.fetch(req(CHATGPT_UA), {}, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toContain("# Acme");

    await drain();
    expect(sink.records).toHaveLength(1);
    const rec = sink.records[0];
    expect(rec?.agentFamily).toBe("chatgpt-user");
    expect(rec?.agentClass).toBe("chat-fetcher");
    expect(rec?.served).toBe(true);
    expect(rec?.servedEncoding).toBe("markdown");
    expect(rec?.outcome).toBe("dead_end"); // rescued would-be-404, honestly
    expect(rec?.status).toBe(200);
    expect(rec?.meta?.edge).toBe(true);
  });

  it("THE GUARDRAIL: Googlebot passes THROUGH untouched (real 404), still captured", async () => {
    const sink = new CollectSink();
    const worker = agentCapture<Env>({
      serve: true,
      site: { title: "Acme" },
      rulesetValue: INITIAL_RULESET,
      fetchOrigin: origin,
      sink: () => sink,
    });
    const { ctx, drain } = fakeCtx();

    const res = await worker.fetch(req(GOOGLEBOT_UA), {}, ctx);

    // The crawler gets the ORIGINAL 404 — no differentiation, ever.
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");

    await drain();
    const rec = sink.records[0];
    expect(rec?.agentClass).toBe("crawler");
    expect(rec?.agentFamily).toBe("googlebot");
    expect(rec?.served).toBeFalsy();
    expect(rec?.outcome).toBe("dead_end");
    expect(rec?.status).toBe(404);
  });

  it("FAILS OPEN: an internal error returns the origin response untouched", async () => {
    const onError = vi.fn();
    const worker = agentCapture<Env>({
      serve: false,
      rulesetValue: INITIAL_RULESET,
      fetchOrigin: () => new Response("origin-ok", { status: 200 }),
      // Resolving the sink throws — a bug in the capture wrapper.
      sink: () => {
        throw new Error("boom");
      },
      onError,
    });
    const { ctx } = fakeCtx();

    const res = await worker.fetch(req(CHATGPT_UA, "/page"), {}, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("origin-ok"); // untouched by the failure
    expect(onError).toHaveBeenCalled();
  });

  it("captures with serving off, deferring the write to waitUntil", async () => {
    const sink = new CollectSink();
    const worker = agentCapture<Env>({
      rulesetValue: INITIAL_RULESET,
      fetchOrigin: () => new Response("ok", { status: 200 }),
      sink: () => sink,
    });
    const { ctx, drain } = fakeCtx();

    const res = await worker.fetch(req(CHATGPT_UA, "/page"), {}, ctx);
    expect(res.status).toBe(200);
    // The write is scheduled on waitUntil (never on the response path); it
    // completes when that deferred work is drained.
    await drain();
    expect(sink.records[0]?.agentClass).toBe("chat-fetcher");
  });

  it("NO BASELINE then WARM: a cold isolate is pending, then classifies via KV", async () => {
    const kv = new FakeKv();
    await kv.put(
      "enpilink:agent:ruleset:v1",
      JSON.stringify({
        body: JSON.parse(JSON.stringify(INITIAL_RULESET)),
        fetchedAt: Date.now(),
        maxAgeSeconds: 3600,
      }),
    );
    const sink = new CollectSink();
    const worker = agentCapture<Env>({
      // Cache-only (no network); the ruleset is warmed from KV in waitUntil.
      ruleset: {
        enabled: false,
        cacheStore: () => new KVRulesetCacheStore({ kv }),
      },
      fetchOrigin: () => new Response("ok", { status: 200 }),
      sink: () => sink,
    });

    // Request 1 — cold isolate: getRuleset() is null → captured `pending`.
    const c1 = fakeCtx();
    await worker.fetch(req(CHATGPT_UA, "/page"), {}, c1.ctx);
    await c1.drain(); // warms the client from KV
    expect(sink.records[0]?.confidence).toBe("pending");
    expect(sink.records[0]?.agentClass).toBeUndefined();

    // Request 2 — warm isolate: now classified from the KV-loaded ruleset.
    const c2 = fakeCtx();
    await worker.fetch(req(CHATGPT_UA, "/page"), {}, c2.ctx);
    await c2.drain();
    expect(sink.records[1]?.agentClass).toBe("chat-fetcher");
    expect(sink.records[1]?.agentFamily).toBe("chatgpt-user");
  });

  it("is a pure pass-through when disabled", async () => {
    const sink = new CollectSink();
    const worker = agentCapture<Env>({
      enabled: false,
      serve: true,
      rulesetValue: INITIAL_RULESET,
      fetchOrigin: origin,
      sink: () => sink,
    });
    const { ctx, drain } = fakeCtx();
    const res = await worker.fetch(req(CHATGPT_UA), {}, ctx);
    expect(res.status).toBe(404); // no serve, no capture
    await drain();
    expect(sink.records).toHaveLength(0);
  });
});
