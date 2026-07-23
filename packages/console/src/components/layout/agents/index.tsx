import {
  ArrowUpRight,
  Bot,
  Fingerprint,
  Hash,
  LifeBuoy,
  RotateCcw,
  SearchX,
} from "lucide-react";
import { useMemo } from "react";
import {
  type AgentSummaryEnabled,
  type ClassOutcome,
  countUnrecognised,
  type FamilyOutcome,
  type SessionAggregate,
  useAgentSummary,
} from "@/lib/agents-store.js";
import { useDashboardRange } from "@/lib/nuqs.js";
import { RANGES, resolveRange } from "@/lib/observability-store.js";
import { useChartTheme } from "@/lib/use-chart-theme.js";
import { RangePicker } from "../dashboard/range-picker.js";
import { OutcomeClassBar } from "./charts.js";
import { RulesetCard } from "./ruleset-card.js";

const numberFmt = new Intl.NumberFormat("en-US");
/** Rates from the API are already in `[0, 1]`. */
const pctFmt = (rate: number) => `${Math.round(rate * 100)}%`;

type Tone = "default" | "rescue" | "danger" | "muted";

// Same restrained palette as the Dashboard: soft teal for neutral, coral for
// the failure metric, a distinct teal-green for the rescue (the money win).
const TONE_ICON: Record<Tone, string> = {
  default: "bg-[#3fb6a8]/10 text-[#2f9e91]",
  rescue: "bg-emerald-400/10 text-emerald-500",
  danger: "bg-[#ff746c]/10 text-[#ff746c]",
  muted: "bg-muted text-muted-foreground",
};

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
  testId,
}: {
  icon: typeof Hash;
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
  testId?: string;
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
            data-testid={testId}
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

/**
 * The headline sentence — the product's pitch in one line. The M4 read API
 * composes it so every clause names its source + coverage; we render it verbatim
 * and prominently rather than re-deriving it (single source of truth).
 */
function Headline({ text }: { text: string }) {
  return (
    <div
      className="rounded-md border border-[#3fb6a8]/25 bg-[#3fb6a8]/5 px-5 py-4 dark:border-[#5fc7ba]/20 dark:bg-[#5fc7ba]/5"
      data-testid="agents-headline"
    >
      <div className="flex items-start gap-3">
        <Bot className="mt-0.5 size-5 shrink-0 text-[#2f9e91] dark:text-[#5fc7ba]" />
        <p className="text-sm font-medium leading-relaxed text-foreground">
          {text}
        </p>
      </div>
    </div>
  );
}

/**
 * The money view: of all dead-ends (requests that would have 404'd), how many
 * did the routing layer RESCUE with a self-sufficient representation vs how many
 * we still lose. This contrast is the core value, so it gets a prominent card
 * with a proportion bar. NB (M3.5): a served row is a rescued dead-end by
 * construction — we NEVER present "served" as a success rate.
 */
function RescueContrast({ s }: { s: AgentSummaryEnabled }) {
  const deadEnds = s.outcomes.deadEnds;
  const rescued = s.rescuedDeadEnds;
  const unrescued = Math.max(0, deadEnds - rescued);
  const rescuedPct = deadEnds === 0 ? 0 : rescued / deadEnds;

  return (
    <Card title="Rescued vs. unrescued dead-ends" subtitle="the money view">
      <div className="px-2 pt-1">
        {deadEnds === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No dead-ends in this window — no request would have 404'd for a
            detected agent.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
              <div>
                <div
                  className="text-3xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
                  data-testid="agents-rescued"
                >
                  {numberFmt.format(rescued)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  rescued — we caught the dead-end and answered it
                </div>
              </div>
              <div>
                <div
                  className="text-3xl font-semibold tabular-nums text-[#ff746c]"
                  data-testid="agents-unrescued"
                >
                  {numberFmt.format(unrescued)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  still lost — a dead-end we did not rescue
                </div>
              </div>
              <div className="ml-auto text-right">
                <div className="text-sm font-medium tabular-nums text-foreground">
                  {pctFmt(rescuedPct)}
                </div>
                <div className="text-xs text-muted-foreground">
                  of {numberFmt.format(deadEnds)} dead-ends rescued
                </div>
              </div>
            </div>
            {/* Proportion bar: rescued (teal-green) vs unrescued (coral). */}
            <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-emerald-500/80"
                style={{ width: `${rescuedPct * 100}%` }}
                title={`${numberFmt.format(rescued)} rescued`}
              />
              <div
                className="h-full bg-[#ff746c]/80"
                style={{ width: `${(1 - rescuedPct) * 100}%` }}
                title={`${numberFmt.format(unrescued)} still lost`}
              />
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/** A dead-end-rate table shared by the by-family and by-class breakdowns. */
function BreakdownTable({
  title,
  keyLabel,
  rows,
  testId,
}: {
  title: string;
  keyLabel: string;
  rows: Array<{ key: string; unrecognised: boolean; stat: FamilyOutcome }>;
  testId: string;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-canvas-border bg-background shadow-sm">
      <h3 className="px-5 pt-4 pb-3 text-sm font-medium text-foreground">
        {title}
      </h3>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-sm" data-testid={testId}>
          <thead className="sticky top-0 bg-background">
            <tr className="border-y border-canvas-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-2 font-medium">{keyLabel}</th>
              <th className="px-4 py-2 text-right font-medium">Requests</th>
              <th className="px-4 py-2 text-right font-medium">Dead-ends</th>
              <th className="px-5 py-2 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-5 py-6 text-center text-xs text-muted-foreground"
                >
                  Nothing recorded yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.key}
                  className="border-b border-canvas-border last:border-0 hover:bg-canvas/60"
                >
                  <td className="px-5 py-2 font-mono text-xs text-foreground">
                    {r.key}
                    {r.unrecognised ? (
                      <span className="ml-2 rounded bg-[#3fb6a8]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase not-italic tracking-wide text-[#2f9e91] dark:text-[#5fc7ba]">
                        unrecognised
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {numberFmt.format(r.stat.total)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {numberFmt.format(r.stat.deadEnds)}
                  </td>
                  <td
                    className={`px-5 py-2 text-right tabular-nums ${r.stat.deadEndRate > 0 ? "text-[#ff746c]" : ""}`}
                  >
                    {pctFmt(r.stat.deadEndRate)}
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

function FamilyTable({ rows }: { rows: FamilyOutcome[] }) {
  return (
    <BreakdownTable
      title="Dead-end rate by family"
      keyLabel="Agent family"
      testId="agents-family-table"
      rows={rows.map((f) => ({
        key: f.family ?? "unnamed",
        // A null family is just an un-NAMED vendor (e.g. a `human-or-browser`
        // shape has no vendor) — NOT an unrecognised agent. The corpus-growth
        // "unrecognised" signal is an unknown/unset behavioural CLASS, so the
        // badge lives on the class table only; don't overclaim it here.
        unrecognised: false,
        stat: f,
      }))}
    />
  );
}

function ClassTable({ rows }: { rows: ClassOutcome[] }) {
  return (
    <BreakdownTable
      title="Dead-end rate by class"
      keyLabel="Behavioural class"
      testId="agents-class-table"
      rows={rows.map((c) => ({
        key: c.agentClass ?? "unclassified",
        unrecognised: c.agentClass === null || c.agentClass === "unknown",
        stat: {
          family: null,
          total: c.total,
          deadEnds: c.deadEnds,
          deadEndRate: c.deadEndRate,
        },
      }))}
    />
  );
}

/**
 * The correlation signals — recovery + escalation. These are LOWER-fidelity than
 * the outcome numbers: they come from a bounded, windowed sample of only the
 * correlatable classes, so each is rendered NEXT TO its coverage fraction and
 * flagged best-effort. A `human-or-browser` = human OR on-device agent (we do
 * not pretend to separate them); a chat-fetcher from a shared vendor IP is
 * unsessionable by construction. The panel is visually distinct from the
 * accurate metrics so no number is over-read.
 */
function CorrelationPanel({
  sessions,
  coverage,
}: {
  sessions: SessionAggregate;
  coverage: AgentSummaryEnabled["coverage"];
}) {
  return (
    <Card
      title="Recovery & escalation"
      subtitle="best-effort · sampled correlation"
    >
      <div className="space-y-4 px-2 pt-1">
        <p className="text-xs leading-relaxed text-muted-foreground">
          These signals correlate requests by hashed IP, which only works for
          user-scoped clients (a coding CLI, an on-device browser). Shared
          vendor-IP fetchers (ChatGPT-User, Gemini, crawlers) are{" "}
          <span className="font-medium text-foreground">unsessionable</span> —
          we report that honestly rather than invent a session. Each number
          carries the fraction of traffic it could actually see.
        </p>
        {coverage.correlationSampled ? (
          <div className="rounded-md border border-[#ff746c]/30 bg-[#ff746c]/5 px-3 py-2 text-xs text-[#ff746c]">
            Sampled: the correlation pull hit its row cap, so these counts are a
            lower bound.
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <SignalTile
            icon={RotateCcw}
            label="Recovered dead-ends"
            value={`${numberFmt.format(sessions.recovery.recovered)} / ${numberFmt.format(sessions.recovery.deadEnds)}`}
            note={`${pctFmt(coverage.recovery)} of dead-ends were correlatable`}
          />
          <SignalTile
            icon={ArrowUpRight}
            label="Escalated to a browser"
            value={numberFmt.format(sessions.escalations)}
            note="best-effort — undercounts cloud→residential"
          />
          <SignalTile
            icon={Bot}
            label="Sessions stitched"
            value={numberFmt.format(sessions.sessions)}
            note={`${numberFmt.format(sessions.sessionableRequests)} sessionable requests`}
          />
          <SignalTile
            icon={Fingerprint}
            label="Sessionable coverage"
            value={pctFmt(coverage.sessionable)}
            note={`${numberFmt.format(sessions.unsessionableRequests)} unsessionable`}
          />
        </div>
        {sessions.unsessionableByClass.length > 0 ? (
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Unsessionable by class
            </div>
            <div className="flex flex-wrap gap-1.5" data-testid="agents-unsess">
              {sessions.unsessionableByClass.map((u) => (
                <span
                  key={u.agentClass}
                  className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                >
                  {u.agentClass} · {numberFmt.format(u.count)}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function SignalTile({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof RotateCcw;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-md border border-canvas-border bg-canvas/50 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1.5 text-lg font-medium tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
        {note}
      </div>
    </div>
  );
}

/** Storage absent / capture off — the degraded `{enabled:false}` shape. */
function DisabledHint() {
  return (
    <div
      className="flex h-full items-center justify-center bg-canvas p-8"
      data-testid="agents-disabled-hint"
    >
      <div className="max-w-md space-y-3 rounded-md border border-canvas-border bg-background p-8 text-center shadow-sm">
        <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-[#3fb6a8]/10">
          <Bot className="size-6 text-[#2f9e91] dark:text-[#5fc7ba]" />
        </div>
        <h3 className="text-base font-semibold text-foreground">
          Agent analytics is off
        </h3>
        <p className="text-sm text-muted-foreground">
          The agent capture spine is disabled (or no storage is configured), so
          no agent requests are being recorded.
        </p>
        <div className="space-y-2 text-left text-sm">
          <p className="text-muted-foreground">To turn it on:</p>
          <p>
            <span className="text-muted-foreground">Capture requests — </span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              ENPILINK_AGENT=1
            </code>
          </p>
          <p>
            <span className="text-muted-foreground">
              Rescue agent dead-ends —{" "}
            </span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              ENPILINK_CFG_AGENT_SERVE=1
            </code>
          </p>
        </div>
      </div>
    </div>
  );
}

/** Capture is ON but no agent traffic yet — distinct from the disabled state. */
function EmptyOnHint() {
  return (
    <div
      className="flex h-full items-center justify-center bg-canvas p-8"
      data-testid="agents-empty-hint"
    >
      <div className="max-w-md space-y-3 rounded-md border border-canvas-border bg-background p-8 text-center shadow-sm">
        <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-[#3fb6a8]/10">
          <Bot className="size-6 text-[#2f9e91] dark:text-[#5fc7ba]" />
        </div>
        <h3 className="text-base font-semibold text-foreground">
          Waiting for the first agent request
        </h3>
        <p className="text-sm text-muted-foreground">
          Agent capture is on, but no agent-attributed requests have landed in
          this window yet. Point an agent (or a crawler) at the site — or widen
          the time range.
        </p>
      </div>
    </div>
  );
}

/**
 * The Agents tab (M5). Renders the M4 "did the agent SUCCEED?" telemetry:
 * the headline sentence, the rescued-vs-unrescued dead-end money view, the S3
 * outcome-class histogram, per-family / per-class dead-end tables, and a
 * distinctly lower-fidelity recovery/escalation panel that always shows its
 * coverage fraction. Does NOT require an MCP connection — it polls its own read
 * API. Falls back to a friendly disabled state when capture is off, and a
 * distinct empty state when capture is on but no agent traffic has landed.
 */
export const Agents = () => {
  const [range, setRange] = useDashboardRange();
  // Quantize `now` to a 30s step so the derived `since` (and the query key it
  // feeds) stays referentially stable across polling renders.
  const { since } = useMemo(() => {
    const now = Math.floor(Date.now() / 30_000) * 30_000;
    return resolveRange(range, now);
  }, [range]);

  const { data: summary, isLoading, isError } = useAgentSummary(since);
  const theme = useChartTheme();

  const s: AgentSummaryEnabled | undefined = summary?.enabled
    ? summary
    : undefined;

  return (
    <div
      className="h-full min-h-0 overflow-auto bg-canvas p-5"
      data-testid="agents"
    >
      <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
        {/* Page heading + time-range picker */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Agents
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Did the agent get what it came for? Dead-ends, rescues, and
              outcomes · {RANGES[range].label}.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {s ? (
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {numberFmt.format(s.outcomes.total)} requests
              </span>
            ) : null}
            <RangePicker
              value={range}
              onChange={(next) => void setRange(next)}
            />
          </div>
        </div>

        {/* Detection-ruleset freshness (D3) — renders itself only when the agent
            surface is on; independent of the traffic-summary state below. */}
        <RulesetCard />

        {isLoading && !summary ? (
          <div className="flex min-h-[60vh] items-center justify-center">
            <p className="text-sm text-muted-foreground">Loading metrics…</p>
          </div>
        ) : isError || !summary ? (
          <div className="flex min-h-[60vh] items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Could not load agent telemetry.
            </p>
          </div>
        ) : !summary.enabled || !s ? (
          <DisabledHint />
        ) : s.outcomes.total === 0 ? (
          <EmptyOnHint />
        ) : (
          <AgentsBody s={s} theme={theme} />
        )}
      </div>
    </div>
  );
};

/** The populated body, split out so the heading + picker stay mounted across
 * loading / disabled / empty states (so the range can always be changed). */
function AgentsBody({
  s,
  theme,
}: {
  s: AgentSummaryEnabled;
  theme: ReturnType<typeof useChartTheme>;
}) {
  const unrecognised = countUnrecognised(s.outcomes);
  return (
    <>
      <Headline text={s.headline} />

      {/* Counters — the ACCURATE, whole-window outcome numbers. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Hash}
          label="Agent requests"
          value={numberFmt.format(s.outcomes.total)}
          testId="agents-total"
        />
        <StatCard
          icon={SearchX}
          label="Dead-end rate"
          value={pctFmt(s.outcomes.deadEndRate)}
          hint={`${numberFmt.format(s.outcomes.deadEnds)} dead-ends`}
          tone="danger"
        />
        <StatCard
          icon={LifeBuoy}
          label="Rescued dead-ends"
          value={numberFmt.format(s.rescuedDeadEnds)}
          hint="answered a would-be 404"
          tone="rescue"
        />
        <StatCard
          icon={Fingerprint}
          label="Unrecognised"
          value={numberFmt.format(unrecognised)}
          hint="clients we can't yet name"
          tone="muted"
        />
      </div>

      {/* The money view. */}
      <RescueContrast s={s} />

      {/* Outcome breakdown (S3 class histogram). */}
      <Card title="Outcome breakdown" subtitle="requests by S3 class">
        <div className="h-64" data-testid="agents-outcome-chart">
          <OutcomeClassBar
            classHistogram={s.outcomes.classHistogram}
            theme={theme}
          />
        </div>
      </Card>

      {/* By-family + by-class dead-end tables. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="min-h-[16rem]">
          <FamilyTable rows={s.outcomes.byFamily} />
        </div>
        <div className="min-h-[16rem]">
          <ClassTable rows={s.outcomes.byClass} />
        </div>
      </div>

      {/* Lower-fidelity correlation signals, always shown with coverage. */}
      <CorrelationPanel sessions={s.sessions} coverage={s.coverage} />
    </>
  );
}

export default Agents;
