import type { AnalyticsEvent } from "./storage/types.js";

/**
 * Optional OpenTelemetry export of the analytics event stream (M6).
 *
 * OFF by default. When OFF, this module constructs NOTHING, imports no
 * `@opentelemetry/*` package, opens no connection, and adds zero overhead — the
 * leak-lesson rule. Enabling requires BOTH:
 *
 * - `ENPILINK_OTEL` = `1`/`true`/`yes`/`on` (the explicit opt-in), AND
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) —
 *   the standard OTLP endpoint var. NO endpoint is ever hardcoded; if it is
 *   unset, OTel stays disabled.
 *
 * When enabled, each analytics event (a `tool_call`) is exported as OpenTelemetry
 * metrics to the configured OTLP/HTTP endpoint:
 * - `enpilink.tool_call.count` (counter, attrs: tool, method, ok)
 * - `enpilink.tool_call.errors` (counter, attrs: tool, method)
 * - `enpilink.tool_call.duration` (histogram, ms, attrs: tool, method, ok)
 *
 * The exporter is wired as an ADDITIONAL, guarded sink alongside
 * `storage.recordEvent` in analytics.ts; recording is fire-and-forget and never
 * blocks or breaks a tool call.
 */

/** Truthy values that enable OTel via {@link otelEnabled}. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Whether OTel export is enabled. OFF unless `ENPILINK_OTEL` is truthy AND a
 * standard OTLP endpoint var is set. No endpoint → disabled (never hardcoded).
 */
export function otelEnabled(): boolean {
  const raw = process.env.ENPILINK_OTEL;
  const flag = raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
  return flag && otelEndpoint() !== undefined;
}

/**
 * The configured OTLP endpoint (metrics-specific var preferred), or `undefined`
 * when none is set. Never returns a hardcoded default.
 */
export function otelEndpoint(): string | undefined {
  const url =
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

/** A single recording sink for analytics events. */
export interface OtelSink {
  /** Record one analytics event into the OTel metric instruments. */
  record(e: AnalyticsEvent): void;
  /** Flush + shut down the meter provider (closes the exporter cleanly). */
  shutdown(): Promise<void>;
}

/** Minimal structural shape of an OTel counter/histogram instrument. */
interface Instrument {
  add?(value: number, attrs?: Record<string, unknown>): void;
  record?(value: number, attrs?: Record<string, unknown>): void;
}

/**
 * Build the OTel sink. Injectable instrument factory lets tests verify the
 * recording logic deterministically without constructing a real meter provider
 * or exporter (so disabled-path tests prove nothing is imported/constructed).
 *
 * Attributes are kept low-cardinality: `tool`, `method`, `ok`.
 */
export function createOtelSink(instruments: {
  count: Instrument;
  errors: Instrument;
  duration: Instrument;
  shutdown: () => Promise<void>;
}): OtelSink {
  return {
    record(e: AnalyticsEvent): void {
      const attrs: Record<string, unknown> = {
        tool: e.tool ?? "(none)",
        method: e.method ?? "(unknown)",
        ok: e.ok !== false,
      };
      instruments.count.add?.(1, attrs);
      if (e.ok === false) {
        instruments.errors.add?.(1, { tool: attrs.tool, method: attrs.method });
      }
      if (typeof e.ms === "number") {
        instruments.duration.record?.(e.ms, attrs);
      }
    },
    shutdown: instruments.shutdown,
  };
}

/**
 * Initialize the OTel metrics export sink, ONLY when enabled. Lazily imports the
 * `@opentelemetry/*` packages so a disabled deployment never loads them.
 *
 * @returns an {@link OtelSink}, or `null` when disabled / on init failure (never
 *   throws into the caller).
 */
export async function initOtel(): Promise<OtelSink | null> {
  if (!otelEnabled()) {
    return null;
  }
  try {
    const [
      { metrics },
      { MeterProvider, PeriodicExportingMetricReader },
      { OTLPMetricExporter },
    ] = await Promise.all([
      import("@opentelemetry/api"),
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
    ]);

    // Endpoint comes from the env-resolved value; the exporter also honors the
    // standard OTEL_* vars, but we pass it explicitly to be unambiguous.
    const exporter = new OTLPMetricExporter({ url: otelEndpoint() });
    const reader = new PeriodicExportingMetricReader({ exporter });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);

    const meter = provider.getMeter("enpilink");
    const count = meter.createCounter("enpilink.tool_call.count", {
      description: "Number of MCP tool calls / requests recorded.",
    });
    const errors = meter.createCounter("enpilink.tool_call.errors", {
      description: "Number of failed MCP tool calls.",
    });
    const duration = meter.createHistogram("enpilink.tool_call.duration", {
      description: "MCP tool-call duration in milliseconds.",
      unit: "ms",
    });

    return createOtelSink({
      count,
      errors,
      duration,
      shutdown: () => provider.shutdown(),
    });
  } catch (err) {
    // OTel must never break startup; degrade to no-op.
    console.error(
      "[enpilink] OTel export disabled: init failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
