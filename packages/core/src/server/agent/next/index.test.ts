import { describe, expect, it } from "vitest";
import type { AgentRequestRecord } from "../../storage/types.js";
import type { FetchLike } from "../edge/beacon.js";
import {
  type EdgeFetchEvent,
  type EdgeMiddlewareHandler,
  withAgentCapture,
} from "./index.js";

/** A fake NextFetchEvent that collects the waitUntil promises so a test can await them. */
function fakeEvent(): EdgeFetchEvent & { settle(): Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p) {
      pending.push(p);
    },
    async settle() {
      await Promise.all(pending);
    },
  };
}

/** A fetch spy returning 202. */
function spyFetch(): {
  fetchImpl: FetchLike;
  batches: () => AgentRequestRecord[][];
} {
  const bodies: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(init.body);
    return { ok: true, status: 202 };
  };
  return {
    fetchImpl,
    batches: () =>
      bodies.map(
        (b) => (JSON.parse(b) as { records: AgentRequestRecord[] }).records,
      ),
  };
}

function gptbotRequest(path = "/pricing"): Request {
  return new Request(`https://acme.com${path}`, {
    method: "GET",
    headers: {
      "user-agent": "GPTBot/1.0",
      "cf-connecting-ip": "198.51.100.5",
      accept: "*/*",
    },
  });
}

describe("withAgentCapture", () => {
  it("is OFF by default — no capture, no beacon, handler still runs", async () => {
    const { fetchImpl, batches } = spyFetch();
    let handlerRan = false;
    const handler: EdgeMiddlewareHandler = () => {
      handlerRan = true;
      return undefined;
    };
    const mw = withAgentCapture({ fetchImpl }, handler);
    const event = fakeEvent();
    mw(gptbotRequest(), event);
    await event.settle();
    expect(handlerRan).toBe(true);
    expect(batches()).toHaveLength(0);
  });

  it("does not beacon when enabled but no sinkUrl is set", async () => {
    const { fetchImpl, batches } = spyFetch();
    const mw = withAgentCapture({ enabled: true, fetchImpl });
    const event = fakeEvent();
    mw(gptbotRequest(), event);
    await event.settle();
    expect(batches()).toHaveLength(0);
  });

  it("captures + POSTs a well-formed batch inside waitUntil when enabled", async () => {
    const { fetchImpl, batches } = spyFetch();
    const mw = withAgentCapture({
      enabled: true,
      sinkUrl: "https://acme.com/__enpilink/agents/ingest",
      token: "tok",
      ipSalt: "salt",
      fetchImpl,
    });
    const event = fakeEvent();
    mw(gptbotRequest("/pricing"), event);
    await event.settle();

    const sent = batches();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    const record = (sent[0] as AgentRequestRecord[])[0] as AgentRequestRecord;
    expect(record.method).toBe("GET");
    expect(record.path).toBe("/pricing");
    expect(record.agentFamily).toBe("gptbot");
    expect(record.agentClass).toBe("crawler");
    expect(record.meta?.edge).toBe(true);
    // IP hashed, never raw.
    expect(record.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain("198.51.100.5");
  });

  it("returns the handler's response synchronously — never blocks on the beacon", () => {
    // A fetch that never resolves proves the middleware does not await it.
    const neverFetch: FetchLike = () => new Promise(() => {});
    const response = new Response("ok", { status: 200 });
    const handler: EdgeMiddlewareHandler = () => response;
    const mw = withAgentCapture(
      {
        enabled: true,
        sinkUrl: "https://acme.com/ingest",
        fetchImpl: neverFetch,
      },
      handler,
    );
    const returned = mw(gptbotRequest(), fakeEvent());
    // The exact handler response comes back immediately, beacon still pending.
    expect(returned).toBe(response);
  });

  it("records a NextResponse.next()-style continue as unknown status (not a fake 200)", async () => {
    const { fetchImpl, batches } = spyFetch();
    // A .next()/.rewrite() carries an x-middleware-* header; the real page status
    // is decided downstream, so we must not record it as a genuine 200.
    const cont = new Response(null, {
      status: 200,
      headers: { "x-middleware-next": "1" },
    });
    const mw = withAgentCapture(
      { enabled: true, sinkUrl: "https://acme.com/ingest", fetchImpl },
      () => cont,
    );
    const event = fakeEvent();
    mw(gptbotRequest(), event);
    await event.settle();
    const record = (
      batches()[0] as AgentRequestRecord[]
    )[0] as AgentRequestRecord;
    expect(record.status).toBe(0);
    expect(record.meta?.statusUnknown).toBe(true);
  });

  it("records a middleware-produced redirect with its real status", async () => {
    const { fetchImpl, batches } = spyFetch();
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "/login" },
    });
    const mw = withAgentCapture(
      { enabled: true, sinkUrl: "https://acme.com/ingest", fetchImpl },
      () => redirect,
    );
    const event = fakeEvent();
    mw(gptbotRequest(), event);
    await event.settle();
    const record = (
      batches()[0] as AgentRequestRecord[]
    )[0] as AgentRequestRecord;
    expect(record.status).toBe(302);
    expect(record.outcome).toBe("resolved");
  });

  it("skips capture when the sample misses (rng >= sampleRate)", async () => {
    const { fetchImpl, batches } = spyFetch();
    const mw = withAgentCapture({
      enabled: true,
      sinkUrl: "https://acme.com/ingest",
      sampleRate: 0.5,
      rng: () => 0.9, // above 0.5 → not sampled
      fetchImpl,
    });
    const event = fakeEvent();
    mw(gptbotRequest(), event);
    await event.settle();
    expect(batches()).toHaveLength(0);
  });
});
