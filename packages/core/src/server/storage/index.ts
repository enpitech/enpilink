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
 * - `ENPILINK_STORAGE` selects the adapter by name. When unset it defaults to
 *   **`sqlite`** in BOTH dev and production, so runtime config and
 *   analytics/logs persist to a local `enpilink.db` file and survive restarts
 *   (e.g. an `enpilink dev` operator can toggle `analytics.enabled` and have it
 *   stick across restarts). Set `ENPILINK_STORAGE=memory` to opt back into the
 *   ephemeral in-memory adapter.
 * - `ENPILINK_DB_PATH` overrides the sqlite database path (default
 *   `./enpilink.db`, cwd-relative → per-app).
 *
 * NOTE: `--mock` mode does NOT go through here for its session store — it forces
 * a throwaway {@link MemoryStorageAdapter} (see `analytics.ts`) so the demo seed
 * never touches disk.
 *
 * The returned adapter is NOT yet initialized — callers must `await init()`.
 */
export function resolveStorageAdapter(
  overrides?: StorageAdapterOptions,
): StorageAdapter {
  const name = process.env.ENPILINK_STORAGE ?? "sqlite";
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
  LATEST_MIGRATION_VERSION,
  MIGRATIONS,
  type Migration,
  runPostgresMigrations,
  runSqliteMigrations,
} from "./migrations.js";
export {
  type PgPoolLike,
  PostgresStorageAdapter,
  type PostgresStorageOptions,
  resolvePostgresConnectionString,
} from "./postgres.js";
export { DEFAULT_DB_PATH, SqliteStorageAdapter } from "./sqlite.js";
export {
  type AgentConfidence,
  type AgentOutcome,
  type AgentRequestQuery,
  type AgentRequestRecord,
  type AgentSiteRecord,
  type AnalyticsEvent,
  type AuthSession,
  type AuthUser,
  type ConfigAuditEntry,
  type EventQuery,
  GUEST_SUB_PREFIX,
  type HeaderPair,
  isGuestSub,
  type LogEntry,
  type LogQuery,
  type PruneOptions,
  type SessionQuery,
  type StorageAdapter,
  type StorageAdapterFactory,
  type StorageAdapterOptions,
} from "./types.js";
