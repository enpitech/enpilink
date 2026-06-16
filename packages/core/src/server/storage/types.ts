/**
 * Storage layer types for enpilink's admin / observability / config plane.
 *
 * The {@link StorageAdapter} is the single pluggable persistence surface used by
 * analytics (events), log capture (logs), and the config/admin layer (config +
 * audit). Built-in adapters: `memory` (dev default, zero deps) and `sqlite`
 * (prod default, embedded). Custom adapters register via
 * `registerStorageAdapter`.
 */

/**
 * A single analytics event. Emitted (in M2) by the analytics middleware for
 * each MCP request — most commonly a `tool_call`. `type` is open-ended so other
 * event kinds can be recorded without a schema change.
 */
export interface AnalyticsEvent {
  /** Unix epoch milliseconds when the event occurred. */
  ts: number;
  /** Event kind. `"tool_call"` is the built-in, but any string is allowed. */
  type: "tool_call" | string;
  /** Tool name (for `tools/call`), from `params.name`. */
  tool?: string;
  /** MCP method, e.g. `"tools/call"`. */
  method?: string;
  /** Duration of the call in milliseconds. */
  ms?: number;
  /** Whether the call succeeded (false when the result was an error). */
  ok?: boolean;
  /** Error message, when the call failed. */
  error?: string;
  /** Arbitrary extra structured data. */
  meta?: Record<string, unknown>;
}

/** A captured server log line. */
export interface LogEntry {
  /** Unix epoch milliseconds. */
  ts: number;
  /** Log severity. */
  level: "debug" | "info" | "warning" | "error";
  /** The log message. */
  msg: string;
  /** Optional structured payload. */
  data?: unknown;
}

/** Filter for {@link StorageAdapter.queryEvents}. */
export interface EventQuery {
  /** Only events with `ts >= since` (epoch ms). */
  since?: number;
  /** Only events whose `type` matches. */
  type?: string;
  /** Only events whose `tool` matches. */
  tool?: string;
  /** Maximum number of events returned (most recent first). */
  limit?: number;
}

/** Filter for {@link StorageAdapter.queryLogs}. */
export interface LogQuery {
  /** Only logs with `ts >= since` (epoch ms). */
  since?: number;
  /** Only logs whose `level` matches. */
  level?: string;
  /** Maximum number of logs returned (most recent first). */
  limit?: number;
}

/**
 * Pluggable persistence interface backing the observability + config plane.
 *
 * Implementations MUST:
 * - treat config values as opaque (no special-casing of keys/secrets);
 * - write a `config_audit` entry on every {@link setConfig} call;
 * - return query results most-recent-first.
 */
export interface StorageAdapter {
  /** Open connections / create schema. Safe to call once before use. */
  init(): Promise<void>;
  /** Record an analytics event. Must never throw into the caller's hot path. */
  recordEvent(e: AnalyticsEvent): Promise<void>;
  /** Query events, most recent first. */
  queryEvents(f: EventQuery): Promise<AnalyticsEvent[]>;
  /** Append a captured log line. */
  appendLog(l: LogEntry): Promise<void>;
  /** Query logs, most recent first. */
  queryLogs(f: LogQuery): Promise<LogEntry[]>;
  /** Read a single config value (or `undefined` if unset). */
  getConfig(key: string): Promise<unknown>;
  /** Write a config value AND append a `config_audit` row (old → new). */
  setConfig(key: string, value: unknown, actor?: string): Promise<void>;
  /** Read all config as a plain object. */
  allConfig(): Promise<Record<string, unknown>>;
  /** Release resources / close connections. */
  close(): Promise<void>;
}

/** A single config-change audit record. */
export interface ConfigAuditEntry {
  /** Unix epoch milliseconds. */
  ts: number;
  /** Config key that changed. */
  key: string;
  /** Previous value (JSON-serializable), or `undefined` if newly set. */
  oldValue: unknown;
  /** New value (JSON-serializable). */
  newValue: unknown;
  /** Who made the change (defaults to `"system"`). */
  actor: string;
}

/** Options passed to a storage adapter factory. */
export interface StorageAdapterOptions {
  /** Ring-buffer capacity (memory) — max events/logs retained. */
  cap?: number;
  /** Database path (sqlite). */
  path?: string;
}

/** Factory signature for {@link registerStorageAdapter}. */
export type StorageAdapterFactory = (
  opts?: StorageAdapterOptions,
) => StorageAdapter;
