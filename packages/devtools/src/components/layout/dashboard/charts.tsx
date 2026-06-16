import type { ApexOptions } from "apexcharts";
import { useMemo } from "react";
import Chart from "react-apexcharts";
import type {
  LatencyBucket,
  MethodStat,
  Summary,
  ToolStat,
} from "@/lib/observability-store.js";
import type { ChartTheme } from "@/lib/use-chart-theme.js";

/**
 * ApexCharts-based charts for the Dashboard (MD3 — gentle/unified). ApexCharts
 * is pure-JS (MIT) and renders SVG; we feed it the soft, unified violet palette
 * resolved from {@link ChartTheme} so every series reads as tints/opacities of
 * ONE hue (plus neutral slate) — gentle thin strokes, low-opacity fills, very
 * light gridlines. Each chart is a thin, memoized wrapper.
 */

const msFmt = (n: number) => `${Math.round(n)} ms`;
const numberFmt = new Intl.NumberFormat("en-US");

/** Shared base options (fonts, toolbar off, theme-driven colors). */
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

/** Tool-call volume + errors over time (stacked area). */
export function VolumeAreaChart({
  buckets,
  theme,
}: {
  buckets: Summary["callsOverTime"];
  theme: ChartTheme;
}) {
  const { options, series } = useMemo(() => {
    const categories = buckets.map((b) => b.ts);
    const opts: ApexOptions = {
      ...baseOptions(theme),
      chart: { ...baseOptions(theme).chart, type: "area", stacked: false },
      // Unified: violet primary line + neutral slate for the errors series —
      // differentiated by tint, not a second hue.
      colors: [theme.brand, theme.neutral],
      stroke: { curve: "smooth", width: 2 },
      fill: {
        type: "gradient",
        // Gentle, low-opacity area fills (≈0.06–0.12).
        gradient: { shadeIntensity: 1, opacityFrom: 0.12, opacityTo: 0.02 },
      },
      xaxis: {
        type: "datetime",
        categories,
        labels: {
          datetimeUTC: false,
          style: { colors: theme.mutedText },
          format: "HH:mm",
        },
        axisBorder: { color: theme.grid },
        axisTicks: { color: theme.grid },
      },
      yaxis: {
        labels: {
          style: { colors: theme.mutedText },
          formatter: (v: number) => numberFmt.format(Math.round(v)),
        },
      },
    };
    return {
      options: opts,
      series: [
        { name: "Calls", data: buckets.map((b) => b.count) },
        { name: "Errors", data: buckets.map((b) => b.errors) },
      ],
    };
  }, [buckets, theme]);

  return <Chart options={options} series={series} type="area" height="100%" />;
}

/** Success vs error donut. */
export function SuccessDonut({
  total,
  errors,
  theme,
}: {
  total: number;
  errors: number;
  theme: ChartTheme;
}) {
  const ok = Math.max(0, total - errors);
  const { options, series } = useMemo(() => {
    const opts: ApexOptions = {
      ...baseOptions(theme),
      chart: { ...baseOptions(theme).chart, type: "donut" },
      colors: [theme.success, theme.error],
      labels: ["Success", "Errors"],
      legend: { position: "bottom", labels: { colors: theme.text } },
      stroke: { width: 0 },
      plotOptions: {
        pie: {
          donut: {
            size: "70%",
            labels: {
              show: true,
              total: {
                show: true,
                label: "Total",
                color: theme.mutedText,
                formatter: () => numberFmt.format(total),
              },
              value: { color: theme.text, fontWeight: 600 },
            },
          },
        },
      },
    };
    return { options: opts, series: [ok, errors] };
  }, [ok, errors, total, theme]);

  return <Chart options={options} series={series} type="donut" height="100%" />;
}

/** Top tools by call volume (horizontal bar). */
export function TopToolsBar({
  tools,
  theme,
}: {
  tools: ToolStat[];
  theme: ChartTheme;
}) {
  const { options, series } = useMemo(() => {
    const opts: ApexOptions = {
      ...baseOptions(theme),
      chart: { ...baseOptions(theme).chart, type: "bar" },
      colors: [theme.brand],
      plotOptions: {
        bar: { horizontal: true, borderRadius: 3, barHeight: "60%" },
      },
      xaxis: {
        categories: tools.map((t) => t.name),
        labels: { style: { colors: theme.mutedText } },
        axisBorder: { color: theme.grid },
        axisTicks: { color: theme.grid },
      },
      yaxis: { labels: { style: { colors: theme.text } } },
      tooltip: {
        theme: theme.mode,
        y: { formatter: (v: number) => `${numberFmt.format(v)} calls` },
      },
    };
    return {
      options: opts,
      series: [{ name: "Calls", data: tools.map((t) => t.count) }],
    };
  }, [tools, theme]);

  return <Chart options={options} series={series} type="bar" height="100%" />;
}

/** Slowest tools by p95 latency (horizontal bar). */
export function SlowestToolsBar({
  tools,
  theme,
}: {
  tools: ToolStat[];
  theme: ChartTheme;
}) {
  const { options, series } = useMemo(() => {
    const opts: ApexOptions = {
      ...baseOptions(theme),
      chart: { ...baseOptions(theme).chart, type: "bar" },
      // Was a bright orange — now a soft lavender tint of the one accent.
      colors: [theme.brandSoft],
      plotOptions: {
        bar: { horizontal: true, borderRadius: 3, barHeight: "60%" },
      },
      xaxis: {
        categories: tools.map((t) => t.name),
        labels: {
          style: { colors: theme.mutedText },
          formatter: (v: string) => msFmt(Number(v)),
        },
        axisBorder: { color: theme.grid },
        axisTicks: { color: theme.grid },
      },
      yaxis: { labels: { style: { colors: theme.text } } },
      tooltip: {
        theme: theme.mode,
        y: { formatter: (v: number) => msFmt(v) },
      },
    };
    return {
      options: opts,
      series: [{ name: "p95", data: tools.map((t) => Math.round(t.p95)) }],
    };
  }, [tools, theme]);

  return <Chart options={options} series={series} type="bar" height="100%" />;
}

/** Latency distribution histogram (vertical bar). */
export function LatencyHistogram({
  buckets,
  theme,
}: {
  buckets: LatencyBucket[];
  theme: ChartTheme;
}) {
  const { options, series } = useMemo(() => {
    const labels = buckets.map((b) =>
      b.to === null ? `${b.from}+ ms` : `${b.from}–${b.to}`,
    );
    const opts: ApexOptions = {
      ...baseOptions(theme),
      chart: { ...baseOptions(theme).chart, type: "bar" },
      // Lightest lavender tint — distinct from the other bars, same hue family.
      colors: [theme.brandFaint],
      plotOptions: {
        bar: { columnWidth: "70%", borderRadius: 3, distributed: false },
      },
      xaxis: {
        categories: labels,
        labels: { style: { colors: theme.mutedText }, rotate: -35 },
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
        y: { formatter: (v: number) => `${numberFmt.format(v)} calls` },
      },
    };
    return {
      options: opts,
      series: [{ name: "Calls", data: buckets.map((b) => b.count) }],
    };
  }, [buckets, theme]);

  return <Chart options={options} series={series} type="bar" height="100%" />;
}

/** Calls grouped by MCP method (donut). */
export function MethodDonut({
  methods,
  theme,
}: {
  methods: MethodStat[];
  theme: ChartTheme;
}) {
  const { options, series } = useMemo(() => {
    const opts: ApexOptions = {
      ...baseOptions(theme),
      chart: { ...baseOptions(theme).chart, type: "donut" },
      colors: theme.palette,
      labels: methods.map((m) => m.method),
      legend: { position: "bottom", labels: { colors: theme.text } },
      stroke: { width: 0 },
      plotOptions: { pie: { donut: { size: "62%" } } },
      tooltip: {
        theme: theme.mode,
        y: { formatter: (v: number) => `${numberFmt.format(v)} calls` },
      },
    };
    return { options: opts, series: methods.map((m) => m.count) };
  }, [methods, theme]);

  return <Chart options={options} series={series} type="donut" height="100%" />;
}
