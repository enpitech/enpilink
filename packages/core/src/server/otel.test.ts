import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOtelSink, initOtel, otelEnabled, otelEndpoint } from "./otel.js";

describe("otel gating", () => {
  const saved = {
    flag: process.env.ENPILINK_OTEL,
    ep: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    mep: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  };
  beforeEach(() => {
    delete process.env.ENPILINK_OTEL;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  });
  afterEach(() => {
    restore("ENPILINK_OTEL", saved.flag);
    restore("OTEL_EXPORTER_OTLP_ENDPOINT", saved.ep);
    restore("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", saved.mep);
  });

  it("is OFF by default (no env)", () => {
    expect(otelEnabled()).toBe(false);
    expect(otelEndpoint()).toBeUndefined();
  });

  it("stays OFF when the flag is set but NO endpoint is configured", () => {
    process.env.ENPILINK_OTEL = "1";
    // No hardcoded default endpoint — must remain disabled.
    expect(otelEndpoint()).toBeUndefined();
    expect(otelEnabled()).toBe(false);
  });

  it("stays OFF when an endpoint is set but the flag is not", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    expect(otelEnabled()).toBe(false);
  });

  it("is ON only when BOTH the flag and an endpoint are set", () => {
    process.env.ENPILINK_OTEL = "true";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    expect(otelEnabled()).toBe(true);
  });

  it("prefers the metrics-specific endpoint var", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://generic:4318";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://metrics:4318";
    expect(otelEndpoint()).toBe("http://metrics:4318");
  });

  it("initOtel returns null (no exporter constructed) when disabled", async () => {
    // Disabled → zero network, nothing imported/constructed.
    expect(await initOtel()).toBeNull();
  });
});

describe("createOtelSink recording", () => {
  function makeInstruments() {
    const count = { add: vi.fn() };
    const errors = { add: vi.fn() };
    const duration = { record: vi.fn() };
    const shutdown = vi.fn(async () => {});
    return { count, errors, duration, shutdown };
  }

  it("records count + duration with low-cardinality attrs on success", () => {
    const i = makeInstruments();
    const sink = createOtelSink(i);
    sink.record({
      ts: 1,
      type: "tool_call",
      tool: "echo",
      method: "tools/call",
      ms: 12,
      ok: true,
    });
    expect(i.count.add).toHaveBeenCalledWith(1, {
      tool: "echo",
      method: "tools/call",
      ok: true,
    });
    expect(i.duration.record).toHaveBeenCalledWith(12, {
      tool: "echo",
      method: "tools/call",
      ok: true,
    });
    expect(i.errors.add).not.toHaveBeenCalled();
  });

  it("also increments the error counter when ok === false", () => {
    const i = makeInstruments();
    const sink = createOtelSink(i);
    sink.record({
      ts: 1,
      type: "tool_call",
      tool: "boom",
      method: "tools/call",
      ms: 3,
      ok: false,
    });
    expect(i.count.add).toHaveBeenCalledTimes(1);
    expect(i.errors.add).toHaveBeenCalledWith(1, {
      tool: "boom",
      method: "tools/call",
    });
  });

  it("skips the duration histogram when ms is absent", () => {
    const i = makeInstruments();
    const sink = createOtelSink(i);
    sink.record({ ts: 1, type: "tool_call", method: "initialize", ok: true });
    expect(i.count.add).toHaveBeenCalledWith(1, {
      tool: "(none)",
      method: "initialize",
      ok: true,
    });
    expect(i.duration.record).not.toHaveBeenCalled();
  });

  it("shutdown delegates to the provider shutdown", async () => {
    const i = makeInstruments();
    const sink = createOtelSink(i);
    await sink.shutdown();
    expect(i.shutdown).toHaveBeenCalledTimes(1);
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
