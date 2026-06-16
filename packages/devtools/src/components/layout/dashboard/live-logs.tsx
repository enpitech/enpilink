import { Trash2 } from "lucide-react";
import {
  type LogEntry,
  useObservabilityStream,
} from "@/lib/observability-store.js";
import { cn } from "@/lib/utils.js";

const formatTimestamp = (ts: number) =>
  new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });

const LEVEL_STYLES: Record<LogEntry["level"], { badge: string; text: string }> =
  {
    debug: {
      badge: "bg-slate-100 text-slate-500",
      text: "text-muted-foreground",
    },
    info: { badge: "bg-sky-50 text-sky-700", text: "text-sky-700" },
    warning: { badge: "bg-amber-50 text-amber-700", text: "text-amber-700" },
    error: { badge: "bg-rose-50 text-rose-700", text: "text-rose-700" },
  };

/**
 * Live log stream for the Dashboard. Reuses the logs-drawer's row rendering
 * (timestamp + level badge + message) but is fed by the observability SSE
 * stream (`useObservabilityStream`) instead of the per-tool OpenAI logs.
 */
export const LiveLogs = () => {
  const logs = useObservabilityStream((s) => s.liveLogs);
  const clear = useObservabilityStream((s) => s.clear);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-canvas-border bg-background shadow-sm">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-canvas-border px-4">
        <h3 className="text-sm font-semibold text-foreground">Live logs</h3>
        <button
          type="button"
          aria-label="Clear live logs"
          onClick={clear}
          disabled={logs.length === 0}
          className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-canvas hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-canvas/60">
        {logs.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            Waiting for log activity… call a tool to see logs stream in.
          </p>
        ) : (
          logs.map((log) => {
            const styles = LEVEL_STYLES[log.level];
            return (
              <div
                key={log.id}
                data-testid="live-log-row"
                className="flex items-start gap-2 border-b border-canvas-border bg-background px-3 py-1.5 font-mono text-xs"
              >
                <span className="min-w-[80px] shrink-0 text-muted-foreground">
                  {formatTimestamp(log.ts)}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded px-1 text-[10px] font-medium uppercase tracking-wide",
                    styles.badge,
                  )}
                >
                  {log.level}
                </span>
                <span className={cn("min-w-0 break-words", styles.text)}>
                  {log.msg}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
