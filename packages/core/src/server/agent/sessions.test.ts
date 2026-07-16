import { describe, expect, it } from "vitest";
import type { AgentClass, AgentRequestRecord } from "../storage/types.js";
import { computeAgentSessions } from "./sessions.js";

const MIN = 60_000;

/** Build an agent request record from the fields these tests care about. */
function rec(p: {
  ts: number;
  outcome?: AgentRequestRecord["outcome"];
  agentClass?: AgentClass;
  ipHash?: string;
  method?: string;
}): AgentRequestRecord {
  return {
    ts: p.ts,
    siteId: "default",
    method: p.method ?? "GET",
    path: "/",
    status: p.outcome === "dead_end" ? 404 : 200,
    outcome: p.outcome ?? "resolved",
    httpVersion: "1.1",
    headers: [],
    confidence: "none",
    ...(p.agentClass !== undefined ? { agentClass: p.agentClass } : {}),
    ...(p.ipHash !== undefined ? { ipHash: p.ipHash } : {}),
  };
}

describe("computeAgentSessions — recovery vs abandonment", () => {
  it("counts a dead-end recovered when a later resolved arrives in-window", () => {
    const agg = computeAgentSessions([
      // Identity A (cli): dead-end, then resolved 1 min later → RECOVERED.
      rec({ ts: 0, outcome: "dead_end", agentClass: "cli", ipHash: "A" }),
      rec({ ts: 1 * MIN, outcome: "resolved", agentClass: "cli", ipHash: "A" }),
      // Identity B (cli): dead-end, no follow-up → ABANDONED.
      rec({ ts: 0, outcome: "dead_end", agentClass: "cli", ipHash: "B" }),
    ]);
    expect(agg.recovery.deadEnds).toBe(2);
    expect(agg.recovery.recovered).toBe(1);
    expect(agg.recovery.abandoned).toBe(1);
    expect(agg.recovery.recoveryRate).toBe(0.5);
    // Both dead-ends were within sessionable identities → full coverage.
    expect(agg.recovery.coverage).toBe(1);
  });

  it("does NOT recover when the resolved arrives after the window", () => {
    const agg = computeAgentSessions(
      [
        rec({ ts: 0, outcome: "dead_end", agentClass: "cli", ipHash: "A" }),
        rec({
          ts: 10 * MIN,
          outcome: "resolved",
          agentClass: "cli",
          ipHash: "A",
        }),
      ],
      { recoveryWindowMs: 5 * MIN },
    );
    expect(agg.recovery.recovered).toBe(0);
    expect(agg.recovery.abandoned).toBe(1);
  });
});

describe("computeAgentSessions — the honesty constraint", () => {
  it("makes NO sessions for chat-fetchers on ONE shared IP — they are unsessionable", () => {
    // Five ChatGPT-User fetches from a single vendor-pool IP: different people,
    // no correlator. They must NOT be merged into a fake session.
    const agg = computeAgentSessions([
      rec({ ts: 0, agentClass: "chat-fetcher", ipHash: "SHARED" }),
      rec({
        ts: 1000,
        outcome: "dead_end",
        agentClass: "chat-fetcher",
        ipHash: "SHARED",
      }),
      rec({ ts: 2000, agentClass: "chat-fetcher", ipHash: "SHARED" }),
      rec({ ts: 3000, agentClass: "chat-fetcher", ipHash: "SHARED" }),
      rec({ ts: 4000, agentClass: "chat-fetcher", ipHash: "SHARED" }),
    ]);
    expect(agg.sessions).toBe(0);
    expect(agg.sessionableRequests).toBe(0);
    expect(agg.unsessionableRequests).toBe(5);
    expect(agg.sessionableCoverage).toBe(0);
    // The dead-end exists but is NOT counted as recoverable (unsessionable).
    expect(agg.recovery.deadEnds).toBe(0);
    expect(agg.recovery.coverage).toBe(0);
    expect(agg.unsessionableByClass).toEqual([
      { agentClass: "chat-fetcher", count: 5 },
    ]);
  });

  it("reports the coverage fraction on mixed traffic", () => {
    // 2 sessionable (cli) + 8 unsessionable (chat-fetcher) = 20% coverage.
    const agg = computeAgentSessions([
      rec({ ts: 0, agentClass: "cli", ipHash: "DEV" }),
      rec({ ts: 1000, agentClass: "cli", ipHash: "DEV" }),
      ...Array.from({ length: 8 }, (_, i) =>
        rec({ ts: 2000 + i, agentClass: "chat-fetcher", ipHash: "POOL" }),
      ),
    ]);
    expect(agg.sessionableRequests).toBe(2);
    expect(agg.unsessionableRequests).toBe(8);
    expect(agg.sessionableCoverage).toBeCloseTo(0.2, 5);
  });

  it("treats a sessionable class WITHOUT an ip_hash as unsessionable", () => {
    // A cli request with no hashed IP cannot be correlated → unsessionable.
    const agg = computeAgentSessions([rec({ ts: 0, agentClass: "cli" })]);
    expect(agg.sessionableRequests).toBe(0);
    expect(agg.unsessionableByClass).toEqual([{ agentClass: "cli", count: 1 }]);
  });

  it("honours an explicit total for the coverage denominator", () => {
    // The route passes the TRUE full-window total even when it only pulled the
    // correlatable subset of rows.
    const agg = computeAgentSessions(
      [
        rec({ ts: 0, agentClass: "cli", ipHash: "DEV" }),
        rec({ ts: 1000, agentClass: "cli", ipHash: "DEV" }),
      ],
      { totalRequests: 100 },
    );
    expect(agg.sessionableRequests).toBe(2);
    expect(agg.total).toBe(100);
    expect(agg.sessionableCoverage).toBeCloseTo(0.02, 5);
  });
});

describe("computeAgentSessions — escalation to browser (F-8, best-effort)", () => {
  it("counts a browser render preceded by a same-IP fetch in-window", () => {
    const agg = computeAgentSessions([
      // On-device: a CLI fetch, then a full browser render on the same IP.
      rec({ ts: 0, agentClass: "cli", ipHash: "DEV" }),
      rec({ ts: 30_000, agentClass: "human-or-browser", ipHash: "DEV" }),
      // A lone browser render on another IP — no preceding fetch, no escalation.
      rec({ ts: 0, agentClass: "human-or-browser", ipHash: "OTHER" }),
    ]);
    expect(agg.escalations).toBe(1);
  });

  it("does NOT count an escalation outside the window", () => {
    const agg = computeAgentSessions(
      [
        rec({ ts: 0, agentClass: "cli", ipHash: "DEV" }),
        rec({ ts: 10 * MIN, agentClass: "human-or-browser", ipHash: "DEV" }),
      ],
      { escalationWindowMs: 5 * MIN },
    );
    expect(agg.escalations).toBe(0);
  });
});
