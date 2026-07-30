import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Fingerprint,
  Minus,
  ScanSearch,
  ShieldCheck,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import {
  type AgentOutcome,
  type AgentRequestRow,
  type ConfidenceTier,
  confidenceTierMeta,
  describeServed,
  REQUESTS_PAGE_SIZE,
  type RouteAggregate,
  rescueSummary,
  type ServedTone,
  topNamedFamily,
  useAgentRequests,
  useAgentRoutes,
} from "@/lib/agents-routes-store.js";
import { DisabledHint, EmptyOnHint } from "./index.js";

const numberFmt = new Intl.NumberFormat("en-US");
const pctFmt = (rate: number) => `${Math.round(rate * 100)}%`;
const timeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** The read outcomes in display order, plus their labels + failure flag. */
const OUTCOMES: Array<{ value: AgentOutcome; label: string; bad: boolean }> = [
  { value: "resolved", label: "Resolved", bad: false },
  { value: "dead_end", label: "Dead-end", bad: true },
  { value: "blocked", label: "Blocked", bad: true },
  { value: "broken", label: "Broken", bad: true },
];

/** A small fixed set of statuses worth filtering the drill-down by (exact match). */
const STATUS_OPTIONS = [200, 403, 404, 410, 500];

// --- Confidence tier badge (the honesty centrepiece) ---

const TIER_STYLE: Record<
  ConfidenceTier,
  { cls: string; icon: typeof ShieldCheck; title: string }
> = {
  // A verified hit reads SOLID — filled emerald, shield.
  verified: {
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    icon: ShieldCheck,
    title: "Verified by reverse-DNS / confirmed IP — high confidence.",
  },
  // A behavioural shape match — teal, medium confidence.
  shape: {
    cls: "border-[#3fb6a8]/25 bg-[#3fb6a8]/10 text-[#2f9e91] dark:text-[#5fc7ba]",
    icon: Fingerprint,
    title: "Matched a behavioural request shape (no verified vendor).",
  },
  // A UA-string-only guess reads deliberately TENTATIVE — dashed amber outline.
  heuristic: {
    cls: "border-dashed border-amber-500/50 bg-amber-500/5 text-amber-600 dark:text-amber-400",
    icon: ScanSearch,
    title: "Guessed from the User-Agent string only — unverified, spoofable.",
  },
  pending: {
    cls: "border-transparent bg-muted text-muted-foreground",
    icon: Clock,
    title:
      "No ruleset loaded when captured — the label backfills once one lands.",
  },
  none: {
    cls: "border-canvas-border bg-transparent text-muted-foreground",
    icon: Minus,
    title: "No confidence signal.",
  },
  other: {
    cls: "border-canvas-border bg-muted text-muted-foreground",
    icon: Fingerprint,
    title: "A confidence tier this console build does not yet recognise.",
  },
};

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const { tier, label } = confidenceTierMeta(confidence);
  const style = TIER_STYLE[tier];
  const Icon = style.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${style.cls}`}
      title={style.title}
      data-testid="conf-badge"
      data-tier={tier}
    >
      <Icon className="size-2.5" />
      {label}
    </span>
  );
}

// --- What-was-served badge ---

const SERVED_TONE: Record<ServedTone, string> = {
  rescue: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  neutral: "bg-muted text-muted-foreground",
  danger: "bg-[#ff746c]/10 text-[#ff746c]",
};

function ServedBadge({ row }: { row: AgentRequestRow }) {
  const d = describeServed(row);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] ${SERVED_TONE[d.tone]}`}
      data-testid="served-badge"
      data-kind={d.kind}
    >
      {d.label}
      {d.detail ? <span className="opacity-70">· {d.detail}</span> : null}
    </span>
  );
}

// --- Filter bar ---

/** A native-select styled to match the compact teal chrome (small, dependency-light). */
function FilterSelect({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  testId: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className="h-7 rounded-md border border-canvas-border bg-background px-2 text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// --- Routes table ---

function RoutesTable({
  routes,
  selectedPath,
  onSelect,
}: {
  routes: RouteAggregate[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-canvas-border bg-background shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="agents-routes-table">
          <thead className="bg-background">
            <tr className="border-b border-canvas-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-2 font-medium">Endpoint</th>
              <th className="px-4 py-2 text-right font-medium">Requests</th>
              <th className="px-4 py-2 text-right font-medium">
                Dead-end rate
              </th>
              <th className="px-4 py-2 font-medium">Responded</th>
              <th className="px-5 py-2 font-medium">Top agent</th>
            </tr>
          </thead>
          <tbody>
            {routes.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-5 py-8 text-center text-xs text-muted-foreground"
                >
                  No routes match these filters.
                </td>
              </tr>
            ) : (
              routes.map((r) => {
                const sel = r.path === selectedPath;
                const rescue = rescueSummary(r);
                const fam = topNamedFamily(r);
                return (
                  <tr
                    key={r.path}
                    onClick={() => onSelect(r.path)}
                    className={`cursor-pointer border-b border-canvas-border last:border-0 ${
                      sel ? "bg-[#3fb6a8]/8" : "hover:bg-canvas/60"
                    }`}
                    data-testid="route-row"
                    data-selected={sel ? "true" : undefined}
                  >
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <ChevronRight
                          className={`size-3.5 shrink-0 transition-transform ${
                            sel
                              ? "rotate-90 text-[#2f9e91] dark:text-[#5fc7ba]"
                              : "text-muted-foreground"
                          }`}
                        />
                        <span className="truncate font-mono text-xs text-foreground">
                          {r.path}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {numberFmt.format(r.requests)}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right tabular-nums ${
                        r.deadEndRate > 0
                          ? "text-[#ff746c]"
                          : "text-muted-foreground"
                      }`}
                    >
                      {pctFmt(r.deadEndRate)}
                      <span className="ml-1 text-[11px] text-muted-foreground">
                        ({numberFmt.format(r.errorCount)})
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {rescue.deadEnds === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          no dead-ends
                        </span>
                      ) : (
                        <RescueMeter rescue={rescue} />
                      )}
                    </td>
                    <td className="px-5 py-2.5">
                      {fam ? (
                        <span className="font-mono text-xs text-foreground">
                          {fam}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          unnamed
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** "N of M rescued" + a slim rescued(teal) / still-lost(coral) proportion bar. */
function RescueMeter({ rescue }: { rescue: ReturnType<typeof rescueSummary> }) {
  return (
    <div className="min-w-[8rem]">
      <div className="text-xs text-foreground">
        <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
          {numberFmt.format(rescue.rescued)}
        </span>
        <span className="text-muted-foreground">
          {" "}
          of {numberFmt.format(rescue.deadEnds)} rescued
        </span>
      </div>
      <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-emerald-500/80"
          style={{ width: `${rescue.rescuedRate * 100}%` }}
        />
        <div
          className="h-full bg-[#ff746c]/70"
          style={{ width: `${(1 - rescue.rescuedRate) * 100}%` }}
        />
      </div>
    </div>
  );
}

// --- Request drill-down ---

function DrillDown({
  since,
  selectedPath,
  onClearPath,
  agentFamily,
  status,
}: {
  since: number;
  selectedPath: string | null;
  onClearPath: () => void;
  agentFamily: string | undefined;
  status: number | undefined;
}) {
  const [outcome, setOutcome] = useState<AgentOutcome | undefined>();
  const [offset, setOffset] = useState(0);

  // Any filter change should restart pagination. `key` includes every input so
  // this stays a derived reset without an effect.
  const filterKey = `${selectedPath ?? ""}|${agentFamily ?? ""}|${status ?? ""}|${outcome ?? ""}`;
  const [prevKey, setPrevKey] = useState(filterKey);
  if (prevKey !== filterKey) {
    setPrevKey(filterKey);
    setOffset(0);
  }

  const { data, isLoading, isError } = useAgentRequests({
    since,
    path: selectedPath ?? undefined,
    agentFamily,
    status,
    outcome,
    offset,
    limit: REQUESTS_PAGE_SIZE,
  });

  const rows = data?.enabled ? data.requests : [];
  const hasMore = data?.enabled ? data.hasMore : false;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-canvas-border bg-background shadow-sm">
      {/* Header + active-filter chips + outcome chips */}
      <div className="flex flex-wrap items-center gap-2 border-b border-canvas-border px-5 py-3">
        <h3 className="text-sm font-medium text-foreground">Requests</h3>
        {selectedPath ? (
          <button
            type="button"
            onClick={onClearPath}
            className="inline-flex items-center gap-1 rounded bg-[#3fb6a8]/10 px-1.5 py-0.5 font-mono text-[11px] text-[#2f9e91] hover:bg-[#3fb6a8]/20 dark:text-[#5fc7ba]"
            data-testid="drill-path-chip"
            title="Clear route filter"
          >
            {selectedPath}
            <X className="size-2.5" />
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">all routes</span>
        )}
        {agentFamily ? (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            family: {agentFamily}
          </span>
        ) : null}
        {status !== undefined ? (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            status: {status}
          </span>
        ) : null}

        {/* Outcome filter chips (maps 1:1 to the server `outcome` param). */}
        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-canvas-border bg-background p-0.5">
          <OutcomeChip
            active={outcome === undefined}
            onClick={() => setOutcome(undefined)}
            bad={false}
          >
            All
          </OutcomeChip>
          {OUTCOMES.map((o) => (
            <OutcomeChip
              key={o.value}
              active={outcome === o.value}
              onClick={() => setOutcome(o.value)}
              bad={o.bad}
            >
              {o.label}
            </OutcomeChip>
          ))}
        </div>
      </div>

      {/* Body */}
      {isLoading && !data ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          Loading requests…
        </p>
      ) : isError || !data ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          Could not load the request list.
        </p>
      ) : !data.enabled ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          Agent capture is off.
        </p>
      ) : rows.length === 0 ? (
        <p
          className="px-5 py-8 text-center text-sm text-muted-foreground"
          data-testid="drill-empty"
        >
          No requests match these filters in this window.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="agents-requests-table">
            <thead className="bg-background">
              <tr className="border-b border-canvas-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2 font-medium">Time</th>
                <th className="px-4 py-2 font-medium">Path</th>
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 text-right font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Outcome</th>
                <th className="px-5 py-2 font-medium">Served</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <RequestRow key={row.id ?? `${row.ts}-${i}`} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {data?.enabled && (rows.length > 0 || offset > 0) ? (
        <div className="flex items-center justify-between gap-2 border-t border-canvas-border px-5 py-2.5 text-xs text-muted-foreground">
          <span className="tabular-nums" data-testid="drill-range">
            {rows.length === 0
              ? "—"
              : `${numberFmt.format(offset + 1)}–${numberFmt.format(offset + rows.length)}`}
          </span>
          <div className="flex items-center gap-1">
            <PagerButton
              disabled={offset === 0}
              onClick={() =>
                setOffset((o) => Math.max(0, o - REQUESTS_PAGE_SIZE))
              }
              testId="drill-prev"
            >
              <ChevronLeft className="size-3.5" /> Prev
            </PagerButton>
            <PagerButton
              disabled={!hasMore}
              onClick={() => setOffset((o) => o + REQUESTS_PAGE_SIZE)}
              testId="drill-next"
            >
              Next <ChevronRight className="size-3.5" />
            </PagerButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RequestRow({ row }: { row: AgentRequestRow }) {
  const badStatus = row.status >= 400;
  return (
    <tr
      className="border-b border-canvas-border last:border-0 hover:bg-canvas/60"
      data-testid="request-row"
    >
      <td className="whitespace-nowrap px-5 py-2 text-xs tabular-nums text-muted-foreground">
        {timeFmt.format(new Date(row.ts))}
      </td>
      <td className="px-4 py-2">
        <span
          className="block max-w-[16rem] truncate font-mono text-xs text-foreground"
          title={`${row.method} ${row.path}`}
        >
          {row.path}
        </span>
      </td>
      <td className="px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-foreground">
            {row.agentFamily ?? "unnamed"}
          </span>
          {row.agentClass ? (
            <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
              {row.agentClass}
            </span>
          ) : null}
          <ConfidenceBadge confidence={row.confidence} />
        </div>
      </td>
      <td
        className={`px-4 py-2 text-right font-mono text-xs tabular-nums ${
          badStatus ? "text-[#ff746c]" : "text-foreground"
        }`}
      >
        {row.status}
      </td>
      <td className="px-4 py-2">
        <OutcomeLabel outcome={row.outcome} />
      </td>
      <td className="px-5 py-2">
        <ServedBadge row={row} />
      </td>
    </tr>
  );
}

function OutcomeChip({
  active,
  bad,
  onClick,
  children,
}: {
  active: boolean;
  bad: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? `cursor-pointer rounded-[5px] px-2 py-0.5 text-xs font-medium ${
              bad
                ? "bg-[#ff746c]/12 text-[#ff746c]"
                : "bg-[#3fb6a8]/12 text-[#2f9e91] dark:text-[#5fc7ba]"
            }`
          : "cursor-pointer rounded-[5px] px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-canvas hover:text-foreground"
      }
    >
      {children}
    </button>
  );
}

const OUTCOME_LABEL: Record<AgentOutcome, { label: string; bad: boolean }> = {
  resolved: { label: "resolved", bad: false },
  dead_end: { label: "dead-end", bad: true },
  blocked: { label: "blocked", bad: true },
  broken: { label: "broken", bad: true },
};

function OutcomeLabel({ outcome }: { outcome: AgentOutcome }) {
  const o = OUTCOME_LABEL[outcome];
  return (
    <span
      className={`text-xs ${o.bad ? "text-[#ff746c]" : "text-muted-foreground"}`}
    >
      {o.label}
    </span>
  );
}

function PagerButton({
  disabled,
  onClick,
  testId,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="inline-flex items-center gap-0.5 rounded-md border border-canvas-border bg-background px-2 py-1 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-canvas disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

// --- The Routes sub-view ---

/**
 * The Routes sub-view (A2): a per-endpoint breakdown over the shared time window,
 * plus a filtered request drill-down. Consumes A1's `/routes` + `/requests`
 * endpoints (never needs an MCP connection). `errorsOnly` and `family` scope the
 * routes table; `family` + `status` (+ the drill-down's own outcome chips + the
 * clicked route's `path`) scope the request list. Degrades to the same
 * disabled/empty hints as the Overview when capture is off or the window is empty.
 */
export function AgentsRoutes({ since }: { since: number }) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [family, setFamily] = useState<string>("");
  const [statusStr, setStatusStr] = useState<string>("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const { data, isLoading, isError } = useAgentRoutes({ since, errorsOnly });

  const allRoutes = data?.enabled ? data.routes : [];

  // Family options: the union of named top-families across the fetched routes.
  const familyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRoutes) {
      for (const f of r.topFamilies) {
        if (f.family) {
          set.add(f.family);
        }
      }
    }
    return [...set].sort();
  }, [allRoutes]);

  // Client-side family narrowing of the routes table (routes where the family is
  // a top agent). The drill-down applies `family` server-side instead.
  const routes = useMemo(() => {
    if (!family) {
      return allRoutes;
    }
    return allRoutes.filter((r) =>
      r.topFamilies.some((f) => f.family === family),
    );
  }, [allRoutes, family]);

  const status = statusStr ? Number.parseInt(statusStr, 10) : undefined;

  // Loading / error / disabled / empty — mirror the Overview's state ladder.
  if (isLoading && !data) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Loading routes…
      </p>
    );
  }
  if (isError || !data) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Could not load agent routes.
      </p>
    );
  }
  if (!data.enabled) {
    return <DisabledHint />;
  }
  if (allRoutes.length === 0 && !errorsOnly) {
    return <EmptyOnHint />;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="agents-routes">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-canvas-border bg-background px-4 py-2.5 shadow-sm">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={errorsOnly}
            onCheckedChange={setErrorsOnly}
            data-testid="routes-errors-only"
            aria-label="Errors only"
          />
          Errors only
        </span>
        <FilterSelect
          label="Family"
          value={family}
          onChange={setFamily}
          testId="routes-family"
          options={[
            { value: "", label: "All families" },
            ...familyOptions.map((f) => ({ value: f, label: f })),
          ]}
        />
        <FilterSelect
          label="Status"
          value={statusStr}
          onChange={setStatusStr}
          testId="routes-status"
          options={[
            { value: "", label: "Any" },
            ...STATUS_OPTIONS.map((s) => ({
              value: String(s),
              label: String(s),
            })),
          ]}
        />
        <span className="ml-auto text-xs text-muted-foreground">
          {numberFmt.format(routes.length)}{" "}
          {routes.length === 1 ? "route" : "routes"}
        </span>
      </div>

      <RoutesTable
        routes={routes}
        selectedPath={selectedPath}
        onSelect={(p) => setSelectedPath((cur) => (cur === p ? null : p))}
      />

      <DrillDown
        since={since}
        selectedPath={selectedPath}
        onClearPath={() => setSelectedPath(null)}
        agentFamily={family || undefined}
        status={status}
      />
    </div>
  );
}

export default AgentsRoutes;
