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
  /**
   * Remove a config override (reset to default) AND append a `config_audit`
   * row (old → undefined). A no-op when the key was not set. After clearing,
   * config resolution falls back to file/env/default for the key.
   */
  clearConfig(key: string, actor?: string): Promise<void>;
  /** Read all config as a plain object. */
  allConfig(): Promise<Record<string, unknown>>;
  /**
   * Read the config-change audit trail, most recent first. Surfaces the
   * `config_audit` rows that {@link setConfig} writes, for the admin UI's
   * change history.
   */
  getConfigAudit(): Promise<ConfigAuditEntry[]>;

  // --- End-user auth tracking (A2). Optional so custom adapters predating A2
  // keep working; the auth path feature-detects and swallows when absent. ---

  /**
   * Insert-or-update a tracked user by `sub`. On first sight sets
   * `createdAt`; always bumps `lastSeenAt`. Implementations MUST treat the
   * write as best-effort (the auth path swallows failures, like analytics).
   */
  upsertUser?(user: AuthUser): Promise<void>;
  /**
   * Record (or refresh) an auth session. Keyed by {@link AuthSession.id}; a
   * repeat for the same id bumps `lastSeenAt` rather than duplicating.
   */
  recordSession?(session: AuthSession): Promise<void>;
  /** Read a single session by id (or `undefined`). */
  getSession?(id: string): Promise<AuthSession | undefined>;
  /** List sessions, most recent first. */
  listSessions?(q?: SessionQuery): Promise<AuthSession[]>;
  /** List tracked users, most recently seen first. */
  listUsers?(q?: SessionQuery): Promise<AuthUser[]>;

  /** Release resources / close connections. */
  close(): Promise<void>;
}

/**
 * A tracked end-user, keyed by the stable OAuth `sub` claim (A2).
 *
 * Recorded the first time a valid token for a `sub` is seen, and refreshed on
 * every subsequent authenticated request. Holds NO secrets — never the raw
 * upstream access/refresh token (see {@link AuthSession.tokenRef}).
 */
export interface AuthUser {
  /** Stable per-user id — the OAuth `sub` claim. The primary tracking key. */
  sub: string;
  /** The Authorization Server / upstream issuer that vouched for this user. */
  issuer?: string;
  /** First time we saw this user (epoch ms). */
  createdAt: number;
  /** Most recent time we saw this user (epoch ms). */
  lastSeenAt: number;
  /** Optional display fields lifted from non-secret token claims. */
  email?: string;
  name?: string;
}

/**
 * A recorded authentication session for a user (A2).
 *
 * Written at successful auth (and refreshed on re-auth). Tokens-at-rest model:
 * we store an **opaque reference** ({@link tokenRef}, a one-way hash) to the
 * upstream token — NEVER the raw token, access secret, or refresh token. This
 * lets us correlate/track sessions without holding a credential at rest.
 */
export interface AuthSession {
  /** Session id (stable hash of the token reference). */
  id: string;
  /** The user this session belongs to (the `sub`). */
  sub: string;
  /** The issuer that minted the token. */
  issuer?: string;
  /** OAuth client id (the host/connector that brokered the flow). */
  clientId?: string;
  /**
   * An opaque, one-way reference to the upstream token (a SHA-256 hash) — used
   * only to de-duplicate/correlate sessions. NEVER the raw token. May be
   * absent when no token reference is available.
   */
  tokenRef?: string;
  /** Granted scopes (space-joined for storage). */
  scopes?: string[];
  /** When the session was first recorded (epoch ms). */
  createdAt: number;
  /** When the session was last refreshed (epoch ms). */
  lastSeenAt: number;
  /** Upstream token expiry (epoch seconds), when known. */
  expiresAt?: number;
}

/** Filter for {@link StorageAdapter.listSessions} / {@link StorageAdapter.listUsers}. */
export interface SessionQuery {
  /** Only sessions/users for this `sub`. */
  sub?: string;
  /** Maximum rows returned (most recent first). */
  limit?: number;
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
