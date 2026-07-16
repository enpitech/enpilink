import { describe, expect, it, vi } from "vitest";
import type { AgentRequestRecord } from "../storage/types.js";
import { AgentWriteBuffer } from "./buffer.js";

/** A minimal captured record for buffer tests. */
function rec(ts: number): AgentRequestRecord {
  return {
    ts,
    siteId: "s",
    method: "GET",
    path: "/",
    status: 200,
    outcome: "resolved",
    httpVersion: "1.1",
    headers: [["Host", "x"]],
    confidence: "none",
  };
}

describe("AgentWriteBuffer", () => {
  it("flushes eagerly once the queue reaches batchSize", async () => {
    const batches: AgentRequestRecord[][] = [];
    const buf = new AgentWriteBuffer({
      sink: async (r) => {
        batches.push(r);
      },
      batchSize: 3,
      flushIntervalMs: 10_000,
    });
    buf.enqueue(rec(1));
    buf.enqueue(rec(2));
    expect(batches).toHaveLength(0); // not yet at batchSize
    buf.enqueue(rec(3)); // hits batchSize → eager flush
    await Promise.resolve();
    await Promise.resolve();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    await buf.stop();
  });

  it("flushes a partial queue on the interval timer", async () => {
    vi.useFakeTimers();
    try {
      const batches: AgentRequestRecord[][] = [];
      const buf = new AgentWriteBuffer({
        sink: async (r) => {
          batches.push(r);
        },
        batchSize: 100,
        flushIntervalMs: 500,
      });
      buf.enqueue(rec(1));
      expect(batches).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);
      await buf.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("DROPS on overflow past maxQueue and counts the drops (never blocks/grows)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: AgentRequestRecord[] = [];
    const buf = new AgentWriteBuffer({
      // A sink that blocks until released, so the queue can fill up.
      sink: async (r) => {
        await gate;
        seen.push(...r);
      },
      maxQueue: 5,
      batchSize: 100,
      flushIntervalMs: 10_000,
    });
    // Enqueue well past the cap; the extras must be dropped, not queued.
    for (let i = 0; i < 12; i++) {
      buf.enqueue(rec(i));
    }
    expect(buf.size).toBe(5);
    expect(buf.dropped).toBe(7);
    release();
    await buf.stop();
    expect(seen).toHaveLength(5);
  });

  it("swallows sink errors — a storage failure never propagates", async () => {
    const buf = new AgentWriteBuffer({
      sink: async () => {
        throw new Error("storage down");
      },
      batchSize: 1,
      flushIntervalMs: 10_000,
    });
    // Must not throw.
    buf.enqueue(rec(1));
    await expect(buf.flush()).resolves.toBeUndefined();
    await buf.stop();
  });
});
