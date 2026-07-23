import type { Database } from "better-sqlite3";
import type { PgPoolLike } from "./postgres.js";

/**
 * Ordered schema migrations for the built-in SQL adapters.
 *
 * WHY THIS EXISTS: the legacy `SCHEMA` blocks in `sqlite.ts` / `postgres.ts` are
 * all `CREATE TABLE IF NOT EXISTS`, which safely adds new *tables* to an
 * existing `enpilink.db` — but silently does NOTHING for a new *column* on an
 * existing table. Users already have an `enpilink.db` (1.1.1 made dev storage
 * durable), and the agent surface will need to evolve its columns. So we ship a
 * real, versioned migration runner from day one:
 *
 * - **sqlite** tracks the applied version in `PRAGMA user_version` (an integer
 *   in the DB header). A fresh DB reads `0`, so every migration applies once.
 * - **postgres** tracks applied versions in a `schema_migrations` table (pg has
 *   no `user_version`).
 *
 * Both runners are IDEMPOTENT: a migration whose version is already recorded is
 * never re-run, so calling the runner twice — or against an existing DB that
 * predates the agent surface — is safe. The migration SQL itself also uses
 * `IF NOT EXISTS`, belt-and-braces, so even a torn write re-applies cleanly.
 *
 * ORDER MATTERS. Append new migrations with the next integer version; never
 * renumber or edit a shipped one (change the schema by adding a new migration).
 */

/** A single ordered migration, with per-dialect SQL. */
export interface Migration {
  /** Monotonic version. The Nth migration has version N. */
  version: number;
  /** Human label (for logs/debugging). */
  name: string;
  /** SQL applied on sqlite (may contain multiple statements). */
  sqlite: string;
  /** SQL applied on postgres (may contain multiple statements). */
  postgres: string;
}

/**
 * Migration 1 — the agent capture spine (M1).
 *
 * `agent_requests` holds the request row + the full fingerprint (raw header
 * pairs in `headers`, HTTP version, timing). Detection/session columns
 * (`agent_family`/`agent_class`/`confidence`/`session_id`/`task_token`) ship now
 * so later milestones fill values without an ALTER. `agent_sites` stores the
 * per-site IP salt. NOTE: deliberately NOT the `events` table — co-mingling
 * would corrupt the MCP dashboard's unfiltered totals.
 */
const AGENT_REQUESTS_SQLITE = `
CREATE TABLE IF NOT EXISTS agent_sites (
  id          TEXT PRIMARY KEY,
  origin      TEXT,
  ip_salt     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  site_id       TEXT    NOT NULL,
  method        TEXT    NOT NULL,
  path          TEXT    NOT NULL,
  status        INTEGER NOT NULL,
  outcome       TEXT    NOT NULL,
  http_version  TEXT    NOT NULL,
  headers       TEXT    NOT NULL,
  ip_hash       TEXT,
  ua            TEXT,
  referer       TEXT,
  ms            INTEGER,
  agent_family  TEXT,
  agent_class   INTEGER,
  confidence    TEXT    NOT NULL DEFAULT 'none',
  session_id    TEXT,
  task_token    TEXT,
  meta          TEXT
);
CREATE INDEX IF NOT EXISTS idx_areq_site_ts  ON agent_requests (site_id, ts);
CREATE INDEX IF NOT EXISTS idx_areq_outcome  ON agent_requests (site_id, outcome, ts);
CREATE INDEX IF NOT EXISTS idx_areq_family   ON agent_requests (site_id, agent_family, ts);
CREATE INDEX IF NOT EXISTS idx_areq_path     ON agent_requests (site_id, path, ts);
CREATE INDEX IF NOT EXISTS idx_areq_ts       ON agent_requests (ts);
`;

const AGENT_REQUESTS_POSTGRES = `
CREATE TABLE IF NOT EXISTS agent_sites (
  id          TEXT PRIMARY KEY,
  origin      TEXT,
  ip_salt     TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_requests (
  id            BIGSERIAL PRIMARY KEY,
  ts            BIGINT  NOT NULL,
  site_id       TEXT    NOT NULL,
  method        TEXT    NOT NULL,
  path          TEXT    NOT NULL,
  status        INTEGER NOT NULL,
  outcome       TEXT    NOT NULL,
  http_version  TEXT    NOT NULL,
  headers       TEXT    NOT NULL,
  ip_hash       TEXT,
  ua            TEXT,
  referer       TEXT,
  ms            BIGINT,
  agent_family  TEXT,
  agent_class   INTEGER,
  confidence    TEXT    NOT NULL DEFAULT 'none',
  session_id    TEXT,
  task_token    TEXT,
  meta          TEXT
);
CREATE INDEX IF NOT EXISTS idx_areq_site_ts  ON agent_requests (site_id, ts);
CREATE INDEX IF NOT EXISTS idx_areq_outcome  ON agent_requests (site_id, outcome, ts);
CREATE INDEX IF NOT EXISTS idx_areq_family   ON agent_requests (site_id, agent_family, ts);
CREATE INDEX IF NOT EXISTS idx_areq_path     ON agent_requests (site_id, path, ts);
CREATE INDEX IF NOT EXISTS idx_areq_ts       ON agent_requests (ts);
`;

/**
 * Migration 2 — the detection engine (M2).
 *
 * M2 stores the behavioural taxonomy STRING (`crawler`, `chat-fetcher`, …) in
 * `agent_class`, which migration 1 declared `INTEGER` (an earlier numeric-class
 * draft, never populated). On sqlite that column has INTEGER affinity, which
 * stores a non-numeric string verbatim — so no type change is needed there; we
 * only add the class index. On postgres a strict `INTEGER` column would reject
 * the string, so we widen it to `TEXT` (the column is all-NULL, so the cast is
 * trivial and safe). Both dialects gain `idx_areq_class` for the class-grouped
 * dashboard queries M5 will run.
 */
const AGENT_CLASS_TEXT_SQLITE = `
CREATE INDEX IF NOT EXISTS idx_areq_class ON agent_requests (site_id, agent_class, ts);
`;

const AGENT_CLASS_TEXT_POSTGRES = `
ALTER TABLE agent_requests ALTER COLUMN agent_class TYPE TEXT;
CREATE INDEX IF NOT EXISTS idx_areq_class ON agent_requests (site_id, agent_class, ts);
`;

/**
 * Migration 3 — the M3 serve flag (M4).
 *
 * Records whether the routing layer served the self-sufficient agent
 * representation for a request (`served`, an INTEGER 0/1 to match the `ok`
 * boolean convention) and which encoding (`served_encoding`). Segmenting
 * served-vs-not is the confabulation-gap headline the product exists to compute.
 *
 * A new COLUMN on an existing table is the exact thing `CREATE ... IF NOT EXISTS`
 * silently NO-OPs, which is why this is a versioned migration. On postgres the
 * `ADD COLUMN IF NOT EXISTS` is itself idempotent; on sqlite `ADD COLUMN` has no
 * `IF NOT EXISTS`, so the runner's `user_version` guard is what makes it run
 * exactly once (identical to how migration 2's postgres `ALTER ... TYPE` relies
 * on version tracking). The default 0 backfills every pre-M4 row as "not served".
 */
const AGENT_SERVED_SQLITE = `
ALTER TABLE agent_requests ADD COLUMN served INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_requests ADD COLUMN served_encoding TEXT;
`;

const AGENT_SERVED_POSTGRES = `
ALTER TABLE agent_requests ADD COLUMN IF NOT EXISTS served INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_requests ADD COLUMN IF NOT EXISTS served_encoding TEXT;
`;

/**
 * Migration 4 — the ruleset version stamp (D1, distribution epic).
 *
 * Records WHICH ruleset version classified each row (`ruleset_version`). It is
 * NULL for rows captured while no ruleset was loaded (`confidence = 'pending'`)
 * and for rows that predate this column — both of which
 * `backfillClassification` re-classifies (its predicate is
 * `ruleset_version IS NULL OR ruleset_version <> @current`), then stamps here so
 * they drop out of the scan. The index keeps that backfill scan cheap.
 *
 * A new COLUMN is exactly what `CREATE ... IF NOT EXISTS` silently NO-OPs, so this
 * is a versioned migration (NOT an edit to migration 1). On sqlite `ADD COLUMN`
 * has no `IF NOT EXISTS`, so the runner's `user_version` guard makes it run once;
 * on postgres the `ADD COLUMN IF NOT EXISTS` is itself idempotent.
 */
const AGENT_RULESET_VERSION_SQLITE = `
ALTER TABLE agent_requests ADD COLUMN ruleset_version TEXT;
CREATE INDEX IF NOT EXISTS idx_areq_ruleset ON agent_requests (ruleset_version);
`;

const AGENT_RULESET_VERSION_POSTGRES = `
ALTER TABLE agent_requests ADD COLUMN IF NOT EXISTS ruleset_version TEXT;
CREATE INDEX IF NOT EXISTS idx_areq_ruleset ON agent_requests (ruleset_version);
`;

/** The ordered migration list. Append-only. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "agent_capture_spine",
    sqlite: AGENT_REQUESTS_SQLITE,
    postgres: AGENT_REQUESTS_POSTGRES,
  },
  {
    version: 2,
    name: "agent_class_text",
    sqlite: AGENT_CLASS_TEXT_SQLITE,
    postgres: AGENT_CLASS_TEXT_POSTGRES,
  },
  {
    version: 3,
    name: "agent_served_flag",
    sqlite: AGENT_SERVED_SQLITE,
    postgres: AGENT_SERVED_POSTGRES,
  },
  {
    version: 4,
    name: "agent_ruleset_version",
    sqlite: AGENT_RULESET_VERSION_SQLITE,
    postgres: AGENT_RULESET_VERSION_POSTGRES,
  },
];

/** The highest migration version this build ships. */
export const LATEST_MIGRATION_VERSION: number = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

/**
 * Apply pending sqlite migrations, tracked via `PRAGMA user_version`. Returns
 * the versions applied on this call (empty when already up to date). Idempotent:
 * safe to call on every `init()`, and safe against an existing `enpilink.db`
 * that predates the agent surface (its `user_version` is `0`).
 */
export function runSqliteMigrations(db: Database): number[] {
  const current = Number(db.pragma("user_version", { simple: true })) || 0;
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.version <= current) {
      continue;
    }
    // Each migration's DDL is idempotent (IF NOT EXISTS); the version is only
    // advanced AFTER the DDL succeeds, so a partial failure re-applies safely.
    db.exec(m.sqlite);
    db.pragma(`user_version = ${m.version}`);
    applied.push(m.version);
  }
  return applied;
}

/**
 * Apply pending postgres migrations, tracked in a `schema_migrations` table
 * (postgres has no `user_version`). Returns the versions applied on this call.
 * Idempotent for the same reasons as {@link runSqliteMigrations}.
 */
export async function runPostgresMigrations(
  pool: PgPoolLike,
): Promise<number[]> {
  // Ensure the tracking table exists, but only issue the CREATE when it is
  // actually absent. Re-issuing `CREATE TABLE IF NOT EXISTS` against an
  // already-existing table is a no-op on real Postgres, but pg-mem (the test
  // engine) rejects it — so probe first, then create only if the probe fails.
  let tableExists = true;
  try {
    await pool.query("SELECT 1 FROM schema_migrations LIMIT 1");
  } catch {
    tableExists = false;
  }
  if (!tableExists) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    INTEGER PRIMARY KEY,
         applied_at BIGINT NOT NULL
       )`,
    );
  }
  const { rows } = await pool.query<{ version: number | string }>(
    "SELECT version FROM schema_migrations",
  );
  const done = new Set(rows.map((r) => Number(r.version)));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) {
      continue;
    }
    await pool.query(m.postgres);
    await pool.query(
      "INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)",
      [m.version, Date.now()],
    );
    applied.push(m.version);
  }
  return applied;
}
