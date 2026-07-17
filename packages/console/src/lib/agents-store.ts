import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { authedFetch } from "./admin-token-store.js";

/**
 * Agent-telemetry client (M5): a TanStack Query hook + zod-validated schema for
 * the M4 read API (`GET /__enpilink/agents/summary`). The Agents tab consumes
 * this, mirroring `observability-store.ts` (same polling cadence, same
 * `authedFetch` bearer injection, same "never throw on the disabled path"
 * discipline).
 *
 * The schema mirrors the EXACT shape returned by
 * `server/agent/telemetry.ts::AgentTelemetrySummary` (and its
 * `outcomes.ts`/`sessions.ts` sub-shapes). It is tolerant like the
 * observability schema — unknown fields are ignored so the API can evolve — but
 * `agentClass`/`family` stay `z.string()` (not enums) on purpose: the
 * behavioural taxonomy is expected to GROW as the fingerprint corpus grows, and
 * a strict enum would reject a client the server learned to name after this
 * bundle was built.
 *
 * TWO TIERS OF FIDELITY the UI must keep separate (telemetry.ts §):
 * - `outcomes.*` — accurate over the whole window (DB `GROUP BY`).
 * - `sessions.*` (recovery/escalation) — a BOUNDED, windowed sample; honesty is
 *   the `coverage` block, which the UI must always render alongside the number.
 */

const BASE = "/__enpilink/agents";

// --- Sub-shapes (mirror outcomes.ts / sessions.ts) ---

/** `OutcomeHistogram` — the read-outcome classes (writes excluded here). */
const outcomeHistogramSchema = z.object({
  resolved: z.number(),
  dead_end: z.number(),
  blocked: z.number(),
  broken: z.number(),
});

/** `ClassHistogram` — the S3 classes (write_attempt mutually exclusive). */
const classHistogramSchema = z.object({
  resolved: z.number(),
  dead_end: z.number(),
  blocked: z.number(),
  broken: z.number(),
  write_attempt: z.number(),
});

/** `FamilyOutcome` — per named vendor/client (null = unnamed). */
const familyOutcomeSchema = z.object({
  family: z.string().nullable(),
  total: z.number(),
  deadEnds: z.number(),
  deadEndRate: z.number(),
});

/** `ClassOutcome` — per behavioural class (null = unset). */
const classOutcomeSchema = z.object({
  agentClass: z.string().nullable(),
  total: z.number(),
  deadEnds: z.number(),
  deadEndRate: z.number(),
});

/** `WriteOutcome` — the write-attempt breakdown (the money event). */
const writeOutcomeSchema = z.object({
  total: z.number(),
  byOutcome: outcomeHistogramSchema,
});

/** `SegmentOutcome` — served / not-served segment stats. */
const segmentOutcomeSchema = z.object({
  total: z.number(),
  deadEnds: z.number(),
  deadEndRate: z.number(),
  outcomeHistogram: outcomeHistogramSchema,
});

/** `OutcomeAggregate` — the accurate, whole-window outcome numbers. */
const outcomeAggregateSchema = z.object({
  total: z.number(),
  classHistogram: classHistogramSchema,
  outcomeHistogram: outcomeHistogramSchema,
  deadEnds: z.number(),
  deadEndRate: z.number(),
  byFamily: z.array(familyOutcomeSchema),
  byClass: z.array(classOutcomeSchema),
  write: writeOutcomeSchema,
  served: segmentOutcomeSchema,
  notServed: segmentOutcomeSchema,
});

/** `RecoveryStats` — recovery/abandonment over the sessionable slice. */
const recoveryStatsSchema = z.object({
  deadEnds: z.number(),
  recovered: z.number(),
  abandoned: z.number(),
  recoveryRate: z.number(),
  coverage: z.number(),
});

/** `UnsessionableClass` — one honest "cannot stitch a session" bucket. */
const unsessionableClassSchema = z.object({
  agentClass: z.string(),
  count: z.number(),
});

/** `SessionAggregate` — the honest correlation numbers (a bounded sample). */
const sessionAggregateSchema = z.object({
  total: z.number(),
  sessionableRequests: z.number(),
  unsessionableRequests: z.number(),
  sessionableCoverage: z.number(),
  sessions: z.number(),
  recovery: recoveryStatsSchema,
  escalations: z.number(),
  unsessionableByClass: z.array(unsessionableClassSchema),
});

/** `coverage` — the confidence/coverage metadata the UI must surface. */
const coverageSchema = z.object({
  sessionable: z.number(),
  recovery: z.number(),
  escalationBestEffort: z.boolean(),
  correlationSampled: z.boolean(),
});

// --- The summary (discriminated on `enabled`) ---

/** The populated summary — capture is on AND storage is present. */
const enabledSummarySchema = z.object({
  enabled: z.literal(true),
  since: z.number(),
  outcomes: outcomeAggregateSchema,
  sessions: sessionAggregateSchema,
  rescuedDeadEnds: z.number(),
  headline: z.string(),
  coverage: coverageSchema,
});

/** The degraded shape — storage absent / capture off. A valid 200, never a 500. */
const disabledSummarySchema = z.object({ enabled: z.literal(false) });

/** The full response: exactly one of the two shapes, keyed off `enabled`. */
export const agentSummarySchema = z.discriminatedUnion("enabled", [
  enabledSummarySchema,
  disabledSummarySchema,
]);

export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type AgentSummaryEnabled = z.infer<typeof enabledSummarySchema>;
export type OutcomeAggregate = z.infer<typeof outcomeAggregateSchema>;
export type SessionAggregate = z.infer<typeof sessionAggregateSchema>;
export type FamilyOutcome = z.infer<typeof familyOutcomeSchema>;
export type ClassOutcome = z.infer<typeof classOutcomeSchema>;
export type OutcomeHistogram = z.infer<typeof outcomeHistogramSchema>;
export type ClassHistogram = z.infer<typeof classHistogramSchema>;

/**
 * Poll the agent telemetry summary for a `since` lower bound (epoch ms). The
 * query key includes `since` so changing the range refetches. Mirrors
 * `useObservabilitySummary`: 5s polling, `authedFetch` for the prod bearer, and
 * a tolerant zod parse. Does NOT require an MCP connection — an analytics
 * customer may have no MCP server at all.
 */
export function useAgentSummary(since: number) {
  return useQuery({
    queryKey: ["agents", "summary", since],
    queryFn: async (): Promise<AgentSummary> => {
      const res = await authedFetch(`${BASE}/summary?since=${since}`);
      if (!res.ok) {
        throw new Error(`agent summary failed (${res.status})`);
      }
      return agentSummarySchema.parse(await res.json());
    },
    refetchInterval: 5000,
  });
}

/**
 * Requests the detector could not attribute — the corpus-growth signal (PLAN
 * M5). Sums the `unknown` behavioural class and the unset (`null`) class from
 * the accurate whole-window `byClass` aggregate. This is the AGGREGATE count;
 * per-fingerprint triage (raw headers of each unknown client) needs a server
 * endpoint the summary does not yet expose — see the M5 gotchas.
 */
export function countUnrecognised(outcomes: OutcomeAggregate): number {
  return outcomes.byClass
    .filter((c) => c.agentClass === null || c.agentClass === "unknown")
    .reduce((sum, c) => sum + c.total, 0);
}
