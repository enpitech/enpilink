import { Pause, Play, Search, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input.js";
import { useConfig } from "@/lib/config-store.js";
import {
  type HistoryLog,
  type LogEntry,
  type RangeKey,
  resolveRange,
  useConnectObservabilityStream,
  useObservabilityLogs,
  useObservabilityStream,
} from "@/lib/observability-store.js";
import { RangePicker } from "../dashboard/range-picker.js";

const LEVELS = ["debug", "info", "warning", "error"] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_STYLES: Record<LogEntry["level"], { badge: string; text: string }> =
  {
    debug: {
      badge:
        "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300",
      text: "text-muted-foreground",
    },
    info: {
      badge: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
      text: "text-sky-700 dark:text-sky-300",
    },
    warning: {
      badge: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
      text: "text-amber-700 dark:text-amber-300",
    },
    error: {
      badge: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
      text: "text-rose-700 dark:text-rose-300",
    },
  };

const formatTimestamp = (ts: number) =>
  new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });

/** A merged log row (history or live), most-recent-first. */
type Row = HistoryLog;

/** Stable de-dupe key for a log line (no server id). */
const rowKey = (l: { ts: number; level: string; msg: string }) =>
  `${l.ts}|${l.level}|${l.msg}`;

function LevelFilter({
  active,
  onToggle,
}: {
  active: Set<Level>;
  onToggle: (level: Level) => void;
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border border-canvas-border bg-background p-0.5 shadow-sm"
      data-testid="logs-level-filter"
    >
      {LEVELS.map((level) => {
        const on = active.has(level);
        return (
          <button
            key={level}
            type="button"
            aria-pressed={on}
            data-testid={`logs-level-${level}`}
            onClick={() => onToggle(level)}
            className={
              on
                ? "cursor-pointer rounded-[5px] bg-primary/12 px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-primary transition-colors"
                : "cursor-pointer rounded-[5px] px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-canvas hover:text-foreground"
            }
          >
            {level === "warning" ? "warn" : level}
          </button>
        );
      })}
    </div>
  );
}

function LogRow({ log }: { log: Row }) {
  const styles = LEVEL_STYLES[log.level];
  return (
    <div
      data-testid="log-row"
      className="flex items-start gap-2 border-b border-canvas-border bg-background px-4 py-1.5 font-mono text-xs"
    >
      <span className="min-w-[88px] shrink-0 text-muted-foreground">
        {formatTimestamp(log.ts)}
      </span>
      <span
        className={`shrink-0 rounded px-1 text-[10px] font-medium uppercase tracking-wide ${styles.badge}`}
      >
        {log.level === "warning" ? "warn" : log.level}
      </span>
      <span className={`min-w-0 break-words ${styles.text}`}>{log.msg}</span>
    </div>
  );
}

/**
 * Dedicated Logs page. Backfills persisted history via the observability
 * `GET /logs` endpoint (`useObservabilityLogs`), then tails new lines from the
 * SSE `/stream` (`useObservabilityStream`, the same store the Dashboard's live
 * widget uses — both share the ring so this never breaks the widget). Rows are
 * merged + de-duped and shown NEWEST-FIRST. Auto-tails (sticks to the top where
 * new logs arrive) but pauses when the user scrolls down to read history,
 * resuming when they scroll back to the top.
 *
 * Filters: a level toggle (debug/info/warn/error), a text search, and the
 * shared time-range picker (`RangePicker`) reusing the observability range
 * mechanism. Respects the `flags.liveLogs` config flag (shows a disabled state
 * when off) and shows a friendly hint when analytics/storage is off. On-brand:
 * clean/light, gentle 1px dividers, teal accents from the global tokens.
 */
export const Logs = () => {
  const [range, setRange] = useState<RangeKey>("24h");
  const [activeLevels, setActiveLevels] = useState<Set<Level>>(
    () => new Set(LEVELS),
  );
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { since } = useMemo(() => {
    const now = Math.floor(Date.now() / 30_000) * 30_000;
    return resolveRange(range, now);
  }, [range]);

  // History backfill + live tail (shared store/ring with the dashboard widget).
  const { data: history, isLoading } = useObservabilityLogs(since);
  useConnectObservabilityStream(since);
  const live = useObservabilityStream((s) => s.liveLogs);
  const streamEnabled = useObservabilityStream((s) => s.enabled);
  const clearLive = useObservabilityStream((s) => s.clear);

  // The `flags.liveLogs` feature flag (read from config; default on).
  const { data: settings } = useConfig();
  const liveLogsFlag =
    settings?.find((s) => s.key === "flags.liveLogs")?.value !== false;

  const storageEnabled = (history?.enabled ?? false) || streamEnabled;

  // Merge live (newest-first) over history (newest-first), de-duped, capped.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: Row[] = [];
    const push = (l: Row) => {
      const k = rowKey(l);
      if (seen.has(k)) {
        return;
      }
      seen.add(k);
      out.push(l);
    };
    for (const l of live) {
      push({ ...l, id: `live-${l.id}` });
    }
    for (const l of history?.logs ?? []) {
      push(l);
    }
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, 1000);
  }, [live, history]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((l) => {
      if (!activeLevels.has(l.level as Level)) {
        return false;
      }
      if (q && !l.msg.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [rows, activeLevels, search]);

  // Auto-tail: keep the scroll pinned to the top (newest-first) unless paused.
  // Pause automatically when the user scrolls away from the top.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    setPaused(el.scrollTop > 8);
  };

  const toggleLevel = (level: Level) => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas" data-testid="logs">
      {/* Header: heading + controls */}
      <div className="shrink-0 border-b border-canvas-border bg-background px-5 py-3">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Logs
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Captured server logs — history + live tail.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                size="sm"
                className="w-48 pl-8"
                placeholder="Search messages…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="logs-search"
              />
            </div>
            <LevelFilter active={activeLevels} onToggle={toggleLevel} />
            <RangePicker value={range} onChange={setRange} />
          </div>
        </div>
      </div>

      {/* Sub-bar: status + tail/clear controls */}
      <div className="shrink-0 border-b border-canvas-border bg-background/60 px-5 py-1.5">
        <div className="mx-auto flex max-w-[1100px] items-center justify-between gap-3 text-xs text-muted-foreground">
          <span data-testid="logs-count">
            {filtered.length} log{filtered.length === 1 ? "" : "s"}
            {paused ? (
              <span className="ml-2 text-primary">tail paused</span>
            ) : null}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                const el = scrollRef.current;
                if (el) {
                  el.scrollTop = 0;
                }
                setPaused(false);
              }}
              data-testid="logs-tail"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-canvas hover:text-foreground"
            >
              {paused ? (
                <Play className="size-3" />
              ) : (
                <Pause className="size-3" />
              )}
              {paused ? "Resume tail" : "Tailing"}
            </button>
            <button
              type="button"
              aria-label="Clear live buffer"
              onClick={clearLive}
              disabled={live.length === 0}
              data-testid="logs-clear"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-canvas hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="size-3" /> Clear
            </button>
          </div>
        </div>
      </div>

      {/* Scrollable log list */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="logs-scroll"
      >
        <div className="mx-auto max-w-[1100px]">
          {!liveLogsFlag ? (
            <EmptyState
              title="Live logs are turned off"
              body="Enable the “Live log stream” feature flag in Configuration to view logs here."
            />
          ) : !storageEnabled && !isLoading ? (
            <EmptyState
              title="Analytics is off"
              body="Start the server with ENPILINK_ANALYTICS=1 (or enable analytics in Configuration) to capture logs."
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={
                rows.length === 0 ? "No logs yet" : "No logs match your filters"
              }
              body={
                rows.length === 0
                  ? "Call a tool to see logs stream in."
                  : "Adjust the level filter, search, or time range."
              }
            />
          ) : (
            filtered.map((log) => <LogRow key={log.id} log={log} />)
          )}
        </div>
      </div>
    </div>
  );
};

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-5 py-16 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

export default Logs;
