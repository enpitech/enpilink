import { MemoryStorageAdapter } from "./memory.js";
import { PostgresStorageAdapter } from "./postgres.js";
import { SqliteStorageAdapter } from "./sqlite.js";
import type {
  StorageAdapter,
  StorageAdapterFactory,
  StorageAdapterOptions,
} from "./types.js";

const registry = new Map<string, StorageAdapterFactory>();

/**
 * Register a named storage adapter factory. Overwrites any existing
 * registration for the same name. Built-ins `memory` and `sqlite` are
 * pre-registered.
 */
export function registerStorageAdapter(
  name: string,
  factory: StorageAdapterFactory,
): void {
  registry.set(name, factory);
}

/** List the names of all registered storage adapters. */
export function listStorageAdapters(): string[] {
  return [...registry.keys()];
}

// Built-ins.
registerStorageAdapter("memory", (opts) => new MemoryStorageAdapter(opts));
registerStorageAdapter("sqlite", (opts) => new SqliteStorageAdapter(opts));
registerStorageAdapter("postgres", (opts) => new PostgresStorageAdapter(opts));

/**
 * Resolve the storage adapter from the environment.
 *
 * - `ENPILINK_STORAGE` selects the adapter by name (defaults to `memory` when
 *   `NODE_ENV !== "production"`, otherwise `sqlite`).
 * - `ENPILINK_DB_PATH` overrides the sqlite database path.
 *
 * The returned adapter is NOT yet initialized — callers must `await init()`.
 */
export function resolveStorageAdapter(
  overrides?: StorageAdapterOptions,
): StorageAdapter {
  const name =
    process.env.ENPILINK_STORAGE ??
    (process.env.NODE_ENV === "production" ? "sqlite" : "memory");
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `Unknown storage adapter "${name}". Registered: ${listStorageAdapters().join(", ")}`,
    );
  }
  const opts: StorageAdapterOptions = { ...overrides };
  if (opts.path === undefined && process.env.ENPILINK_DB_PATH) {
    opts.path = process.env.ENPILINK_DB_PATH;
  }
  return factory(opts);
}

export { DEFAULT_MEMORY_CAP, MemoryStorageAdapter } from "./memory.js";
export {
  type PgPoolLike,
  PostgresStorageAdapter,
  type PostgresStorageOptions,
  resolvePostgresConnectionString,
} from "./postgres.js";
export { DEFAULT_DB_PATH, SqliteStorageAdapter } from "./sqlite.js";
export type {
  AnalyticsEvent,
  AuthSession,
  AuthUser,
  ConfigAuditEntry,
  EventQuery,
  LogEntry,
  LogQuery,
  SessionQuery,
  StorageAdapter,
  StorageAdapterFactory,
  StorageAdapterOptions,
} from "./types.js";
