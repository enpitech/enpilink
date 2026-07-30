import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {
  AgentRequestRow,
  AgentRequestsResponse,
  AgentRoutesResponse,
  RouteAggregate,
} from "enpilink/server";
import { z } from "zod";
import { authedFetch } from "./admin-token-store.js";

/**
 * Agent by-route + drill-down client (A2): TanStack Query hooks + zod schemas for
 * the A1 read API (`GET /__enpilink/agents/routes`, `GET /__enpilink/agents/requests`).
 * The Routes sub-view consumes these, mirroring `agents-store.ts` (same polling
 * cadence, same `authedFetch` bearer injection, same "never throw on the disabled
 * path" discipline).
 *
 * WHY the schemas are re-declared here rather than imported from `enpilink/server`:
 * the A1 milestone exported the runtime zod (`agentRoutesResponseSchema`, …) for us
 * to reuse — but those live in `server/agent/telemetry.ts`, whose module graph pulls
 * in Express + the sqlite/pg storage adapters (`node:crypto`, `node:path`). Importing
 * the runtime *value* into this browser SPA drags those Node built-ins into the Vite
 * bundle and the build fails. So we import the exported *types* (erased at compile,
 * zero bundle cost) and keep local zod in exact lockstep with them via the compile-time
 * parity assertions below — any server-side shape drift becomes a `tsc` error here.
 * (Making the runtime zod importable needs a zod-only, browser-safe server subpath —
 * a small server change deliberately left out of A2's console-only scope.)
 *
 * As in `agents-store.ts`, `agentFamily` / `agentClass` / `confidence` stay `z.string()`
 * (not enums): the behavioural taxonomy GROWS as the fingerprint corpus grows, and a
 * strict enum would reject a client the server learned to name after this bundle shipped.
 */

const BASE = "/__enpilink/agents";

// --- Schemas (mirror server/agent/telemetry.ts; kept in lockstep, see parity below) ---

/** `OutcomeHistogram` — the four read-outcome classes. */
const outcomeHistogramSchema = z.object({
  resolved: z.number(),
  dead_end: z.number(),
  blocked: z.number(),
  broken: z.number(),
});

/** The four S3 read outcomes (a fixed enum on the server). */
const outcomeEnumSchema = z.enum(["resolved", "dead_end", "blocked", "broken"]);

/** `RouteFamilyCount` — one agent family's volume on a route (`null` = unnamed). */
const routeFamilyCountSchema = z.object({
  family: z.string().nullable(),
  count: z.number(),
});

/** `RouteAggregate` — one endpoint's stats (fold output; volume-sorted upstream). */
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
    since: z.number(),
    routes: z.array(routeAggregateSchema),
  }),
  z.object({ enabled: z.literal(false) }),
]);

/** `AgentRequestRow` — one drill-down row (no raw headers / ipHash by construction). */
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

/** `GET /requests` — a filtered, paginated page of the drill-down, or degraded. */
export const agentRequestsResponseSchema = z.discriminatedUnion("enabled", [
  z.object({
    enabled: z.literal(true),
    since: z.number(),
    requests: z.array(agentRequestRowSchema),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  }),
  z.object({ enabled: z.literal(false) }),
]);

// Compile-time lockstep: the local schemas MUST infer to the exact types A1 exports.
// If the server changes a response shape, `Equal<…>` flips to `false` and `Expect<…>`
// makes this a `tsc` error — the honest substitute for importing the runtime zod.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <U>() => U extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
// One exported tuple holds all four assertions — a mismatch with the server's
// exported types is a `tsc` error, and exporting keeps `noUnusedLocals` quiet.
export type _AgentRouteContract = [
  Expect<Equal<z.infer<typeof agentRoutesResponseSchema>, AgentRoutesResponse>>,
  Expect<
    Equal<z.infer<typeof agentRequestsResponseSchema>, AgentRequestsResponse>
  >,
  Expect<Equal<z.infer<typeof routeAggregateSchema>, RouteAggregate>>,
  Expect<Equal<z.infer<typeof agentRequestRowSchema>, AgentRequestRow>>,
];

// Re-export the imported types so consumers get them from one place (the runtime
// values above; the types from the server contract).
export type { AgentRequestRow, RouteAggregate };
/** The populated `/routes` payload (capture on AND storage present). */
export type AgentRoutesEnabled = Extract<
  AgentRoutesResponse,
  { enabled: true }
>;
/** The populated `/requests` payload. */
export type AgentRequestsEnabled = Extract<
  AgentRequestsResponse,
  { enabled: true }
>;
/** The four read outcomes, as a union. */
export type AgentOutcome = z.infer<typeof outcomeEnumSchema>;

// --- Hooks ---

/** Default drill-down page size (server caps at 200). */
export const REQUESTS_PAGE_SIZE = 50;

/**
 * Poll the by-route breakdown for a `since` lower bound (epoch ms). `errorsOnly`
 * is applied SERVER-side (the endpoint's first-class filter). Mirrors
 * `useAgentSummary`: 5s polling, `authedFetch`, tolerant zod parse. Does NOT
 * require an MCP connection.
 */
export function useAgentRoutes(opts: {
  since: number;
  until?: number;
  errorsOnly?: boolean;
}) {
  const { since, until, errorsOnly } = opts;
  return useQuery({
    queryKey: ["agents", "routes", since, until ?? null, Boolean(errorsOnly)],
    queryFn: async (): Promise<AgentRoutesResponse> => {
      const qs = new URLSearchParams({ since: String(since) });
      if (until !== undefined) {
        qs.set("until", String(until));
      }
      if (errorsOnly) {
        qs.set("errorsOnly", "true");
      }
      const res = await authedFetch(`${BASE}/routes?${qs.toString()}`);
      if (!res.ok) {
        throw new Error(`agent routes failed (${res.status})`);
      }
      return agentRoutesResponseSchema.parse(await res.json());
    },
    refetchInterval: 5000,
  });
}

/** The drill-down filter set. Empty/undefined fields are simply omitted. */
export interface RequestsFilter {
  since: number;
  until?: number;
  outcome?: AgentOutcome;
  /** Server param `family`. */
  agentFamily?: string;
  /** Server param `class`. */
  agentClass?: string;
  status?: number;
  path?: string;
  limit?: number;
  offset?: number;
}

/**
 * Poll a filtered, paginated page of the request drill-down. Pagination is
 * OFFSET-based; the caller advances `offset` and uses the response's `hasMore`
 * (never `requests.length`) to decide whether a next page exists. `placeholderData`
 * keeps the previous page visible while the next loads so the table doesn't flash.
 * `enabled` lets a closed drill-down skip fetching entirely.
 */
export function useAgentRequests(filter: RequestsFilter, enabled = true) {
  const {
    since,
    until,
    outcome,
    agentFamily,
    agentClass,
    status,
    path,
    limit = REQUESTS_PAGE_SIZE,
    offset = 0,
  } = filter;
  return useQuery({
    queryKey: [
      "agents",
      "requests",
      since,
      until ?? null,
      outcome ?? null,
      agentFamily ?? null,
      agentClass ?? null,
      status ?? null,
      path ?? null,
      limit,
      offset,
    ],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<AgentRequestsResponse> => {
      const qs = new URLSearchParams({
        since: String(since),
        limit: String(limit),
        offset: String(offset),
      });
      if (until !== undefined) {
        qs.set("until", String(until));
      }
      if (outcome) {
        qs.set("outcome", outcome);
      }
      if (agentFamily) {
        qs.set("family", agentFamily);
      }
      if (agentClass) {
        qs.set("class", agentClass);
      }
      if (status !== undefined) {
        qs.set("status", String(status));
      }
      if (path) {
        qs.set("path", path);
      }
      const res = await authedFetch(`${BASE}/requests?${qs.toString()}`);
      if (!res.ok) {
        throw new Error(`agent requests failed (${res.status})`);
      }
      return agentRequestsResponseSchema.parse(await res.json());
    },
    refetchInterval: 5000,
  });
}

// --- Pure view-model helpers (unit-tested; the React layer just renders them) ---

/**
 * The confidence tiers the server currently emits (`ip-verified` / `ua-only` /
 * `shape` / `pending` / `none`) collapsed into a small set the UI paints
 * distinctly. The CORE honesty rule (brief): a verified hit must NOT look like a
 * guess. `confidence` is a plain string so unknown future tiers fall through to
 * `other` (a neutral badge showing the raw label) rather than being dropped.
 */
export type ConfidenceTier =
  | "verified"
  | "shape"
  | "heuristic"
  | "pending"
  | "none"
  | "other";

/** Map a raw `confidence` string to its tier + a short human label. */
export function confidenceTierMeta(confidence: string): {
  tier: ConfidenceTier;
  label: string;
} {
  switch (confidence) {
    case "ip-verified":
      return { tier: "verified", label: "IP-verified" };
    case "shape":
      return { tier: "shape", label: "Shape match" };
    case "ua-only":
      return { tier: "heuristic", label: "UA-only" };
    case "pending":
      return { tier: "pending", label: "Pending" };
    case "none":
      return { tier: "none", label: "None" };
    default:
      return { tier: "other", label: confidence };
  }
}

/** What the routing layer actually returned for one request. */
export type ServedKind =
  | "rescue"
  | "passthrough"
  | "dead_end"
  | "blocked"
  | "broken";

export type ServedTone = "rescue" | "neutral" | "danger";

/**
 * Describe what we SERVED for a drill-down row from `served` / `servedEncoding` /
 * `status` / `outcome`. A `served` row is a rescued dead-end by construction — a
 * would-be 404 answered with a self-sufficient representation (M3.5), so it reads
 * as a rescue, NOT a plain success. A not-served `resolved` is the site's own page
 * answering (a passthrough). Everything else is the honest failure it was.
 */
export function describeServed(row: {
  served: boolean;
  servedEncoding: "markdown" | "html" | null;
  status: number;
  outcome: AgentOutcome;
}): { kind: ServedKind; label: string; detail?: string; tone: ServedTone } {
  if (row.served) {
    return {
      kind: "rescue",
      label: `${row.status} rescue`,
      detail: row.servedEncoding ?? undefined,
      tone: "rescue",
    };
  }
  switch (row.outcome) {
    case "resolved":
      return {
        kind: "passthrough",
        label: `${row.status} passthrough`,
        tone: "neutral",
      };
    case "dead_end":
      return {
        kind: "dead_end",
        label: `${row.status} dead-end`,
        tone: "danger",
      };
    case "blocked":
      return {
        kind: "blocked",
        label: `${row.status} blocked`,
        tone: "danger",
      };
    case "broken":
      return { kind: "broken", label: `${row.status} broken`, tone: "danger" };
    default:
      return {
        kind: "passthrough",
        label: String(row.status),
        tone: "neutral",
      };
  }
}

/**
 * The per-route "what was responded" summary: of a route's dead-ends (`errorCount`
 * = dead_end + blocked + broken), how many were RESCUED (`servedCount`). A rescued
 * dead-end counts in BOTH `servedCount` and `errorCount` (A1 contract) — so we
 * render "N of M rescued" and NEVER subtract `servedCount` out of the error total.
 */
export function rescueSummary(route: {
  servedCount: number;
  errorCount: number;
}): {
  rescued: number;
  deadEnds: number;
  stillLost: number;
  rescuedRate: number;
} {
  const rescued = Math.min(route.servedCount, route.errorCount);
  const deadEnds = route.errorCount;
  const stillLost = Math.max(0, deadEnds - rescued);
  const rescuedRate = deadEnds === 0 ? 0 : rescued / deadEnds;
  return { rescued, deadEnds, stillLost, rescuedRate };
}

/** The single highest-volume named family on a route (skips the unnamed bucket). */
export function topNamedFamily(route: RouteAggregate): string | null {
  for (const f of route.topFamilies) {
    if (f.family) {
      return f.family;
    }
  }
  return null;
}
