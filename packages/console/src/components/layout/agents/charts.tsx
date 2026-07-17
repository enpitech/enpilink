import type { ApexOptions } from "apexcharts";
import { useMemo } from "react";
import Chart from "react-apexcharts";
import type { ClassHistogram } from "@/lib/agents-store.js";
import type { ChartTheme } from "@/lib/use-chart-theme.js";

/**
 * Agents-dashboard charts (M5). Mirrors `dashboard/charts.tsx`: thin, memoized
 * ApexCharts wrappers fed the resolved teal {@link ChartTheme}. Kept to ONE
 * chart on purpose — the S3 outcome-class histogram — because the rest of the
 * agent story (dead-end rate by family/class, recovery/escalation coverage) is
 * clearer as dense tables than as a wall of charts.
 *
 * Deliberate honesty in the colouring: `resolved` is NOT painted "success
 * green". A `resolved` 200 can still be the F-1 confabulation (the agent read
 * the page and invented a failure), so HTTP status is not task success
 * (outcomes.ts §). The only meaning-bearing colour is coral on the failure
 * classes (`dead_end`/`broken`); everything else is a neutral teal tint.
 */

const numberFmt = new Intl.NumberFormat("en-US");

/** The S3 classes in a stable display order. */
const CLASS_ORDER: Array<keyof ClassHistogram> = [
  "resolved",
  "dead_end",
  "blocked",
  "broken",
  "write_attempt",
];

/** Human labels for the S3 classes. */
const CLASS_LABEL: Record<keyof ClassHistogram, string> = {
  resolved: "Resolved",
  dead_end: "Dead-end",
  blocked: "Blocked",
  broken: "Broken",
  write_attempt: "Write attempt",
};

/** Shared base options (mirrors dashboard/charts.tsx baseOptions). */
function baseOptions(theme: ChartTheme): ApexOptions {
  return {
    chart: {
      fontFamily: "Ubuntu, system-ui, sans-serif",
      foreColor: theme.mutedText,
      toolbar: { show: false },
      zoom: { enabled: false },
      animations: { enabled: true, speed: 400 },
      background: "transparent",
    },
    grid: {
      borderColor: theme.grid,
      strokeDashArray: 4,
      padding: { left: 8, right: 8 },
      xaxis: { lines: { show: false } },
    },
    tooltip: { theme: theme.mode, style: { fontSize: "12px" } },
    legend: { labels: { colors: theme.text } },
    dataLabels: { enabled: false },
    states: { hover: { filter: { type: "lighten" } } },
  };
}

/**
 * S3 outcome-class histogram (vertical, distributed bar). The failure classes
 * (`dead_end`/`broken`) read coral; the rest are neutral teal tints — resolved
 * is intentionally NOT "success green" (see module note).
 */
export function OutcomeClassBar({
  classHistogram,
  theme,
}: {
  classHistogram: ClassHistogram;
  theme: ChartTheme;
}) {
  const { options, series } = useMemo(() => {
    const colorFor: Record<keyof ClassHistogram, string> = {
      resolved: theme.brand,
      dead_end: theme.error,
      blocked: theme.brandSoft,
      broken: theme.error,
      write_attempt: theme.brandFaint,
    };
    const opts: ApexOptions = {
      ...baseOptions(theme),
      chart: { ...baseOptions(theme).chart, type: "bar" },
      colors: CLASS_ORDER.map((k) => colorFor[k]),
      plotOptions: {
        bar: { columnWidth: "55%", borderRadius: 3, distributed: true },
      },
      legend: { show: false },
      xaxis: {
        categories: CLASS_ORDER.map((k) => CLASS_LABEL[k]),
        labels: { style: { colors: theme.mutedText } },
        axisBorder: { color: theme.grid },
        axisTicks: { color: theme.grid },
      },
      yaxis: {
        labels: {
          style: { colors: theme.mutedText },
          formatter: (v: number) => numberFmt.format(Math.round(v)),
        },
      },
      tooltip: {
        theme: theme.mode,
        y: { formatter: (v: number) => `${numberFmt.format(v)} requests` },
      },
    };
    return {
      options: opts,
      series: [
        { name: "Requests", data: CLASS_ORDER.map((k) => classHistogram[k]) },
      ],
    };
  }, [classHistogram, theme]);

  return <Chart options={options} series={series} type="bar" height="100%" />;
}
