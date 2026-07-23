import { describe, expect, it } from "vitest";
import type { AgentRequestRecord } from "../../storage/types.js";
import type { FetchLike } from "../edge/beacon.js";
import { BeaconCaptureSink } from "./sink.js";

/** A minimal captured record. */
function rec(i: number): AgentRequestRecord {
  return {
    ts: i,
    siteId: "default",
    method: "GET",
    path: "/",
    status: 200,
    outcome: "resolved",
    httpVersion: "",
    headers: [],
  };
}

describe("BeaconCaptureSink", () => {
  it("POSTs records to the ingest endpoint with the bearer token, batched", async () => {
    const posts: {
      url: string;
      records: unknown[];
      auth: string | undefined;
    }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const body = JSON.parse(init.body) as { records: unknown[] };
      posts.push({
        url,
        records: body.records,
        auth: init.headers.authorization,
      });
      return { ok: true, status: 202 };
    };

    const sink = new BeaconCaptureSink({
      sinkUrl: "https://app.com/__enpilink/agents/ingest",
      token: "secret",
      maxBatch: 2,
      fetchImpl,
    });

    await sink.write([rec(1), rec(2), rec(3)]);

    // 3 records, maxBatch 2 → two POSTs (2 + 1), each authenticated.
    expect(posts).toHaveLength(2);
    expect(posts[0]?.url).toBe("https://app.com/__enpilink/agents/ingest");
    expect(posts[0]?.records).toHaveLength(2);
    expect(posts[1]?.records).toHaveLength(1);
    expect(posts[0]?.auth).toBe("Bearer secret");
  });

  it("is a no-op for an empty batch", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return { ok: true, status: 202 };
    };
    const sink = new BeaconCaptureSink({ sinkUrl: "https://x/y", fetchImpl });
    await sink.write([]);
    expect(called).toBe(false);
  });
});
