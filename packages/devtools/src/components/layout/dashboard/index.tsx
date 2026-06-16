import { Activity, AlertTriangle, Gauge, Hash } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type Summary,
  type ToolStat,
  useConnectObservabilityStream,
  useObservabilitySummary,
} from "@/lib/observability-store.js";
import { LiveLogs } from "./live-logs.js";

const numberFmt = new Intl.NumberFormat("en-US");
const pctFmt = (n: number) => `${(n * 100).toFixed(1)}%`;
const msFmt = (n: number) => `${Math.round(n)} ms`;

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-background p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div
        className="text-2xl font-semibold text-foreground"
        data-testid={`stat-${label}`}
      >
        {value}
      </div>
      {hint ? (
        <div className="text-xs text-quaternary-foreground">{hint}</div>
      ) : null}
    </div>
  );
}

function VolumeChart({ summary }: { summary: Summary }) {
  const data = summary.callsOverTime.map((b) => ({
    ts: b.ts,
    time: new Date(b.ts).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }),
    calls: b.count,
    errors: b.errors,
  }));

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">
        Tool-call volume over time
      </h3>
      {data.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted-foreground">
          No calls in the selected window yet.
        </p>
      ) : (
        <div className="h-56 w-full" data-testid="volume-chart">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="time" fontSize={11} stroke="currentColor" />
              <YAxis
                allowDecimals={false}
                fontSize={11}
                stroke="currentColor"
              />
              <Tooltip />
              <Area
                type="monotone"
                dataKey="calls"
                stroke="#7c3aed"
                fill="#7c3aed"
                fillOpacity={0.15}
                name="calls"
              />
              <Area
                type="monotone"
                dataKey="errors"
                stroke="#dc2626"
                fill="#dc2626"
                fillOpacity={0.15}
                name="errors"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function ToolTable({ tools }: { tools: ToolStat[] }) {
  return (
    <div className="rounded-lg border border-border bg-background">
      <h3 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
        Per-tool / per-method breakdown
      </h3>
      <div className="overflow-auto">
        <table className="w-full text-sm" data-testid="tool-table">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Tool / method</th>
              <th className="px-4 py-2 text-right font-medium">Calls</th>
              <th className="px-4 py-2 text-right font-medium">Errors</th>
              <th className="px-4 py-2 text-right font-medium">Error rate</th>
              <th className="px-4 py-2 text-right font-medium">p50</th>
              <th className="px-4 py-2 text-right font-medium">p95</th>
            </tr>
          </thead>
          <tbody>
            {tools.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-6 text-center text-xs text-muted-foreground"
                >
                  No tool calls recorded yet.
                </td>
              </tr>
            ) : (
              tools.map((t) => (
                <tr
                  key={t.name}
                  className="border-b border-border last:border-0"
                  data-testid="tool-row"
                >
                  <td className="px-4 py-2 font-mono text-xs text-foreground">
                    {t.name}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {numberFmt.format(t.count)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {numberFmt.format(t.errors)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {pctFmt(t.errorRate)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {msFmt(t.p50)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {msFmt(t.p95)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DisabledHint() {
  return (
    <div
      className="flex h-full items-center justify-center p-8"
      data-testid="analytics-disabled-hint"
    >
      <div className="max-w-md space-y-3 rounded-lg border border-dashed border-border bg-background p-8 text-center">
        <Activity className="mx-auto size-8 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          Analytics is off
        </h3>
        <p className="text-sm text-muted-foreground">
          No observability data is being collected. Restart the dev server with{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            ENPILINK_ANALYTICS=1
          </code>{" "}
          to record tool-call events and server logs.
        </p>
      </div>
    </div>
  );
}

/**
 * The Dashboard tab. Polls `/summary` (and the SSE `/stream` for live logs)
 * and renders volume, latency, error rate, a per-tool table, and a live log
 * stream. When the API reports analytics is OFF, shows a friendly hint instead
 * of erroring.
 */
export const Dashboard = () => {
  useConnectObservabilityStream();
  const { data: summary, isLoading, isError } = useObservabilitySummary();

  if (isLoading && !summary) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading metrics…</p>
      </div>
    );
  }

  if (isError || !summary) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Could not load observability data.
        </p>
      </div>
    );
  }

  if (!summary.enabled) {
    return <DisabledHint />;
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_auto_1fr] gap-4 overflow-auto p-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Hash}
          label="Total calls"
          value={numberFmt.format(summary.total)}
        />
        <StatCard
          icon={AlertTriangle}
          label="Error rate"
          value={pctFmt(summary.errorRate)}
          hint={`${numberFmt.format(summary.errors)} errors`}
        />
        <StatCard icon={Gauge} label="p50 latency" value={msFmt(summary.p50)} />
        <StatCard
          icon={Activity}
          label="p95 latency"
          value={msFmt(summary.p95)}
        />
      </div>

      <VolumeChart summary={summary} />

      <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <ToolTable tools={summary.topTools} />
        <div className="min-h-[16rem]">
          <LiveLogs />
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
