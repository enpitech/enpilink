import express, { type Router } from "express";
import { z } from "zod";
import { getActiveStorage } from "../log-sink.js";
import type {
  AgentRequestQuery,
  AgentRequestRecord,
  StorageAdapter,
} from "../storage/types.js";
import {
  computeAgentOutcomes,
  computeAgentRoutes,
  foldOutcomeGroups,
  foldRouteGroups,
  type OutcomeAggregate,
  type RouteAggregate,
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
/** Default page size for the request drill-down when none is given. */
const DEFAULT_PAGE_SIZE = 50;
/** Hard cap on the request drill-down page size (a request can never self-DoS). */
const MAX_PAGE_SIZE = 200;

/** The telemetry summary when capture has data. */
export interface AgentTelemetrySummary {
  enabled: true;
  /** Lower bound of the window this summary covers (epoch ms). */
  since: number;
  /** S3 outcomes + served-vs-not segmentation (accurate over the window). */
  outcomes: OutcomeAggregate;
  /** Recovery/escalation + coverage (a bounded sample at high volume). */
  sessions: SessionAggregate;
  /**
   * Dead-ends the routing layer RESCUED with a served representation (M3.5) —
   * exactly the `served` + `outcome = "dead_end"` segment. The money contrast M5
   * renders: of `outcomes.deadEnds` dead-ends, `rescuedDeadEnds` were answered.
   */
  rescuedDeadEnds: number;
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
 * requests + dead-ends + rescued come from the accurate outcome aggregate; the
 * recovery clause carries its coverage; escalation is flagged best-effort. The
 * rescued clause is the M3.5 money view — of the dead-ends, how many did the
 * served representation answer.
 */
export function buildHeadline(
  outcomes: OutcomeAggregate,
  sessions: SessionAggregate,
): string {
  const rescued = outcomes.served.deadEnds;
  const clauses: string[] = [];
  clauses.push(`Agents made ${outcomes.total} requests`);
  clauses.push(
    `hit ${outcomes.deadEnds} dead-ends (${pct(outcomes.deadEndRate)}%)`,
  );
  if (rescued > 0) {
    clauses.push(`${rescued} rescued by a served representation`);
  }
  if (sessions.recovery.deadEnds > 0) {
    clauses.push(
      `of ${sessions.recovery.deadEnds} correlatable, ${
        sessions.recovery.abandoned
      } never recovered (${pct(sessions.recovery.coverage)}% coverage)`,
    );
  }
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
    rescuedDeadEnds: outcomes.served.deadEnds,
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

/** A boolean query param — true for `"1"`/`"true"` (case-insensitive), else false. */
function boolParam(raw: unknown): boolean {
  return (
    raw === "1" || (typeof raw === "string" && raw.toLowerCase() === "true")
  );
}

/** Clamp a requested page size into `[1, MAX_PAGE_SIZE]`, defaulting when unset. */
function clampPageSize(raw: number | undefined): number {
  if (raw === undefined || raw <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(raw, MAX_PAGE_SIZE);
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

// ── A1: by-route aggregation + a filterable requests drill-down ──────────────
//
// Two read endpoints the console Routes page consumes. Both degrade to
// `{ enabled: false }` (a 200, never a 500) exactly like `/summary`. Their
// responses carry zod schemas so the consumer parses a validated shape; the
// server builds objects typed by `z.infer`, so a shape drift is a compile error.

/** The four S3 read-outcome classes a captured row can carry (fixed, not growing). */
const outcomeEnumSchema = z.enum(["resolved", "dead_end", "blocked", "broken"]);

/** `OutcomeHistogram` — zero-filled read-outcome counts. */
const outcomeHistogramSchema = z.object({
  resolved: z.number(),
  dead_end: z.number(),
  blocked: z.number(),
  broken: z.number(),
});

/** `RouteFamilyCount` — one agent family's volume on a route (`null` = unnamed). */
const routeFamilyCountSchema = z.object({
  family: z.string().nullable(),
  count: z.number(),
});

/**
 * `RouteAggregate` — one endpoint's stats. Mirrors {@link RouteAggregate} in
 * `outcomes.ts`; the fold there produces exactly this shape.
 */
const routeAggregateSchema = z.object({
  path: z.string(),
  requests: z.number(),
  outcomeHistogram: outcomeHistogramSchema,
  deadEndRate: z.number(),
  servedCount: z.number(),
  errorCount: z.number(),
  topFamilies: z.array(routeFamilyCountSchema),
});

/** `GET /routes` — the per-endpoint breakdown, or the degraded shape. */
export const agentRoutesResponseSchema = z.discriminatedUnion("enabled", [
  z.object({
    enabled: z.literal(true),
    /** Lower bound of the window (epoch ms). */
    since: z.number(),
    /** Per-route stats, most requests first (see `foldRouteGroups`). */
    routes: z.array(routeAggregateSchema),
  }),
  z.object({ enabled: z.literal(false) }),
]);

/** The populated `/routes` payload. */
export type AgentRoutesSummary = Extract<
  z.infer<typeof agentRoutesResponseSchema>,
  { enabled: true }
>;
/** The full `/routes` response (populated OR degraded). */
export type AgentRoutesResponse = z.infer<typeof agentRoutesResponseSchema>;

/**
 * `AgentRequestRow` — one row of the drill-down: the request (`ts`/`method`/
 * `path`/`ua`) + what we responded (`status`/`outcome`/`served`/`servedEncoding`)
 * + the attribution (`agentFamily`/`agentClass`/`confidence`). Deliberately does
 * NOT expose the raw `headers` or the salted `ipHash` — the drill-down is a
 * behavioural view, not a fingerprint dump. `agentClass`/`family`/`confidence`
 * stay `string` (not enums): the taxonomy GROWS as the corpus does. `confidence`
 * is the tier the console MUST render distinctly (a verified hit must not look
 * like a `ua-only` guess).
 */
const agentRequestRowSchema = z.object({
  id: z.number().optional(),
  ts: z.number(),
  method: z.string(),
  path: z.string(),
  status: z.number(),
  outcome: outcomeEnumSchema,
  served: z.boolean(),
  servedEncoding: z.enum(["markdown", "html"]).nullable(),
  agentFamily: z.string().nullable(),
  agentClass: z.string().nullable(),
  confidence: z.string(),
  ua: z.string().nullable(),
});

/** `GET /requests` — a page of the filtered drill-down, or the degraded shape. */
export const agentRequestsResponseSchema = z.discriminatedUnion("enabled", [
  z.object({
    enabled: z.literal(true),
    /** Lower bound of the window (epoch ms). */
    since: z.number(),
    /** The page of rows (most recent first). */
    requests: z.array(agentRequestRowSchema),
    /** The page size applied (bounded to {@link MAX_PAGE_SIZE}). */
    limit: z.number(),
    /** The page offset applied. */
    offset: z.number(),
    /** Whether another page exists past this one (a `limit + 1` probe). */
    hasMore: z.boolean(),
  }),
  z.object({ enabled: z.literal(false) }),
]);

/** One drill-down row. */
export type AgentRequestRow = z.infer<typeof agentRequestRowSchema>;
/** The populated `/requests` payload. */
export type AgentRequestsSummary = Extract<
  z.infer<typeof agentRequestsResponseSchema>,
  { enabled: true }
>;
/** The full `/requests` response (populated OR degraded). */
export type AgentRequestsResponse = z.infer<typeof agentRequestsResponseSchema>;

/** Options for {@link readAgentRoutes}. */
export interface ReadRoutesOptions {
  /** Lower bound of the window (epoch ms). */
  since: number;
  /** Upper bound of the window (epoch ms), exclusive. */
  until?: number;
  /** Scope to a single site. */
  siteId?: string;
  /** Keep only routes with at least one error (dead_end/blocked/broken). */
  errorsOnly?: boolean;
}

/** Options for {@link readAgentRequests}. */
export interface ReadRequestsOptions {
  /** Lower bound of the window (epoch ms). */
  since: number;
  /** Upper bound of the window (epoch ms), exclusive. */
  until?: number;
  /** Scope to a single site. */
  siteId?: string;
  /** Exact-match filters (each ANDed). */
  outcome?: string;
  agentFamily?: string;
  agentClass?: string;
  status?: number;
  path?: string;
  /** Page size (already clamped by the caller). */
  limit: number;
  /** Page offset. */
  offset: number;
}

/** Project a captured record into the drill-down row (drops headers + ipHash). */
function toRequestRow(r: AgentRequestRecord): AgentRequestRow {
  return {
    ...(r.id !== undefined ? { id: r.id } : {}),
    ts: r.ts,
    method: r.method,
    path: r.path,
    status: r.status,
    outcome: r.outcome,
    served: r.served === true,
    servedEncoding: r.servedEncoding ?? null,
    agentFamily: r.agentFamily ?? null,
    agentClass: r.agentClass ?? null,
    confidence: r.confidence ?? "none",
    ua: r.ua ?? null,
  };
}

/**
 * Build the by-route breakdown from storage for the window. Prefers the DB-side
 * `GROUP BY` ({@link StorageAdapter.aggregateAgentRoutes}); falls back to a
 * BOUNDED record pull + in-JS grouping only when an adapter lacks it (never the
 * whole table). Returns the disabled shape when there is no usable storage.
 */
export async function readAgentRoutes(
  storage: StorageAdapter | null,
  opts: ReadRoutesOptions,
): Promise<AgentRoutesResponse> {
  if (!storage?.aggregateAgentRoutes && !storage?.queryAgentRequests) {
    return { enabled: false };
  }
  const { since, until, siteId, errorsOnly } = opts;
  let routes: RouteAggregate[];
  if (storage.aggregateAgentRoutes) {
    const groups = await storage.aggregateAgentRoutes({ since, until, siteId });
    routes = foldRouteGroups(groups, { errorsOnly });
  } else {
    const rows = await (
      storage.queryAgentRequests as NonNullable<
        StorageAdapter["queryAgentRequests"]
      >
    )({ since, until, siteId, limit: SESSION_ROW_CAP });
    routes = computeAgentRoutes(rows, { errorsOnly });
  }
  return { enabled: true, since, routes };
}

/**
 * Read a filtered, paginated page of the request drill-down. Pulls `limit + 1`
 * rows so `hasMore` is known without a second count query, then trims to the
 * page. Returns the disabled shape when there is no usable storage.
 */
export async function readAgentRequests(
  storage: StorageAdapter | null,
  opts: ReadRequestsOptions,
): Promise<AgentRequestsResponse> {
  if (!storage?.queryAgentRequests) {
    return { enabled: false };
  }
  const { since, until, siteId, limit, offset } = opts;
  const query: AgentRequestQuery = {
    since,
    until,
    siteId,
    outcome: opts.outcome,
    agentFamily: opts.agentFamily,
    agentClass: opts.agentClass,
    status: opts.status,
    path: opts.path,
    // Over-fetch by one so a full page reveals whether another page follows.
    limit: limit + 1,
    offset,
  };
  const rows = await storage.queryAgentRequests(query);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    enabled: true,
    since,
    requests: page.map(toRequestRow),
    limit,
    offset,
    hasMore,
  };
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

  // GET /routes?since&until&site&errorsOnly — the per-endpoint breakdown.
  router.get(`${base}/routes`, async (req, res) => {
    const storage = getStorage();
    if (!storage) {
      res.json({ enabled: false } satisfies AgentTelemetryDisabled);
      return;
    }
    const since = intParam(req.query.since) ?? Date.now() - DEFAULT_WINDOW_MS;
    const opts: ReadRoutesOptions = { since };
    const until = intParam(req.query.until);
    if (until !== undefined) {
      opts.until = until;
    }
    const siteId = strParam(req.query.site);
    if (siteId !== undefined) {
      opts.siteId = siteId;
    }
    if (boolParam(req.query.errorsOnly)) {
      opts.errorsOnly = true;
    }
    try {
      res.json(await readAgentRoutes(storage, opts));
    } catch {
      res.json({ enabled: false } satisfies AgentTelemetryDisabled);
    }
  });

  // GET /requests?since&until&site&outcome&family&class&status&path&limit&offset
  //   — the filtered, paginated drill-down.
  router.get(`${base}/requests`, async (req, res) => {
    const storage = getStorage();
    if (!storage) {
      res.json({ enabled: false } satisfies AgentTelemetryDisabled);
      return;
    }
    const since = intParam(req.query.since) ?? Date.now() - DEFAULT_WINDOW_MS;
    const opts: ReadRequestsOptions = {
      since,
      limit: clampPageSize(intParam(req.query.limit)),
      offset: intParam(req.query.offset) ?? 0,
    };
    const until = intParam(req.query.until);
    if (until !== undefined) {
      opts.until = until;
    }
    const siteId = strParam(req.query.site);
    if (siteId !== undefined) {
      opts.siteId = siteId;
    }
    const outcome = strParam(req.query.outcome);
    if (outcome !== undefined) {
      opts.outcome = outcome;
    }
    const family = strParam(req.query.family);
    if (family !== undefined) {
      opts.agentFamily = family;
    }
    const agentClass = strParam(req.query.class);
    if (agentClass !== undefined) {
      opts.agentClass = agentClass;
    }
    const status = intParam(req.query.status);
    if (status !== undefined) {
      opts.status = status;
    }
    const path = strParam(req.query.path);
    if (path !== undefined) {
      opts.path = path;
    }
    try {
      res.json(await readAgentRequests(storage, opts));
    } catch {
      res.json({ enabled: false } satisfies AgentTelemetryDisabled);
    }
  });

  return router;
}
