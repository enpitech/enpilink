import express, { type Router } from "express";
import { getActiveStorage } from "../log-sink.js";
import type { AgentRequestRecord, StorageAdapter } from "../storage/types.js";
import {
  computeAgentOutcomes,
  foldOutcomeGroups,
  type OutcomeAggregate,
} from "./outcomes.js";
import {
  computeAgentSessions,
  SESSIONABLE_CLASSES,
  type SessionAggregate,
  type SessionOptions,
  type UnsessionableClass,
} from "./sessions.js";

/**
 * Agent telemetry read API (M4) — the "did the agent SUCCEED?" summary that M5's
 * Agents dashboard renders. It composes the pure {@link computeAgentOutcomes}
 * (S3 outcome classes + served-vs-not segmentation) and
 * {@link computeAgentSessions} (recovery/abandonment + escalation, with an honest
 * coverage fraction) into one payload, plus a single computed headline sentence
 * whose every clause names its source and its coverage (ARCHITECTURE §1.3).
 *
 * Follows the `observability.ts` discipline exactly: storage is read PER-REQUEST
 * via {@link getActiveStorage}; when capture is off / storage is absent / a query
 * throws, every route returns a 200 with `{ enabled: false }` and an empty
 * payload — NEVER a 500.
 *
 * TWO TIERS OF FIDELITY, and the route keeps them separate on purpose:
 * - The OUTCOME numbers (totals, dead-end rate, served-vs-not, per-family) come
 *   from a DB-side `GROUP BY` ({@link StorageAdapter.aggregateAgentOutcomes}), so
 *   they are ACCURATE over the whole window and never pull raw rows into JS.
 * - The CORRELATION numbers (recovery, escalation) need per-request sequences, so
 *   they are computed from a BOUNDED, windowed pull of only the correlatable
 *   classes (a sample at very high volume). Their honesty is the coverage
 *   fraction, which is always reported.
 *
 * M5 MUST render each number with its confidence tier + coverage: a verified-IP
 * hit must not look like an unverified-UA guess, and a `recovery`/`escalation`
 * number must be shown next to its coverage (never as if it saw all traffic).
 */

/** Correlatable classes pulled (bounded + windowed) for the session metrics. */
const SESSION_ROW_CLASSES = ["cli", "browser-agent", "human-or-browser"];
/** Hard cap on the correlation row pull, so a poll can never self-DoS. */
const SESSION_ROW_CAP = 5000;
/** Default window when the caller passes no `since` (24h). */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The telemetry summary when capture has data. */
export interface AgentTelemetrySummary {
  enabled: true;
  /** Lower bound of the window this summary covers (epoch ms). */
  since: number;
  /** S3 outcomes + served-vs-not segmentation (accurate over the window). */
  outcomes: OutcomeAggregate;
  /** Recovery/escalation + coverage (a bounded sample at high volume). */
  sessions: SessionAggregate;
  /** One-sentence headline; each clause names its source + coverage. */
  headline: string;
  /**
   * Coverage/confidence metadata M5 must surface so no number is over-read.
   */
  coverage: {
    /** `sessions.sessionableCoverage` — fraction of traffic that is sessionable. */
    sessionable: number;
    /** `sessions.recovery.coverage` — fraction of dead-ends that were correlatable. */
    recovery: number;
    /** Escalation is best-effort over the hashed-IP correlator; it UNDERcounts. */
    escalationBestEffort: true;
    /** True when the correlation pull hit its cap (numbers are a sample). */
    correlationSampled: boolean;
  };
}

/** The disabled/no-storage shape — a valid 200 payload, never a 500. */
export interface AgentTelemetryDisabled {
  enabled: false;
}

/** Round a `[0,1]` rate to a whole-number percentage. */
function pct(rate: number): number {
  return Math.round(rate * 100);
}

/**
 * Build the single headline sentence. Every clause is grounded and labelled:
 * requests + dead-ends + served come from the accurate outcome aggregate; the
 * recovery clause carries its coverage; escalation is flagged best-effort.
 */
export function buildHeadline(
  outcomes: OutcomeAggregate,
  sessions: SessionAggregate,
): string {
  const clauses: string[] = [];
  clauses.push(`Agents made ${outcomes.total} requests`);
  clauses.push(
    `hit ${outcomes.deadEnds} dead-ends (${pct(outcomes.deadEndRate)}%)`,
  );
  if (sessions.recovery.deadEnds > 0) {
    clauses.push(
      `of ${sessions.recovery.deadEnds} correlatable, ${
        sessions.recovery.abandoned
      } never recovered (${pct(sessions.recovery.coverage)}% coverage)`,
    );
  }
  clauses.push(`we served ${outcomes.served.total} self-sufficient responses`);
  clauses.push(`${sessions.escalations} escalated to a browser (best-effort)`);
  return `${clauses.join(" · ")}.`;
}

/** Assemble the summary from precomputed parts (shared by both entry points). */
function assemble(
  outcomes: OutcomeAggregate,
  sessions: SessionAggregate,
  since: number,
  correlationSampled: boolean,
): AgentTelemetrySummary {
  return {
    enabled: true,
    since,
    outcomes,
    sessions,
    headline: buildHeadline(outcomes, sessions),
    coverage: {
      sessionable: sessions.sessionableCoverage,
      recovery: sessions.recovery.coverage,
      escalationBestEffort: true,
      correlationSampled,
    },
  };
}

/** Options for {@link summarizeAgentTelemetry}. */
export interface SummarizeAgentOptions extends SessionOptions {
  /** Lower bound echoed into the summary (epoch ms). Defaults to 0. */
  since?: number;
}

/**
 * Compute the full telemetry summary from raw records — the pure, table-tested
 * entry point. Aggregates outcomes AND sessions from the SAME record set, so the
 * coverage denominators are exact. (The route uses the DB-aggregate path instead,
 * for scale; both call {@link assemble} to produce an identical shape.)
 */
export function summarizeAgentTelemetry(
  records: readonly AgentRequestRecord[],
  opts: SummarizeAgentOptions = {},
): AgentTelemetrySummary {
  const outcomes = computeAgentOutcomes(records);
  const sessions = computeAgentSessions(records, opts);
  return assemble(outcomes, sessions, opts.since ?? 0, false);
}

/**
 * Derive the honest unsessionable-by-class breakdown from the FULL-traffic
 * outcome aggregate (the cheap DB `GROUP BY`), naming every unsessionable class —
 * chat-fetchers, crawlers, `human-or-browser` — that the bounded correlation pull
 * does not fetch. `computeAgentSessions`'s own list only sees the correlatable
 * pull, so at the route we override it with this all-traffic version.
 */
function unsessionableByClassFromOutcomes(
  outcomes: OutcomeAggregate,
): UnsessionableClass[] {
  return outcomes.byClass
    .filter(
      (c) => c.agentClass === null || !SESSIONABLE_CLASSES.has(c.agentClass),
    )
    .map((c) => ({
      agentClass: c.agentClass ?? "unclassified",
      count: c.total,
    }))
    .sort(
      (a, b) => b.count - a.count || a.agentClass.localeCompare(b.agentClass),
    );
}

/** Parse a non-negative integer query param, or `undefined` if absent/invalid. */
function intParam(raw: unknown): number | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** A string query param, or `undefined` if absent/empty. */
function strParam(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Build the telemetry summary from storage for the given window. Uses the DB-side
 * outcome aggregate for the accurate numbers and a bounded pull for correlation.
 * Returns the disabled shape when there is no usable storage.
 */
export async function readAgentTelemetry(
  storage: StorageAdapter | null,
  opts: { since: number; until?: number; siteId?: string },
): Promise<AgentTelemetrySummary | AgentTelemetryDisabled> {
  if (!storage?.queryAgentRequests) {
    return { enabled: false };
  }
  const { since, until, siteId } = opts;

  // (1) Accurate outcome numbers — DB GROUP BY when available, else a bounded
  //     record pull + in-JS grouping (still capped, never the whole table).
  let outcomes: OutcomeAggregate;
  if (storage.aggregateAgentOutcomes) {
    const groups = await storage.aggregateAgentOutcomes({
      since,
      until,
      siteId,
    });
    outcomes = foldOutcomeGroups(groups);
  } else {
    const rows = await storage.queryAgentRequests({
      since,
      until,
      siteId,
      limit: SESSION_ROW_CAP,
    });
    outcomes = computeAgentOutcomes(rows);
  }

  // (2) Correlation numbers — bounded, windowed pull of only the correlatable
  //     classes, with the TRUE total from (1) as the coverage denominator.
  const rows = await storage.queryAgentRequests({
    since,
    until,
    siteId,
    classes: SESSION_ROW_CLASSES,
    limit: SESSION_ROW_CAP,
  });
  const sessions = computeAgentSessions(rows, {
    totalRequests: outcomes.total,
  });
  // The bounded pull cannot see chat-fetchers/crawlers, so replace the sample's
  // by-class breakdown with the accurate all-traffic one from the DB aggregate.
  const merged: SessionAggregate = {
    ...sessions,
    unsessionableByClass: unsessionableByClassFromOutcomes(outcomes),
  };
  return assemble(outcomes, merged, since, rows.length >= SESSION_ROW_CAP);
}

/**
 * Build the agent telemetry read API router. Mounted alongside the observability
 * router (dev-open, prod-guarded). Reads storage per-request so the disabled path
 * is a 200 empty payload, never a 500.
 */
export function createAgentTelemetryRouter(
  getStorage: () => StorageAdapter | null = getActiveStorage,
): Router {
  const router = express.Router();
  const base = "/__enpilink/agents";

  // GET /summary?since&until&site — the outcome + correlation summary.
  router.get(`${base}/summary`, async (req, res) => {
    const storage = getStorage();
    if (!storage) {
      res.json({ enabled: false } satisfies AgentTelemetryDisabled);
      return;
    }
    const since = intParam(req.query.since) ?? Date.now() - DEFAULT_WINDOW_MS;
    const until = intParam(req.query.until);
    const siteId = strParam(req.query.site);
    try {
      const opts: { since: number; until?: number; siteId?: string } = {
        since,
      };
      if (until !== undefined) {
        opts.until = until;
      }
      if (siteId !== undefined) {
        opts.siteId = siteId;
      }
      res.json(await readAgentTelemetry(storage, opts));
    } catch {
      res.json({ enabled: false } satisfies AgentTelemetryDisabled);
    }
  });

  return router;
}
