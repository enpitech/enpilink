import type { AgentRequestRecord } from "../../storage/types.js";
import type { EdgeCaptureSink } from "./sink.js";

/**
 * THE CLOUDFLARE D1 CAPTURE SINK (D4b) — write edge-captured agent requests
 * DIRECTLY to a Worker's D1 database, the recommended CF-native store.
 *
 * D1 is SQLite, so the schema is the same `agent_requests` table the Node sqlite
 * adapter uses (mirrored here as {@link D1_SCHEMA}) and the INSERT column list
 * matches `sqlite.ts`'s `agentRequestParams` exactly — so rows written from the
 * edge are byte-compatible with rows written by a Node enpilink reading the same
 * shape. It uses ONLY the D1 binding object the Worker runtime provides
 * (`env.DB`), so it pulls NO `node:*`/`better-sqlite3` — edge-safe.
 *
 * Best-effort, like every capture write: {@link write} swallows any D1 error (the
 * batch is lost, the response is never affected). Classification happens at the
 * edge (via the ruleset client) BEFORE the row is written; a row captured on a
 * cold isolate with no ruleset yet lands `pending`. NOTE for D5: a pure-CF-D1
 * deploy has no Node backfill process, so `pending` rows are not re-labelled — the
 * pending tail is bounded (only the first request of a truly cold isolate) but
 * real; the beacon-sink topology (edge → Node) DOES backfill.
 */

/** A D1 prepared statement — the subset the sink uses (structural, no CF types). */
export interface D1PreparedStatementLike {
  /** Bind positional parameters, returning the bound statement. */
  bind(...values: unknown[]): D1PreparedStatementLike;
  /** Execute the (bound) statement. */
  run(): Promise<unknown>;
}

/** A D1 database binding — the subset the sink uses (structural, no CF types). */
export interface D1DatabaseLike {
  /** Prepare a statement for binding/execution. */
  prepare(query: string): D1PreparedStatementLike;
  /** Run a batch of prepared statements in one transaction. */
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

/**
 * The D1 schema for the agent surface — `agent_sites` + the consolidated
 * `agent_requests` (every column the Node migrations reach: the M1 fingerprint,
 * M3 `served`/`served_encoding`, and D1's `ruleset_version`). Run once at deploy
 * (the D5 "Deploy to Cloudflare" step; also {@link ensureD1Schema}).
 */
export const D1_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_sites (
  id         TEXT PRIMARY KEY,
  origin     TEXT,
  ip_salt    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  site_id         TEXT    NOT NULL,
  method          TEXT    NOT NULL,
  path            TEXT    NOT NULL,
  status          INTEGER NOT NULL,
  outcome         TEXT    NOT NULL,
  http_version    TEXT    NOT NULL,
  headers         TEXT    NOT NULL,
  ip_hash         TEXT,
  ua              TEXT,
  referer         TEXT,
  ms              INTEGER,
  agent_family    TEXT,
  agent_class     TEXT,
  confidence      TEXT    NOT NULL DEFAULT 'none',
  session_id      TEXT,
  task_token      TEXT,
  served          INTEGER NOT NULL DEFAULT 0,
  served_encoding TEXT,
  meta            TEXT,
  ruleset_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_areq_site_ts  ON agent_requests (site_id, ts);
CREATE INDEX IF NOT EXISTS idx_areq_outcome  ON agent_requests (site_id, outcome, ts);
CREATE INDEX IF NOT EXISTS idx_areq_family   ON agent_requests (site_id, agent_family, ts);
CREATE INDEX IF NOT EXISTS idx_areq_class    ON agent_requests (site_id, agent_class, ts);
CREATE INDEX IF NOT EXISTS idx_areq_path     ON agent_requests (site_id, path, ts);
CREATE INDEX IF NOT EXISTS idx_areq_ts       ON agent_requests (ts);
CREATE INDEX IF NOT EXISTS idx_areq_ruleset  ON agent_requests (ruleset_version);
`;

/** The INSERT column list — MATCHES `sqlite.ts` `agentRequestParams` order. */
const INSERT_SQL = `INSERT INTO agent_requests (
  ts, site_id, method, path, status, outcome, http_version, headers,
  ip_hash, ua, referer, ms, agent_family, agent_class, confidence,
  session_id, task_token, served, served_encoding, meta, ruleset_version
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Positional bind values for one record — mirrors `sqlite.ts` `agentRequestParams`. */
function insertParams(r: AgentRequestRecord): unknown[] {
  return [
    r.ts,
    r.siteId,
    r.method,
    r.path,
    r.status,
    r.outcome,
    r.httpVersion,
    JSON.stringify(r.headers),
    r.ipHash ?? null,
    r.ua ?? null,
    r.referer ?? null,
    r.ms ?? null,
    r.agentFamily ?? null,
    r.agentClass ?? null,
    r.confidence ?? "none",
    r.sessionId ?? null,
    r.taskToken ?? null,
    r.served ? 1 : 0,
    r.servedEncoding ?? null,
    r.meta === undefined ? null : JSON.stringify(r.meta),
    r.rulesetVersion ?? null,
  ];
}

/**
 * Create the agent tables on a D1 database if absent. Idempotent
 * (`CREATE … IF NOT EXISTS`). Runs each statement in one `batch` transaction. Use
 * it in a one-time setup / the Deploy-to-Cloudflare scaffold; the sink does NOT
 * call it per-write.
 */
export async function ensureD1Schema(db: D1DatabaseLike): Promise<void> {
  const statements = D1_SCHEMA.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => db.prepare(s));
  if (statements.length > 0) {
    await db.batch(statements);
  }
}

/** Options for {@link D1CaptureSink}. */
export interface D1CaptureSinkOptions {
  /** The D1 database binding (e.g. `env.DB`). */
  db: D1DatabaseLike;
  /** Injectable error sink (default: swallow). */
  onError?: (err: unknown) => void;
}

/**
 * An {@link EdgeCaptureSink} that batch-inserts captured records into Cloudflare
 * D1. Best-effort: a D1 failure is routed to `onError` and swallowed (the batch is
 * lost), never thrown into the caller.
 */
export class D1CaptureSink implements EdgeCaptureSink {
  private readonly db: D1DatabaseLike;
  private readonly onError: (err: unknown) => void;

  constructor(opts: D1CaptureSinkOptions) {
    this.db = opts.db;
    this.onError = opts.onError ?? (() => {});
  }

  async write(records: AgentRequestRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    try {
      const insert = this.db.prepare(INSERT_SQL);
      const statements = records.map((r) => insert.bind(...insertParams(r)));
      await this.db.batch(statements);
    } catch (err) {
      // Best-effort — a storage failure must never surface onto the response.
      this.onError(err);
    }
  }
}

/** Construct a {@link D1CaptureSink}. Sugar for `new D1CaptureSink({ db })`. */
export function d1CaptureSink(
  db: D1DatabaseLike,
  onError?: (err: unknown) => void,
): D1CaptureSink {
  return new D1CaptureSink(onError ? { db, onError } : { db });
}
