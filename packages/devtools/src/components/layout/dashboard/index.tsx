import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Hash,
  Timer,
  TrendingUp,
} from "lucide-react";
import {
  type Summary,
  type ToolStat,
  useConnectObservabilityStream,
  useObservabilitySummary,
} from "@/lib/observability-store.js";
import { useChartTheme } from "@/lib/use-chart-theme.js";
import {
  LatencyHistogram,
  MethodDonut,
  SlowestToolsBar,
  SuccessDonut,
  TopToolsBar,
  VolumeAreaChart,
} from "./charts.js";
import { LiveLogs } from "./live-logs.js";

const numberFmt = new Intl.NumberFormat("en-US");
const pctFmt = (n: number) => `${(n * 100).toFixed(1)}%`;
const msFmt = (n: number) => `${Math.round(n)} ms`;
const rateFmt = (n: number) =>
  n >= 100 ? `${Math.round(n)}/min` : `${n.toFixed(1)}/min`;

type Tone = "default" | "success" | "warning" | "danger";

// MD3: gentle, unified icon chips — soft violet accent for neutral cards,
// restrained muted pastels only where the metric carries success/error meaning
// (no bright orange/amber; warning reuses the calm violet family).
const TONE_ICON: Record<Tone, string> = {
  default: "bg-[#8b80e6]/10 text-[#7a6fd6]",
  success: "bg-emerald-400/10 text-emerald-500",
  warning: "bg-[#8b80e6]/10 text-[#7a6fd6]",
  danger: "bg-rose-400/10 text-rose-400",
};

/**
 * Clean light stat card (MD2): white card on a light-gray canvas, sharp
 * corners (~6px), a thin 1px border + soft shadow, a small uppercase muted
 * label, a big bold tabular number, and a subtle caption. The accent (purple)
 * is reserved for the icon chip — no per-card gradient rails.
 */
function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-md border border-canvas-border bg-background p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div
            className="mt-2 text-[1.625rem] font-medium leading-none tabular-nums text-foreground"
            data-testid={`stat-${label}`}
          >
            {value}
          </div>
          {hint ? (
            <div className="mt-1.5 text-xs text-muted-foreground">{hint}</div>
          ) : null}
        </div>
        <div className={`rounded-md p-2 ${TONE_ICON[tone]}`}>
          <Icon className="size-4" />
        </div>
      </div>
    </div>
  );
}

function Card({
  title,
  subtitle,
  className,
  bodyClassName,
  children,
}: {
  title: string;
  subtitle?: string;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex min-h-0 flex-col rounded-md border border-canvas-border bg-background shadow-sm ${className ?? ""}`}
    >
      <div className="flex items-baseline justify-between gap-2 px-5 pt-4 pb-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {subtitle ? (
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </div>
      <div className={`min-h-0 flex-1 px-3 pb-4 ${bodyClassName ?? ""}`}>
        {children}
      </div>
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-[12rem] items-center justify-center text-center text-xs text-muted-foreground">
      {message}
    </div>
  );
}

function ToolTable({ tools }: { tools: ToolStat[] }) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-canvas-border bg-background shadow-sm">
      <h3 className="px-5 pt-4 pb-3 text-sm font-medium text-foreground">
        Per-tool / per-method breakdown
      </h3>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-sm" data-testid="tool-table">
          <thead className="sticky top-0 bg-background">
            <tr className="border-y border-canvas-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-2 font-medium">Tool / method</th>
              <th className="px-4 py-2 text-right font-medium">Calls</th>
              <th className="px-4 py-2 text-right font-medium">Err %</th>
              <th className="px-4 py-2 text-right font-medium">p50</th>
              <th className="px-4 py-2 text-right font-medium">p95</th>
              <th className="px-5 py-2 text-right font-medium">p99</th>
            </tr>
          </thead>
          <tbody>
            {tools.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-6 text-center text-xs text-muted-foreground"
                >
                  No tool calls recorded yet.
                </td>
              </tr>
            ) : (
              tools.map((t) => (
                <tr
                  key={t.name}
                  className="border-b border-canvas-border last:border-0 hover:bg-canvas/60"
                  data-testid="tool-row"
                >
                  <td className="px-5 py-2 font-mono text-xs text-foreground">
                    {t.name}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {numberFmt.format(t.count)}
                  </td>
                  <td
                    className={`px-4 py-2 text-right tabular-nums ${t.errorRate > 0 ? "text-rose-600" : ""}`}
                  >
                    {pctFmt(t.errorRate)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {msFmt(t.p50)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {msFmt(t.p95)}
                  </td>
                  <td className="px-5 py-2 text-right tabular-nums">
                    {msFmt(t.p99)}
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
      className="flex h-full items-center justify-center bg-canvas p-8"
      data-testid="analytics-disabled-hint"
    >
      <div className="max-w-md space-y-3 rounded-md border border-canvas-border bg-background p-8 text-center shadow-sm">
        <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-primary/10">
          <Activity className="size-6 text-primary" />
        </div>
        <h3 className="text-base font-semibold text-foreground">
          No observability data yet
        </h3>
        <p className="text-sm text-muted-foreground">
          Analytics is off, so no tool-call events or logs are being recorded.
        </p>
        <div className="space-y-2 text-left text-sm">
          <p className="text-muted-foreground">To populate the dashboard:</p>
          <p>
            <span className="text-muted-foreground">
              Record real traffic —{" "}
            </span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              ENPILINK_ANALYTICS=1
            </code>
          </p>
          <p>
            <span className="text-muted-foreground">or seed a demo — </span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              enpilink dev --mock
            </code>
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The Dashboard tab (MD redesign). Polished, dark-mode-aware, on-brand
 * (enpitech purple #4A00E0 → #8E2DE2). Polls `/summary` (+ the SSE `/stream`
 * for live logs) and renders an expanded, ApexCharts-driven metrics set:
 * counters (total, throughput, error rate, p50/p95/p99, avg), a volume area
 * chart, success/error + method donuts, top + slowest tools bars, a latency
 * histogram, a per-tool table, and a live log feed. When analytics is OFF it
 * shows a friendly hint pointing at `ENPILINK_ANALYTICS=1` / `enpilink dev
 * --mock`.
 */
export const Dashboard = () => {
  useConnectObservabilityStream();
  const { data: summary, isLoading, isError } = useObservabilitySummary();
  const theme = useChartTheme();

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

  const s: Summary = summary;
  const successRate = s.total === 0 ? 1 : 1 - s.errorRate;

  return (
    <div
      className="h-full min-h-0 overflow-auto bg-canvas p-5"
      data-testid="dashboard"
    >
      <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
        {/* Page heading */}
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Observability
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Tool-call analytics, latency, and live logs.
            </p>
          </div>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {numberFmt.format(s.total)} calls · {rateFmt(s.throughputPerMin)}
          </span>
        </div>

        {/* Counters */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <StatCard
            icon={Hash}
            label="Total calls"
            value={numberFmt.format(s.total)}
          />
          <StatCard
            icon={TrendingUp}
            label="Throughput"
            value={rateFmt(s.throughputPerMin)}
          />
          <StatCard
            icon={CheckCircle2}
            label="Success rate"
            value={pctFmt(successRate)}
            tone="success"
          />
          <StatCard
            icon={AlertTriangle}
            label="Error rate"
            value={pctFmt(s.errorRate)}
            hint={`${numberFmt.format(s.errors)} errors`}
            tone={s.errorRate > 0.1 ? "danger" : "warning"}
          />
          <StatCard
            icon={Gauge}
            label="p50 latency"
            value={msFmt(s.p50)}
            hint={`avg ${msFmt(s.avg)}`}
          />
          <StatCard
            icon={Timer}
            label="p95 / p99"
            value={msFmt(s.p95)}
            hint={`p99 ${msFmt(s.p99)}`}
          />
        </div>

        {/* Volume + success donut */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card
            title="Tool-call volume over time"
            subtitle="calls vs errors"
            className="lg:col-span-2"
          >
            <div className="h-64" data-testid="volume-chart">
              {s.callsOverTime.length === 0 ? (
                <EmptyChart message="No calls in the selected window yet." />
              ) : (
                <VolumeAreaChart buckets={s.callsOverTime} theme={theme} />
              )}
            </div>
          </Card>
          <Card title="Success vs error">
            <div className="h-64">
              {s.total === 0 ? (
                <EmptyChart message="No calls yet." />
              ) : (
                <SuccessDonut total={s.total} errors={s.errors} theme={theme} />
              )}
            </div>
          </Card>
        </div>

        {/* Top tools + slowest tools + method donut */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card title="Top tools" subtitle="by call volume">
            <div className="h-64" data-testid="top-tools-chart">
              {s.topTools.length === 0 ? (
                <EmptyChart message="No tools yet." />
              ) : (
                <TopToolsBar tools={s.topTools.slice(0, 7)} theme={theme} />
              )}
            </div>
          </Card>
          <Card title="Slowest tools" subtitle="by p95 latency">
            <div className="h-64">
              {s.slowestTools.length === 0 ? (
                <EmptyChart message="No timed tools yet." />
              ) : (
                <SlowestToolsBar
                  tools={s.slowestTools.slice(0, 7)}
                  theme={theme}
                />
              )}
            </div>
          </Card>
          <Card title="Calls by method">
            <div className="h-64">
              {s.byMethod.length === 0 ? (
                <EmptyChart message="No methods yet." />
              ) : (
                <MethodDonut methods={s.byMethod} theme={theme} />
              )}
            </div>
          </Card>
        </div>

        {/* Latency histogram */}
        <Card title="Latency distribution" subtitle="calls per latency bucket">
          <div className="h-56" data-testid="latency-histogram">
            {s.latencyHistogram.every((b) => b.count === 0) ? (
              <EmptyChart message="No latency samples yet." />
            ) : (
              <LatencyHistogram buckets={s.latencyHistogram} theme={theme} />
            )}
          </div>
        </Card>

        {/* Table + live logs */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="min-h-[20rem]">
            <ToolTable tools={s.topTools} />
          </div>
          <div className="min-h-[20rem]">
            <LiveLogs />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
