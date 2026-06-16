import type DatabaseConstructor from "better-sqlite3";
import type { Database, Statement } from "better-sqlite3";
import type {
  AnalyticsEvent,
  ConfigAuditEntry,
  EventQuery,
  LogEntry,
  LogQuery,
  StorageAdapter,
  StorageAdapterOptions,
} from "./types.js";

/** Default on-disk database path. Overridable via `ENPILINK_DB_PATH`. */
export const DEFAULT_DB_PATH = "./enpilink.db";

/**
 * Embedded-SQLite {@link StorageAdapter}, backed by `better-sqlite3`.
 *
 * `better-sqlite3` was chosen over `node:sqlite` (experimental, warns on every
 * load) and `@libsql/client` (async, remote-oriented, heavier): it is mature,
 * synchronous (simple adapter code), and ships prebuilt binaries for both
 * macOS-arm64 and linux-x64, so `pnpm install` succeeds without node-gyp.
 *
 * Tables: `events`, `logs`, `config`, `config_audit`. Config values are stored
 * as opaque JSON — no special-casing of keys. The DB path is gitignored.
 */
export class SqliteStorageAdapter implements StorageAdapter {
  private readonly path: string;
  private db: Database | null = null;
  private stmts: {
    insertEvent: Statement;
    insertLog: Statement;
    getConfig: Statement;
    upsertConfig: Statement;
    deleteConfig: Statement;
    insertAudit: Statement;
    allConfig: Statement;
  } | null = null;

  constructor(opts?: StorageAdapterOptions) {
    this.path = opts?.path ?? DEFAULT_DB_PATH;
  }

  async init(): Promise<void> {
    if (this.db) {
      return;
    }
    // Dynamic import keeps the native module out of the load path until a
    // sqlite adapter is actually instantiated (memory-only users pay nothing).
    const mod = await import("better-sqlite3");
    const Database = (mod.default ??
      mod) as unknown as typeof DatabaseConstructor;
    const db = new Database(this.path);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    this.db = db;
    this.stmts = {
      insertEvent: db.prepare(
        "INSERT INTO events (ts, type, tool, method, ms, ok, error, meta) VALUES (@ts, @type, @tool, @method, @ms, @ok, @error, @meta)",
      ),
      insertLog: db.prepare(
        "INSERT INTO logs (ts, level, msg, data) VALUES (@ts, @level, @msg, @data)",
      ),
      getConfig: db.prepare("SELECT value FROM config WHERE key = ?"),
      upsertConfig: db.prepare(
        "INSERT INTO config (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value",
      ),
      deleteConfig: db.prepare("DELETE FROM config WHERE key = ?"),
      insertAudit: db.prepare(
        "INSERT INTO config_audit (ts, key, old_value, new_value, actor) VALUES (@ts, @key, @old_value, @new_value, @actor)",
      ),
      allConfig: db.prepare("SELECT key, value FROM config"),
    };
  }

  private require() {
    if (!this.db || !this.stmts) {
      throw new Error("SqliteStorageAdapter: call init() before use");
    }
    return { db: this.db, stmts: this.stmts };
  }

  async recordEvent(e: AnalyticsEvent): Promise<void> {
    const { stmts } = this.require();
    stmts.insertEvent.run({
      ts: e.ts,
      type: e.type,
      tool: e.tool ?? null,
      method: e.method ?? null,
      ms: e.ms ?? null,
      ok: e.ok === undefined ? null : e.ok ? 1 : 0,
      error: e.error ?? null,
      meta: e.meta === undefined ? null : JSON.stringify(e.meta),
    });
  }

  async queryEvents(f: EventQuery = {}): Promise<AnalyticsEvent[]> {
    const { db } = this.require();
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (f.since !== undefined) {
      where.push("ts >= @since");
      params.since = f.since;
    }
    if (f.type !== undefined) {
      where.push("type = @type");
      params.type = f.type;
    }
    if (f.tool !== undefined) {
      where.push("tool = @tool");
      params.tool = f.tool;
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = limitClause(f.limit, params);
    const rows = db
      .prepare(
        `SELECT ts, type, tool, method, ms, ok, error, meta FROM events ${clause} ORDER BY id DESC ${limit}`,
      )
      .all(params) as EventRow[];
    return rows.map(rowToEvent);
  }

  async appendLog(l: LogEntry): Promise<void> {
    const { stmts } = this.require();
    stmts.insertLog.run({
      ts: l.ts,
      level: l.level,
      msg: l.msg,
      data: l.data === undefined ? null : JSON.stringify(l.data),
    });
  }

  async queryLogs(f: LogQuery = {}): Promise<LogEntry[]> {
    const { db } = this.require();
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (f.since !== undefined) {
      where.push("ts >= @since");
      params.since = f.since;
    }
    if (f.level !== undefined) {
      where.push("level = @level");
      params.level = f.level;
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = limitClause(f.limit, params);
    const rows = db
      .prepare(
        `SELECT ts, level, msg, data FROM logs ${clause} ORDER BY id DESC ${limit}`,
      )
      .all(params) as LogRow[];
    return rows.map(rowToLog);
  }

  async getConfig(key: string): Promise<unknown> {
    const { stmts } = this.require();
    const row = stmts.getConfig.get(key) as { value: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  async setConfig(key: string, value: unknown, actor?: string): Promise<void> {
    const { db, stmts } = this.require();
    const serialized = JSON.stringify(value);
    // Atomically read-old → write-new → write-audit.
    const tx = db.transaction(() => {
      const existing = stmts.getConfig.get(key) as
        | { value: string }
        | undefined;
      stmts.upsertConfig.run({ key, value: serialized });
      stmts.insertAudit.run({
        ts: Date.now(),
        key,
        old_value: existing === undefined ? null : existing.value,
        new_value: serialized,
        actor: actor ?? "system",
      });
    });
    tx();
  }

  async clearConfig(key: string, actor?: string): Promise<void> {
    const { db, stmts } = this.require();
    const tx = db.transaction(() => {
      const existing = stmts.getConfig.get(key) as
        | { value: string }
        | undefined;
      if (existing === undefined) {
        return;
      }
      stmts.deleteConfig.run(key);
      // `new_value` is NOT NULL; a reset stores JSON `null` (which getAuditLog
      // parses back to `null`) to represent "reset to default".
      stmts.insertAudit.run({
        ts: Date.now(),
        key,
        old_value: existing.value,
        new_value: "null",
        actor: actor ?? "system",
      });
    });
    tx();
  }

  async allConfig(): Promise<Record<string, unknown>> {
    const { stmts } = this.require();
    const rows = stmts.allConfig.all() as { key: string; value: string }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      out[r.key] = JSON.parse(r.value);
    }
    return out;
  }

  async getConfigAudit(): Promise<ConfigAuditEntry[]> {
    return this.getAuditLog();
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.stmts = null;
    }
  }

  /** Audit trail of config writes (most recent first). Synchronous helper. */
  getAuditLog(): ConfigAuditEntry[] {
    const { db } = this.require();
    const rows = db
      .prepare(
        "SELECT ts, key, old_value, new_value, actor FROM config_audit ORDER BY id DESC",
      )
      .all() as AuditRow[];
    return rows.map((r) => ({
      ts: r.ts,
      key: r.key,
      oldValue: r.old_value === null ? undefined : JSON.parse(r.old_value),
      newValue: JSON.parse(r.new_value),
      actor: r.actor,
    }));
  }
}

function limitClause(
  limit: number | undefined,
  params: Record<string, unknown>,
): string {
  if (limit === undefined || limit < 0) {
    return "";
  }
  params.limit = limit;
  return "LIMIT @limit";
}

interface EventRow {
  ts: number;
  type: string;
  tool: string | null;
  method: string | null;
  ms: number | null;
  ok: number | null;
  error: string | null;
  meta: string | null;
}

interface LogRow {
  ts: number;
  level: string;
  msg: string;
  data: string | null;
}

interface AuditRow {
  ts: number;
  key: string;
  old_value: string | null;
  new_value: string;
  actor: string;
}

function rowToEvent(r: EventRow): AnalyticsEvent {
  const e: AnalyticsEvent = { ts: r.ts, type: r.type };
  if (r.tool !== null) {
    e.tool = r.tool;
  }
  if (r.method !== null) {
    e.method = r.method;
  }
  if (r.ms !== null) {
    e.ms = r.ms;
  }
  if (r.ok !== null) {
    e.ok = r.ok === 1;
  }
  if (r.error !== null) {
    e.error = r.error;
  }
  if (r.meta !== null) {
    e.meta = JSON.parse(r.meta);
  }
  return e;
}

function rowToLog(r: LogRow): LogEntry {
  const l: LogEntry = {
    ts: r.ts,
    level: r.level as LogEntry["level"],
    msg: r.msg,
  };
  if (r.data !== null) {
    l.data = JSON.parse(r.data);
  }
  return l;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  tool TEXT,
  method TEXT,
  ms INTEGER,
  ok INTEGER,
  error TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type);
CREATE INDEX IF NOT EXISTS idx_events_tool ON events (tool);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  msg TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_key ON config_audit (key);
`;
