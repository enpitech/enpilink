import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";
import { create } from "zustand";
import { authedFetch, withStreamToken } from "./admin-token-store.js";

/**
 * Observability client (M3): TanStack Query hooks for the read API
 * (`/summary`, `/events`) + a zustand SSE store mirroring `tunnel-store.ts`
 * for the live `/stream`. The Dashboard tab consumes these.
 *
 * Everything is fetched relative to `window.location.origin` (the dev server
 * serves the API on the same origin), so no base-URL config is needed. When
 * analytics is OFF the API returns `{ enabled: false }` payloads (never errors)
 * and the UI shows a friendly hint instead of breaking.
 */

const BASE = "/__enpilink/observability";

// --- Schemas (tolerant: the API may evolve; unknown fields are ignored) ---

const timeBucketSchema = z.object({
  ts: z.number(),
  count: z.number(),
  errors: z.number(),
});

const toolStatSchema = z.object({
  name: z.string(),
  count: z.number(),
  errors: z.number(),
  errorRate: z.number(),
  p50: z.number(),
  p95: z.number(),
  p99: z.number().default(0),
  avg: z.number().default(0),
});

const methodStatSchema = z.object({
  method: z.string(),
  count: z.number(),
  errors: z.number(),
});

const latencyBucketSchema = z.object({
  from: z.number(),
  to: z.number().nullable(),
  count: z.number(),
});

export const summarySchema = z.object({
  enabled: z.boolean(),
  total: z.number(),
  errors: z.number(),
  errorRate: z.number(),
  p50: z.number(),
  p95: z.number(),
  p99: z.number().default(0),
  avg: z.number().default(0),
  throughputPerMin: z.number().default(0),
  bucketMs: z.number(),
  callsOverTime: z.array(timeBucketSchema),
  topTools: z.array(toolStatSchema),
  slowestTools: z.array(toolStatSchema).default([]),
  byMethod: z.array(methodStatSchema).default([]),
  latencyHistogram: z.array(latencyBucketSchema).default([]),
});

export type Summary = z.infer<typeof summarySchema>;
export type ToolStat = z.infer<typeof toolStatSchema>;
export type TimeBucket = z.infer<typeof timeBucketSchema>;
export type MethodStat = z.infer<typeof methodStatSchema>;
export type LatencyBucket = z.infer<typeof latencyBucketSchema>;

export const analyticsEventSchema = z.object({
  ts: z.number(),
  type: z.string(),
  tool: z.string().optional(),
  method: z.string().optional(),
  ms: z.number().optional(),
  ok: z.boolean().optional(),
  error: z.string().optional(),
});

export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

const eventsResponseSchema = z.object({
  enabled: z.boolean(),
  events: z.array(analyticsEventSchema),
});

export const logEntrySchema = z.object({
  ts: z.number(),
  level: z.enum(["debug", "info", "warning", "error"]),
  msg: z.string(),
  data: z.unknown().optional(),
});

export type LogEntry = z.infer<typeof logEntrySchema>;

// --- Dashboard-wide time range (M9) ---

/** The selectable dashboard time ranges (GA-style). */
export type RangeKey = "1h" | "24h" | "7d" | "30d" | "all";

/** The default range on first load. */
export const DEFAULT_RANGE: RangeKey = "7d";

/** Ordered list of ranges for rendering the picker. */
export const RANGE_KEYS: RangeKey[] = ["1h", "24h", "7d", "30d", "all"];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Per-range config: the trailing window length (`rangeMs`, `null` = "All time"),
 * the time-bucket size for the volume chart (adapted so the series has a sane
 * number of points), and a short human label.
 */
export interface RangeConfig {
  label: string;
  /** Window length in ms, or `null` for "All time" (→ `since` = 0). */
  rangeMs: number | null;
  /** Volume-chart bucket width in ms, passed to the summary `bucketMs`. */
  bucketMs: number;
}

export const RANGES: Record<RangeKey, RangeConfig> = {
  // ~60 one-minute buckets
  "1h": { label: "Last 1 hour", rangeMs: HOUR, bucketMs: MINUTE },
  // 24 hourly buckets
  "24h": { label: "Last 24 hours", rangeMs: DAY, bucketMs: HOUR },
  // 28 six-hour buckets
  "7d": { label: "Last 7 days", rangeMs: 7 * DAY, bucketMs: 6 * HOUR },
  // 30 daily buckets
  "30d": { label: "Last 30 days", rangeMs: 30 * DAY, bucketMs: DAY },
  // daily buckets across whatever history exists
  all: { label: "All time", rangeMs: null, bucketMs: DAY },
};

/**
 * Resolve a range key to the `since` lower bound (epoch ms; `0` for "All") and
 * the adapted `bucketMs`. `now` is injected so it stays referentially stable
 * across a render (callers memoize it per refetch tick).
 */
export function resolveRange(
  range: RangeKey,
  now: number,
): { since: number; bucketMs: number } {
  const cfg = RANGES[range] ?? RANGES[DEFAULT_RANGE];
  const since = cfg.rangeMs === null ? 0 : Math.max(0, now - cfg.rangeMs);
  return { since, bucketMs: cfg.bucketMs };
}

// --- TanStack Query hooks (polling) ---

/**
 * Summary scoped to a `since` lower bound + an adapted `bucketMs`. The query
 * key includes both so changing the range refetches. Callers quantize `since`
 * (the Dashboard rounds `now` to a 30s step) so polling doesn't thrash the
 * cache key every render.
 */
export function useObservabilitySummary(since: number, bucketMs: number) {
  return useQuery({
    queryKey: ["observability", "summary", since, bucketMs],
    queryFn: async (): Promise<Summary> => {
      const res = await authedFetch(
        `${BASE}/summary?since=${since}&bucketMs=${bucketMs}`,
      );
      if (!res.ok) {
        throw new Error(`summary failed (${res.status})`);
      }
      return summarySchema.parse(await res.json());
    },
    refetchInterval: 5000,
  });
}

export function useObservabilityEvents(since: number, limit = 100) {
  return useQuery({
    queryKey: ["observability", "events", since, limit],
    queryFn: async (): Promise<AnalyticsEvent[]> => {
      const res = await authedFetch(
        `${BASE}/events?since=${since}&limit=${limit}`,
      );
      if (!res.ok) {
        throw new Error(`events failed (${res.status})`);
      }
      return eventsResponseSchema.parse(await res.json()).events;
    },
    refetchInterval: 5000,
  });
}

const logsResponseSchema = z.object({
  enabled: z.boolean(),
  logs: z.array(logEntrySchema),
});

/** A history log row with a stable client id (logs carry no server id). */
export type HistoryLog = LogEntry & { id: string };

/** The result of a logs-history fetch: rows + whether storage is enabled. */
export interface LogsHistory {
  enabled: boolean;
  logs: HistoryLog[];
}

/**
 * Logs history for the dedicated Logs page. Pass-through to the existing
 * observability `GET /logs?since&level&limit` endpoint (backed by
 * `storage.queryLogs`, returned most-recent-first). Used to backfill the page
 * with persisted history; the live SSE stream then tails new lines on top.
 * Returns `{ enabled: false, logs: [] }` (never throws) when analytics/storage
 * is off so the page can show a friendly disabled state.
 */
export function useObservabilityLogs(
  since: number,
  level?: string,
  limit = 500,
) {
  return useQuery({
    queryKey: ["observability", "logs", since, level ?? "all", limit],
    queryFn: async (): Promise<LogsHistory> => {
      const params = new URLSearchParams({
        since: String(since),
        limit: String(limit),
      });
      if (level) {
        params.set("level", level);
      }
      const res = await authedFetch(`${BASE}/logs?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`logs failed (${res.status})`);
      }
      const parsed = logsResponseSchema.parse(await res.json());
      // Tag rows with a stable id (ts + index) for keying; rows are
      // most-recent-first from the server.
      return {
        enabled: parsed.enabled,
        logs: parsed.logs.map((l, i) => ({ ...l, id: `${l.ts}-${i}` })),
      };
    },
    refetchInterval: 5000,
  });
}

// --- Live SSE store (mirrors tunnel-store.ts) ---

const MAX_LIVE_LOGS = 500;

/** A live log with a stable client-assigned id (logs carry no server id). */
export type LiveLog = LogEntry & { id: number };

let liveLogSeq = 0;

type ObservabilityStreamStore = {
  /** Most-recent-first ring of live log lines pushed over SSE. */
  liveLogs: LiveLog[];
  /** Whether the stream reports analytics is enabled. */
  enabled: boolean;
  /** Connect the SSE stream, optionally backfilling logs since `since` (epoch ms). */
  connect: (since?: number) => () => void;
  clear: () => void;
};

export const useObservabilityStream = create<ObservabilityStreamStore>()(
  (set) => ({
    liveLogs: [],
    enabled: false,

    connect(since?: number) {
      // EventSource can't set headers; append the admin token as `?token=`
      // (no-op in dev where no token is set). When a `since` is given, start the
      // stream cursor there so logs within the selected range are backfilled
      // (otherwise the server starts the cursor at connect time = forward-only).
      const url =
        since !== undefined
          ? `${BASE}/stream?since=${since}`
          : `${BASE}/stream`;
      const source = new EventSource(withStreamToken(url));

      source.addEventListener("status", (event) => {
        if (!(event instanceof MessageEvent)) {
          return;
        }
        try {
          const parsed = z
            .object({ enabled: z.boolean() })
            .safeParse(JSON.parse(event.data));
          if (parsed.success) {
            set({ enabled: parsed.data.enabled });
          }
        } catch {
          // ignore malformed frame
        }
      });

      source.addEventListener("logs", (event) => {
        if (!(event instanceof MessageEvent)) {
          return;
        }
        try {
          const parsed = z
            .array(logEntrySchema)
            .safeParse(JSON.parse(event.data));
          if (parsed.success && parsed.data.length > 0) {
            // Server sends most-recent-first; tag with a stable id, prepend,
            // then cap.
            const tagged: LiveLog[] = parsed.data.map((l) => ({
              ...l,
              id: liveLogSeq++,
            }));
            set((s) => ({
              liveLogs: [...tagged, ...s.liveLogs].slice(0, MAX_LIVE_LOGS),
            }));
          }
        } catch {
          // ignore malformed frame
        }
      });

      return () => {
        source.close();
      };
    },

    clear() {
      set({ liveLogs: [] });
    },
  }),
);

/**
 * Subscribe to the live observability stream for the component's lifetime.
 * When `since` changes (the dashboard range changed), the previous stream is
 * torn down, the log ring is cleared, and a fresh stream is opened from the new
 * lower bound so the Live logs panel re-scopes to the selected range.
 */
export function useConnectObservabilityStream(since?: number) {
  const connect = useObservabilityStream((s) => s.connect);
  const clear = useObservabilityStream((s) => s.clear);
  useEffect(() => {
    clear();
    return connect(since);
  }, [connect, clear, since]);
}
