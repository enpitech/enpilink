import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";
import { create } from "zustand";

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

// --- TanStack Query hooks (polling) ---

export function useObservabilitySummary(bucketMs = 60_000) {
  return useQuery({
    queryKey: ["observability", "summary", bucketMs],
    queryFn: async (): Promise<Summary> => {
      const res = await fetch(`${BASE}/summary?bucketMs=${bucketMs}`);
      if (!res.ok) {
        throw new Error(`summary failed (${res.status})`);
      }
      return summarySchema.parse(await res.json());
    },
    refetchInterval: 5000,
  });
}

export function useObservabilityEvents(limit = 100) {
  return useQuery({
    queryKey: ["observability", "events", limit],
    queryFn: async (): Promise<AnalyticsEvent[]> => {
      const res = await fetch(`${BASE}/events?limit=${limit}`);
      if (!res.ok) {
        throw new Error(`events failed (${res.status})`);
      }
      return eventsResponseSchema.parse(await res.json()).events;
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
  connect: () => () => void;
  clear: () => void;
};

export const useObservabilityStream = create<ObservabilityStreamStore>()(
  (set) => ({
    liveLogs: [],
    enabled: false,

    connect() {
      const source = new EventSource(`${BASE}/stream`);

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

/** Subscribe to the live observability stream for the component's lifetime. */
export function useConnectObservabilityStream() {
  const connect = useObservabilityStream((s) => s.connect);
  useEffect(() => connect(), [connect]);
}
