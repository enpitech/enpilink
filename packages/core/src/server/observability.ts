import express, { type Router } from "express";
import { getActiveStorage } from "./log-sink.js";
import type { AnalyticsEvent, StorageAdapter } from "./storage/types.js";

/**
 * Observability read API (M3). Pure core — reads the SAME active
 * {@link StorageAdapter} the analytics middleware + log sink write to, via
 * {@link getActiveStorage}. It does NOT depend on `@enpilink/devtools`.
 *
 * Mounted dev-only (under the `NODE_ENV !== "production"` block in
 * `express.ts`) at `/__enpilink/observability/`. The `/__enpilink/` prefix
 * avoids colliding with user-defined routes; the dev-only mount keeps prod
 * surface unchanged (prod admin is M5).
 *
 * Graceful when analytics is OFF: storage is read PER-REQUEST (it may be `null`
 * when disabled or before the server applies middleware). When there is no
 * active storage every route returns a 200 with `{ enabled: false }` / an empty
 * payload — NEVER a 500. The storage may also change between requests, so we
 * never cache it.
 */

/** A single point on the calls-over-time series. */
export interface TimeBucket {
  /** Bucket start, epoch ms (aligned to `bucketMs`). */
  ts: number;
  /** Total calls in the bucket. */
  count: number;
  /** Errored calls in the bucket. */
  errors: number;
}

/** Per-tool (or per-method) aggregate row. */
export interface ToolStat {
  /** Tool name, or the method name when there is no tool (non-`tools/call`). */
  name: string;
  /** Total calls. */
  count: number;
  /** Errored calls. */
  errors: number;
  /** Error rate in `[0, 1]`. */
  errorRate: number;
  /** Median latency (ms). */
  p50: number;
  /** 95th-percentile latency (ms). */
  p95: number;
}

/** The aggregate returned by `GET /summary` when analytics is enabled. */
export interface ObservabilitySummary {
  enabled: true;
  /** Window the summary was computed over (epoch ms). */
  since: number;
  /** Total events considered. */
  total: number;
  /** Errored events. */
  errors: number;
  /** Error rate in `[0, 1]`. */
  errorRate: number;
  /** Median latency across all events (ms). */
  p50: number;
  /** 95th-percentile latency across all events (ms). */
  p95: number;
  /** Bucket width used for {@link callsOverTime} (ms). */
  bucketMs: number;
  /** Calls-over-time series, oldest bucket first. */
  callsOverTime: TimeBucket[];
  /** Top tools/methods by call count (descending). */
  topTools: ToolStat[];
}

/** The disabled/no-storage shape — a valid 200 payload, never a 500. */
export interface ObservabilityDisabled {
  enabled: false;
  total: 0;
  errors: 0;
  errorRate: 0;
  p50: 0;
  p95: 0;
  bucketMs: number;
  callsOverTime: [];
  topTools: [];
}

/**
 * Percentile of a numeric sample using nearest-rank (lower) interpolation.
 * Returns `0` for an empty sample. `p` is in `[0, 1]`. Tolerates `ms === 0`
 * (a zero-latency call is a real data point, not a missing one).
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sorted[lo] ?? 0;
  if (lo === hi) {
    return loVal;
  }
  const hiVal = sorted[hi] ?? loVal;
  const frac = rank - lo;
  return loVal + (hiVal - loVal) * frac;
}

/** Options for {@link summarize}. */
export interface SummarizeOptions {
  /** Lower bound used in the response (epoch ms). */
  since: number;
  /** Bucket width for the calls-over-time series (ms). Defaults to 60_000. */
  bucketMs?: number;
  /** Max tools in `topTools`. Defaults to 10. */
  topLimit?: number;
}

/**
 * Aggregate raw events into a {@link ObservabilitySummary}. Pure + deterministic
 * (no clock, no I/O) so it is unit-testable with injected events. The storage
 * adapter intentionally does NOT aggregate — all rollups happen here.
 *
 * - Latency percentiles only consider events with a numeric `ms` (including
 *   `ms === 0`); events without timing are excluded from p50/p95 but still
 *   counted toward totals + error rate.
 * - `ok === false` (or a present `error`) counts as an error.
 * - Tools group by `tool`, falling back to `method`, then `"unknown"`.
 */
export function summarize(
  events: AnalyticsEvent[],
  opts: SummarizeOptions,
): ObservabilitySummary {
  const bucketMs = opts.bucketMs ?? 60_000;
  const topLimit = opts.topLimit ?? 10;

  const isError = (e: AnalyticsEvent): boolean =>
    e.ok === false || (e.ok === undefined && e.error !== undefined);

  const allLatencies: number[] = [];
  const buckets = new Map<number, TimeBucket>();
  const tools = new Map<
    string,
    { count: number; errors: number; latencies: number[] }
  >();

  let errors = 0;
  for (const e of events) {
    const errored = isError(e);
    if (errored) {
      errors += 1;
    }
    if (typeof e.ms === "number" && Number.isFinite(e.ms)) {
      allLatencies.push(e.ms);
    }

    const bucketTs = Math.floor(e.ts / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketTs) ?? {
      ts: bucketTs,
      count: 0,
      errors: 0,
    };
    bucket.count += 1;
    if (errored) {
      bucket.errors += 1;
    }
    buckets.set(bucketTs, bucket);

    const name = e.tool ?? e.method ?? "unknown";
    const stat = tools.get(name) ?? { count: 0, errors: 0, latencies: [] };
    stat.count += 1;
    if (errored) {
      stat.errors += 1;
    }
    if (typeof e.ms === "number" && Number.isFinite(e.ms)) {
      stat.latencies.push(e.ms);
    }
    tools.set(name, stat);
  }

  allLatencies.sort((a, b) => a - b);
  const total = events.length;

  const topTools: ToolStat[] = [...tools.entries()]
    .map(([name, s]) => {
      const sorted = s.latencies.slice().sort((a, b) => a - b);
      return {
        name,
        count: s.count,
        errors: s.errors,
        errorRate: s.count === 0 ? 0 : s.errors / s.count,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, topLimit);

  const callsOverTime = [...buckets.values()].sort((a, b) => a.ts - b.ts);

  return {
    enabled: true,
    since: opts.since,
    total,
    errors,
    errorRate: total === 0 ? 0 : errors / total,
    p50: percentile(allLatencies, 0.5),
    p95: percentile(allLatencies, 0.95),
    bucketMs,
    callsOverTime,
    topTools,
  };
}

/** Empty 200 payload returned when there is no active storage. */
function disabledSummary(bucketMs: number): ObservabilityDisabled {
  return {
    enabled: false,
    total: 0,
    errors: 0,
    errorRate: 0,
    p50: 0,
    p95: 0,
    bucketMs,
    callsOverTime: [],
    topTools: [],
  };
}

/** Parse a non-negative integer query param, or `undefined` if absent/invalid. */
function intParam(raw: unknown): number | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function strParam(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

const DEFAULT_SUMMARY_WINDOW_MS = 60 * 60 * 1000; // 1h
const DEFAULT_LIMIT = 200;
const STREAM_POLL_MS = 1000;

/**
 * Build the observability read API router. All routes read storage
 * per-request via {@link getActiveStorage} (overridable for tests) so the
 * disabled / not-yet-installed path returns a 200 empty payload, never a 500.
 */
export function createObservabilityRouter(
  getStorage: () => StorageAdapter | null = getActiveStorage,
): Router {
  const router = express.Router();
  const base = "/__enpilink/observability";

  // GET /summary — aggregate from queryEvents (counts, error rate, p50/p95,
  // top tools, calls over time). Aggregation happens here, not in the adapter.
  router.get(`${base}/summary`, async (req, res) => {
    const bucketMs = intParam(req.query.bucketMs) || 60_000;
    const storage = getStorage();
    if (!storage) {
      res.json(disabledSummary(bucketMs));
      return;
    }
    const sinceParam = intParam(req.query.since);
    const since =
      sinceParam !== undefined
        ? sinceParam
        : Date.now() - DEFAULT_SUMMARY_WINDOW_MS;
    try {
      // limit:0 from memory means "no events"; pass a large cap so the summary
      // reflects the full window. queryEvents returns most-recent-first.
      const events = await storage.queryEvents({
        since,
        type: strParam(req.query.type),
        tool: strParam(req.query.tool),
        limit: intParam(req.query.limit) ?? 5000,
      });
      res.json(summarize(events, { since, bucketMs }));
    } catch {
      res.json(disabledSummary(bucketMs));
    }
  });

  // GET /events?since&type&tool&limit — pass-through to storage.queryEvents.
  router.get(`${base}/events`, async (req, res) => {
    const storage = getStorage();
    if (!storage) {
      res.json({ enabled: false, events: [] });
      return;
    }
    try {
      const events = await storage.queryEvents({
        since: intParam(req.query.since),
        type: strParam(req.query.type),
        tool: strParam(req.query.tool),
        limit: intParam(req.query.limit) ?? DEFAULT_LIMIT,
      });
      res.json({ enabled: true, events });
    } catch {
      res.json({ enabled: false, events: [] });
    }
  });

  // GET /logs?since&level&limit — pass-through to storage.queryLogs.
  router.get(`${base}/logs`, async (req, res) => {
    const storage = getStorage();
    if (!storage) {
      res.json({ enabled: false, logs: [] });
      return;
    }
    try {
      const logs = await storage.queryLogs({
        since: intParam(req.query.since),
        level: strParam(req.query.level),
        limit: intParam(req.query.limit) ?? DEFAULT_LIMIT,
      });
      res.json({ enabled: true, logs });
    } catch {
      res.json({ enabled: false, logs: [] });
    }
  });

  // GET /stream — poll-based SSE. Mirrors the tunnel SSE style: set the
  // event-stream headers, push frames, and clean up the interval on client
  // disconnect. We poll storage on an interval using a `since` cursor and push
  // only events/logs newer than the cursor. Resilient to storage being absent.
  router.get(`${base}/stream`, async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // Start the cursor at request time so we only stream NEW activity.
    let cursor = intParam(req.query.since) ?? Date.now();

    const send = (event: string, data: unknown): boolean =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // Immediately tell the client whether analytics is live.
    send("status", { enabled: getStorage() !== null });

    let stopped = false;
    const poll = async () => {
      if (stopped) {
        return;
      }
      const storage = getStorage();
      if (!storage) {
        // Heartbeat keeps the connection (and proxies) alive while OFF.
        send("status", { enabled: false });
        return;
      }
      try {
        const [events, logs] = await Promise.all([
          storage.queryEvents({ since: cursor, limit: 200 }),
          storage.queryLogs({ since: cursor, limit: 200 }),
        ]);
        // queryEvents/queryLogs are most-recent-first; advance the cursor past
        // the newest ts so the next poll doesn't re-send the same rows.
        const newest = Math.max(events[0]?.ts ?? 0, logs[0]?.ts ?? 0, cursor);
        // Use `> cursor` so the same-ms boundary isn't dropped on the first
        // pass but isn't re-sent afterward (cursor advances to newest + 1).
        if (events.length > 0) {
          send("events", events);
        }
        if (logs.length > 0) {
          send("logs", logs);
        }
        if (newest >= cursor) {
          cursor = newest + 1;
        }
      } catch {
        // Swallow — a transient storage error must not kill the stream.
      }
    };

    const timer = setInterval(() => void poll(), STREAM_POLL_MS);
    const cleanup = () => {
      stopped = true;
      clearInterval(timer);
      res.end();
    };
    req.on("close", cleanup);
  });

  return router;
}
