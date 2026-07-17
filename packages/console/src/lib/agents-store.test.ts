import { describe, expect, it } from "vitest";
import {
  agentSummarySchema,
  countUnrecognised,
  type OutcomeAggregate,
} from "./agents-store.js";

/**
 * Zod-schema tests for the M5 agent-telemetry client, validated against the
 * EXACT shape `server/agent/telemetry.ts::AgentTelemetrySummary` returns (and
 * its outcomes.ts / sessions.ts sub-shapes). Covers the three shapes the UI
 * must handle distinctly: a populated summary, the `{ enabled: false }`
 * degraded shape, and the `enabled: true, total: 0` empty-but-on shape.
 */

/** A realistic, fully-populated summary mirroring the M4 read API. */
function realisticSummary(): unknown {
  const outcomes = {
    total: 42,
    classHistogram: {
      resolved: 20,
      dead_end: 15,
      blocked: 3,
      broken: 2,
      write_attempt: 2,
    },
    outcomeHistogram: { resolved: 21, dead_end: 15, blocked: 4, broken: 2 },
    deadEnds: 15,
    deadEndRate: 15 / 42,
    byFamily: [
      { family: "chatgpt-user", total: 18, deadEnds: 7, deadEndRate: 7 / 18 },
      { family: "gemini", total: 10, deadEnds: 4, deadEndRate: 0.4 },
      { family: null, total: 14, deadEnds: 4, deadEndRate: 4 / 14 },
    ],
    byClass: [
      { agentClass: "chat-fetcher", total: 20, deadEnds: 8, deadEndRate: 0.4 },
      { agentClass: "crawler", total: 10, deadEnds: 3, deadEndRate: 0.3 },
      {
        agentClass: "human-or-browser",
        total: 8,
        deadEnds: 2,
        deadEndRate: 0.25,
      },
      { agentClass: "unknown", total: 3, deadEnds: 1, deadEndRate: 1 / 3 },
      { agentClass: null, total: 1, deadEnds: 1, deadEndRate: 1 },
    ],
    write: {
      total: 2,
      byOutcome: { resolved: 1, dead_end: 0, blocked: 1, broken: 0 },
    },
    served: {
      total: 5,
      deadEnds: 5,
      deadEndRate: 1,
      outcomeHistogram: { resolved: 0, dead_end: 5, blocked: 0, broken: 0 },
    },
    notServed: {
      total: 37,
      deadEnds: 10,
      deadEndRate: 10 / 37,
      outcomeHistogram: { resolved: 21, dead_end: 10, blocked: 4, broken: 2 },
    },
  };
  return {
    enabled: true,
    since: 1_700_000_000_000,
    outcomes,
    sessions: {
      total: 42,
      sessionableRequests: 6,
      unsessionableRequests: 36,
      sessionableCoverage: 6 / 42,
      sessions: 2,
      recovery: {
        deadEnds: 3,
        recovered: 1,
        abandoned: 2,
        recoveryRate: 1 / 3,
        coverage: 3 / 15,
      },
      escalations: 1,
      unsessionableByClass: [
        { agentClass: "chat-fetcher", count: 20 },
        { agentClass: "crawler", count: 10 },
        { agentClass: "human-or-browser", count: 8 },
      ],
    },
    rescuedDeadEnds: 5,
    headline:
      "Agents made 42 requests · hit 15 dead-ends (36%) · 5 rescued by a served representation · 1 escalated to a browser (best-effort).",
    coverage: {
      sessionable: 6 / 42,
      recovery: 3 / 15,
      escalationBestEffort: true,
      correlationSampled: false,
    },
  };
}

/** The all-zero, capture-on-but-no-traffic summary shape. */
function emptyOnSummary(): unknown {
  const emptyHist = { resolved: 0, dead_end: 0, blocked: 0, broken: 0 };
  const emptySegment = {
    total: 0,
    deadEnds: 0,
    deadEndRate: 0,
    outcomeHistogram: emptyHist,
  };
  return {
    enabled: true,
    since: 1_700_000_000_000,
    outcomes: {
      total: 0,
      classHistogram: { ...emptyHist, write_attempt: 0 },
      outcomeHistogram: emptyHist,
      deadEnds: 0,
      deadEndRate: 0,
      byFamily: [],
      byClass: [],
      write: { total: 0, byOutcome: emptyHist },
      served: emptySegment,
      notServed: emptySegment,
    },
    sessions: {
      total: 0,
      sessionableRequests: 0,
      unsessionableRequests: 0,
      sessionableCoverage: 0,
      sessions: 0,
      recovery: {
        deadEnds: 0,
        recovered: 0,
        abandoned: 0,
        recoveryRate: 0,
        coverage: 0,
      },
      escalations: 0,
      unsessionableByClass: [],
    },
    rescuedDeadEnds: 0,
    headline:
      "Agents made 0 requests · hit 0 dead-ends (0%) · 0 escalated to a browser (best-effort).",
    coverage: {
      sessionable: 0,
      recovery: 0,
      escalationBestEffort: true,
      correlationSampled: false,
    },
  };
}

describe("agentSummarySchema", () => {
  it("parses a realistic populated summary", () => {
    const parsed = agentSummarySchema.parse(realisticSummary());
    expect(parsed.enabled).toBe(true);
    if (!parsed.enabled) {
      throw new Error("expected enabled summary");
    }
    expect(parsed.outcomes.total).toBe(42);
    expect(parsed.outcomes.deadEnds).toBe(15);
    expect(parsed.rescuedDeadEnds).toBe(5);
    expect(parsed.outcomes.byFamily).toHaveLength(3);
    // The unnamed family survives as an explicit null (not dropped).
    expect(parsed.outcomes.byFamily[2]?.family).toBeNull();
    expect(parsed.sessions.recovery.abandoned).toBe(2);
    expect(parsed.coverage.correlationSampled).toBe(false);
  });

  it("parses the { enabled: false } degraded shape (storage absent)", () => {
    const parsed = agentSummarySchema.parse({ enabled: false });
    expect(parsed.enabled).toBe(false);
    // The disabled branch carries no other fields.
    expect(Object.keys(parsed)).toEqual(["enabled"]);
  });

  it("parses the enabled-but-empty (total: 0) shape distinctly", () => {
    const parsed = agentSummarySchema.parse(emptyOnSummary());
    expect(parsed.enabled).toBe(true);
    if (!parsed.enabled) {
      throw new Error("expected enabled summary");
    }
    expect(parsed.outcomes.total).toBe(0);
    expect(parsed.outcomes.byClass).toHaveLength(0);
    expect(parsed.sessions.unsessionableByClass).toHaveLength(0);
  });

  it("is tolerant of unknown extra fields (forward-compat)", () => {
    const base = realisticSummary() as Record<string, unknown>;
    const parsed = agentSummarySchema.parse({
      ...base,
      futureRollup: { confidenceTier: "ip-verified" },
    });
    expect(parsed.enabled).toBe(true);
  });

  it("rejects a malformed enabled payload (missing outcomes)", () => {
    const base = realisticSummary() as Record<string, unknown>;
    delete base.outcomes;
    expect(agentSummarySchema.safeParse(base).success).toBe(false);
  });
});

describe("countUnrecognised", () => {
  it("sums the unknown + unset (null) behavioural classes", () => {
    const parsed = agentSummarySchema.parse(realisticSummary());
    if (!parsed.enabled) {
      throw new Error("expected enabled summary");
    }
    // byClass has unknown:3 and null:1 → 4 unrecognised requests.
    expect(countUnrecognised(parsed.outcomes)).toBe(4);
  });

  it("returns 0 when every class is recognised", () => {
    const outcomes: OutcomeAggregate = {
      total: 10,
      classHistogram: {
        resolved: 10,
        dead_end: 0,
        blocked: 0,
        broken: 0,
        write_attempt: 0,
      },
      outcomeHistogram: { resolved: 10, dead_end: 0, blocked: 0, broken: 0 },
      deadEnds: 0,
      deadEndRate: 0,
      byFamily: [],
      byClass: [
        { agentClass: "chat-fetcher", total: 10, deadEnds: 0, deadEndRate: 0 },
      ],
      write: {
        total: 0,
        byOutcome: { resolved: 0, dead_end: 0, blocked: 0, broken: 0 },
      },
      served: {
        total: 0,
        deadEnds: 0,
        deadEndRate: 0,
        outcomeHistogram: { resolved: 0, dead_end: 0, blocked: 0, broken: 0 },
      },
      notServed: {
        total: 10,
        deadEnds: 0,
        deadEndRate: 0,
        outcomeHistogram: { resolved: 10, dead_end: 0, blocked: 0, broken: 0 },
      },
    };
    expect(countUnrecognised(outcomes)).toBe(0);
  });
});
