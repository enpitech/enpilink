import { describe, expect, it, vi } from "vitest";
import type { AgentRequestRecord } from "../../storage/types.js";
import { BeaconSink, type FetchLike } from "./beacon.js";

function rec(path: string): AgentRequestRecord {
  return {
    ts: 1,
    siteId: "default",
    method: "GET",
    path,
    status: 200,
    outcome: "resolved",
    httpVersion: "",
    headers: [["user-agent", "GPTBot/1.0"]],
  };
}

/** A fetch spy that records calls and returns a 202. */
function okFetch(): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; init: unknown }>;
} {
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 202 };
  };
  return { fetchImpl, calls };
}

describe("BeaconSink", () => {
  it("POSTs a well-formed batch: url, method, JSON body, bearer token", async () => {
    const { fetchImpl, calls } = okFetch();
    const sink = new BeaconSink({
      sinkUrl: "https://app.com/__enpilink/agents/ingest",
      token: "secret-token",
      fetchImpl,
    });
    sink.add(rec("/a"));
    sink.add(rec("/b"));
    await sink.drainAndSend();

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] as {
      url: string;
      init: { method: string; headers: Record<string, string>; body: string };
    };
    expect(url).toBe("https://app.com/__enpilink/agents/ingest");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers.authorization).toBe("Bearer secret-token");
    const body = JSON.parse(init.body) as { records: AgentRequestRecord[] };
    expect(body.records.map((r) => r.path)).toEqual(["/a", "/b"]);
  });

  it("omits the Authorization header when no token is set", async () => {
    const { fetchImpl, calls } = okFetch();
    const sink = new BeaconSink({ sinkUrl: "https://app.com/x", fetchImpl });
    sink.add(rec("/a"));
    await sink.drainAndSend();
    const init = (calls[0] as { init: { headers: Record<string, string> } })
      .init;
    expect(init.headers.authorization).toBeUndefined();
  });

  it("is a no-op (no fetch) when the queue is empty", async () => {
    const { fetchImpl, calls } = okFetch();
    const sink = new BeaconSink({ sinkUrl: "https://app.com/x", fetchImpl });
    await sink.drainAndSend();
    expect(calls).toHaveLength(0);
  });

  it("splits into batches of maxBatch across successive drains", async () => {
    const { fetchImpl, calls } = okFetch();
    const sink = new BeaconSink({
      sinkUrl: "https://app.com/x",
      maxBatch: 2,
      fetchImpl,
    });
    for (const p of ["/a", "/b", "/c"]) {
      sink.add(rec(p));
    }
    await sink.drainAndSend(); // sends /a,/b
    expect(sink.size).toBe(1);
    await sink.drainAndSend(); // sends /c
    expect(sink.size).toBe(0);
    expect(calls).toHaveLength(2);
    expect(
      JSON.parse((calls[0] as { init: { body: string } }).init.body).records
        .length,
    ).toBe(2);
  });

  it("drops (and counts) records past maxQueue — bounded, never a memory leak", () => {
    const { fetchImpl } = okFetch();
    const sink = new BeaconSink({
      sinkUrl: "https://app.com/x",
      maxQueue: 2,
      fetchImpl,
    });
    sink.add(rec("/a"));
    sink.add(rec("/b"));
    sink.add(rec("/c")); // dropped
    sink.add(rec("/d")); // dropped
    expect(sink.size).toBe(2);
    expect(sink.dropped).toBe(2);
  });

  it("swallows a fetch rejection — drainAndSend resolves, never throws (fire-and-forget)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    const sink = new BeaconSink({ sinkUrl: "https://app.com/x", fetchImpl });
    sink.add(rec("/a"));
    await expect(sink.drainAndSend()).resolves.toBeUndefined();
  });

  it("aborts the beacon after the timeout (does not hang the invocation)", async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("aborted"));
        });
      });
    const sink = new BeaconSink({
      sinkUrl: "https://app.com/x",
      timeoutMs: 1000,
      fetchImpl,
    });
    sink.add(rec("/a"));
    const p = sink.drainAndSend();
    await vi.advanceTimersByTimeAsync(1001);
    await expect(p).resolves.toBeUndefined();
    expect(sawAbort).toBe(true);
    vi.useRealTimers();
  });
});
