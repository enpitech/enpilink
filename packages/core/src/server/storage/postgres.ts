import { runPostgresMigrations } from "./migrations.js";
import {
  type AgentRequestQuery,
  type AgentRequestRecord,
  type AgentSiteRecord,
  type AnalyticsEvent,
  type AuthSession,
  type AuthUser,
  type ConfigAuditEntry,
  type EventQuery,
  type HeaderPair,
  isGuestSub,
  type LogEntry,
  type LogQuery,
  type PruneOptions,
  type SessionQuery,
  type StorageAdapter,
  type StorageAdapterOptions,
} from "./types.js";

/**
 * PostgreSQL {@link StorageAdapter}, backed by `pg` (node-postgres).
 *
 * `pg` is pure-JS (no native build), so it installs cleanly in CI on both
 * macOS-arm64 and linux-x64. The connection is configured ENTIRELY from the
 * environment — never hardcoded:
 *
 * - `ENPILINK_DB_URL` (enpilink-specific) takes precedence, else
 * - `DATABASE_URL` (the de-facto standard), else
 * - the standard `PG*` vars (`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`)
 *   which `pg` reads on its own when no `connectionString` is given.
 *
 * Tables `events`, `logs`, `config`, `config_audit` are created-if-not-exists in
 * {@link init}. Config values are stored as opaque JSON text — no special-casing
 * of keys. Writes use prepared/parameterized statements; `recordEvent` /
 * `appendLog` are single cheap inserts so the ~600-write mock seed stays fast.
 */

/** Minimal structural type for a `pg` query result (avoids a hard type dep). */
interface PgQueryResult<R = Record<string, unknown>> {
  rows: R[];
}

/** Minimal structural type for a `pg` Pool — enough for this adapter. */
export interface PgPoolLike {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PgQueryResult<R>>;
  end(): Promise<void>;
}

/** Options specific to the postgres adapter. */
export interface PostgresStorageOptions extends StorageAdapterOptions {
  /**
   * Inject a `pg`-compatible Pool (used by tests with `pg-mem`). When omitted,
   * a real `pg.Pool` is constructed lazily in {@link init} from the environment.
   */
  pool?: PgPoolLike;
  /**
   * Explicit connection string. Normally left undefined so the connection is
   * resolved from `ENPILINK_DB_URL` / `DATABASE_URL` / `PG*` env vars. Never
   * hardcode a connection string in source.
   */
  connectionString?: string;
}

/**
 * Resolve the connection string from the environment. Returns `undefined` when
 * none of the enpilink/standard URL vars are set — in that case `pg` falls back
 * to its own `PG*` env-var handling. NEVER returns a hardcoded default.
 */
export function resolvePostgresConnectionString(): string | undefined {
  // Treat blank/whitespace-only values as unset so a blank var never shadows a
  // real one (and never becomes a hardcoded-looking default).
  const enpilink = process.env.ENPILINK_DB_URL?.trim();
  if (enpilink) {
    return enpilink;
  }
  const standard = process.env.DATABASE_URL?.trim();
  return standard ? standard : undefined;
}

export class PostgresStorageAdapter implements StorageAdapter {
  private readonly injectedPool?: PgPoolLike;
  private readonly connectionString?: string;
  private pool: PgPoolLike | null = null;

  constructor(opts?: PostgresStorageOptions) {
    this.injectedPool = opts?.pool;
    this.connectionString =
      opts?.connectionString ?? resolvePostgresConnectionString();
  }

  async init(): Promise<void> {
    if (this.pool) {
      return;
    }
    if (this.injectedPool) {
      this.pool = this.injectedPool;
    } else {
      // Dynamic import keeps `pg` out of the load path until a postgres adapter
      // is actually instantiated (memory/sqlite users pay nothing).
      const mod = await import("pg");
      const Pool = (mod.default?.Pool ??
        (mod as unknown as { Pool: new (cfg?: unknown) => PgPoolLike })
          .Pool) as new (
        cfg?: unknown,
      ) => PgPoolLike;
      // When no connectionString is resolved, pass none so `pg` reads PG* vars.
      this.pool = this.connectionString
        ? new Pool({ connectionString: this.connectionString })
        : new Pool();
    }
    await this.pool.query(SCHEMA);
    // Versioned migrations (agent_* tables etc.) run AFTER the legacy schema.
    // Idempotent + tracked via a `schema_migrations` table — safe on an
    // existing database.
    await runPostgresMigrations(this.pool);
  }

  private require(): PgPoolLike {
    if (!this.pool) {
      throw new Error("PostgresStorageAdapter: call init() before use");
    }
    return this.pool;
  }

  async recordEvent(e: AnalyticsEvent): Promise<void> {
    const pool = this.require();
    await pool.query(
      "INSERT INTO events (ts, type, tool, method, ms, ok, error, meta) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        e.ts,
        e.type,
        e.tool ?? null,
        e.method ?? null,
        e.ms ?? null,
        e.ok === undefined ? null : e.ok,
        e.error ?? null,
        e.meta === undefined ? null : JSON.stringify(e.meta),
      ],
    );
  }

  async queryEvents(f: EventQuery = {}): Promise<AnalyticsEvent[]> {
    const pool = this.require();
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.since !== undefined) {
      params.push(f.since);
      where.push(`ts >= $${params.length}`);
    }
    if (f.type !== undefined) {
      params.push(f.type);
      where.push(`type = $${params.length}`);
    }
    if (f.tool !== undefined) {
      params.push(f.tool);
      where.push(`tool = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = limitClause(f.limit, params);
    const { rows } = await pool.query<EventRow>(
      `SELECT ts, type, tool, method, ms, ok, error, meta FROM events ${clause} ORDER BY id DESC ${limit}`,
      params,
    );
    return rows.map(rowToEvent);
  }

  async appendLog(l: LogEntry): Promise<void> {
    const pool = this.require();
    await pool.query(
      "INSERT INTO logs (ts, level, msg, data) VALUES ($1, $2, $3, $4)",
      [
        l.ts,
        l.level,
        l.msg,
        l.data === undefined ? null : JSON.stringify(l.data),
      ],
    );
  }

  async queryLogs(f: LogQuery = {}): Promise<LogEntry[]> {
    const pool = this.require();
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.since !== undefined) {
      params.push(f.since);
      where.push(`ts >= $${params.length}`);
    }
    if (f.level !== undefined) {
      params.push(f.level);
      where.push(`level = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = limitClause(f.limit, params);
    const { rows } = await pool.query<LogRow>(
      `SELECT ts, level, msg, data FROM logs ${clause} ORDER BY id DESC ${limit}`,
      params,
    );
    return rows.map(rowToLog);
  }

  async getConfig(key: string): Promise<unknown> {
    const pool = this.require();
    const { rows } = await pool.query<{ value: string }>(
      "SELECT value FROM config WHERE key = $1",
      [key],
    );
    const row = rows[0];
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  async setConfig(key: string, value: unknown, actor?: string): Promise<void> {
    const pool = this.require();
    const serialized = JSON.stringify(value);
    // Read-old → upsert-new → write-audit. pg-mem does not implement
    // transactions identically across versions, so we read-then-write without a
    // BEGIN/COMMIT wrapper; the audit row records the prior value either way.
    const { rows } = await pool.query<{ value: string }>(
      "SELECT value FROM config WHERE key = $1",
      [key],
    );
    const oldSerialized = rows[0]?.value ?? null;
    await pool.query(
      "INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [key, serialized],
    );
    await pool.query(
      "INSERT INTO config_audit (ts, key, old_value, new_value, actor) VALUES ($1, $2, $3, $4, $5)",
      [Date.now(), key, oldSerialized, serialized, actor ?? "system"],
    );
  }

  async clearConfig(key: string, actor?: string): Promise<void> {
    const pool = this.require();
    const { rows } = await pool.query<{ value: string }>(
      "SELECT value FROM config WHERE key = $1",
      [key],
    );
    const existing = rows[0];
    if (existing === undefined) {
      return;
    }
    await pool.query("DELETE FROM config WHERE key = $1", [key]);
    // `new_value` is NOT NULL; a reset stores JSON `null` to represent
    // "reset to default" (getConfigAudit parses it back to `null`).
    await pool.query(
      "INSERT INTO config_audit (ts, key, old_value, new_value, actor) VALUES ($1, $2, $3, $4, $5)",
      [Date.now(), key, existing.value, "null", actor ?? "system"],
    );
  }

  async allConfig(): Promise<Record<string, unknown>> {
    const pool = this.require();
    const { rows } = await pool.query<{ key: string; value: string }>(
      "SELECT key, value FROM config",
    );
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      out[r.key] = JSON.parse(r.value);
    }
    return out;
  }

  async getConfigAudit(): Promise<ConfigAuditEntry[]> {
    const pool = this.require();
    const { rows } = await pool.query<AuditRow>(
      "SELECT ts, key, old_value, new_value, actor FROM config_audit ORDER BY id DESC",
    );
    return rows.map((r) => ({
      ts: Number(r.ts),
      key: r.key,
      oldValue: r.old_value === null ? undefined : JSON.parse(r.old_value),
      newValue: JSON.parse(r.new_value),
      actor: r.actor,
    }));
  }

  async upsertUser(user: AuthUser): Promise<void> {
    const pool = this.require();
    await pool.query(
      `INSERT INTO auth_users (sub, issuer, created_at, last_seen_at, email, name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sub) DO UPDATE SET
         issuer = $2, last_seen_at = $4,
         email = COALESCE($5, auth_users.email),
         name = COALESCE($6, auth_users.name)`,
      [
        user.sub,
        user.issuer ?? null,
        user.createdAt,
        user.lastSeenAt,
        user.email ?? null,
        user.name ?? null,
      ],
    );
  }

  async recordSession(session: AuthSession): Promise<void> {
    const pool = this.require();
    await pool.query(
      `INSERT INTO auth_sessions (id, sub, issuer, client_id, token_ref, scopes, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         last_seen_at = $8, scopes = $6, client_id = $4, expires_at = $9`,
      [
        session.id,
        session.sub,
        session.issuer ?? null,
        session.clientId ?? null,
        session.tokenRef ?? null,
        session.scopes ? session.scopes.join(" ") : null,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt ?? null,
      ],
    );
  }

  async getSession(id: string): Promise<AuthSession | undefined> {
    const pool = this.require();
    const { rows } = await pool.query<SessionRow>(
      "SELECT * FROM auth_sessions WHERE id = $1",
      [id],
    );
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  async listSessions(q: SessionQuery = {}): Promise<AuthSession[]> {
    const pool = this.require();
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.sub !== undefined) {
      params.push(q.sub);
      where.push(`sub = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = limitClause(q.limit, params);
    const { rows } = await pool.query<SessionRow>(
      `SELECT * FROM auth_sessions ${clause} ORDER BY last_seen_at DESC ${limit}`,
      params,
    );
    return rows.map(rowToSession);
  }

  async listUsers(q: SessionQuery = {}): Promise<AuthUser[]> {
    const pool = this.require();
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.sub !== undefined) {
      params.push(q.sub);
      where.push(`sub = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = limitClause(q.limit, params);
    const { rows } = await pool.query<UserRow>(
      `SELECT * FROM auth_users ${clause} ORDER BY last_seen_at DESC ${limit}`,
      params,
    );
    return rows.map(rowToUser);
  }

  async deleteSession(id: string): Promise<void> {
    const pool = this.require();
    await pool.query("DELETE FROM auth_sessions WHERE id = $1", [id]);
  }

  async deleteUser(sub: string): Promise<void> {
    const pool = this.require();
    await pool.query("DELETE FROM auth_sessions WHERE sub = $1", [sub]);
    await pool.query("DELETE FROM auth_users WHERE sub = $1", [sub]);
  }

  async recordAgentRequests(records: AgentRequestRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const pool = this.require();
    // One multi-row INSERT (a real batch), pg-mem-compatible. No BEGIN/COMMIT
    // wrapper — pg-mem's transaction semantics differ across versions, and a
    // single statement is atomic anyway.
    const cols = 18;
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < records.length; i++) {
      const base = i * cols;
      const ph = Array.from({ length: cols }, (_, j) => `$${base + j + 1}`);
      values.push(`(${ph.join(", ")})`);
      const r = records[i] as AgentRequestRecord;
      params.push(
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
        r.meta === undefined ? null : JSON.stringify(r.meta),
      );
    }
    await pool.query(
      `INSERT INTO agent_requests
         (ts, site_id, method, path, status, outcome, http_version, headers,
          ip_hash, ua, referer, ms, agent_family, agent_class, confidence,
          session_id, task_token, meta)
       VALUES ${values.join(", ")}`,
      params,
    );
  }

  async queryAgentRequests(
    q: AgentRequestQuery = {},
  ): Promise<AgentRequestRecord[]> {
    const pool = this.require();
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.since !== undefined) {
      params.push(q.since);
      where.push(`ts >= $${params.length}`);
    }
    if (q.until !== undefined) {
      params.push(q.until);
      where.push(`ts < $${params.length}`);
    }
    if (q.siteId !== undefined) {
      params.push(q.siteId);
      where.push(`site_id = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = limitClause(q.limit, params);
    const { rows } = await pool.query<AgentRequestRow>(
      `SELECT * FROM agent_requests ${clause} ORDER BY id DESC ${limit}`,
      params,
    );
    return rows.map(rowToAgentRequest);
  }

  async ensureAgentSite(site: AgentSiteRecord): Promise<AgentSiteRecord> {
    const pool = this.require();
    await pool.query(
      `INSERT INTO agent_sites (id, origin, ip_salt, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [site.id, site.origin ?? null, site.ipSalt, site.createdAt],
    );
    const { rows } = await pool.query<AgentSiteRow>(
      "SELECT * FROM agent_sites WHERE id = $1",
      [site.id],
    );
    return rowToAgentSite(rows[0] as AgentSiteRow);
  }

  async prune(opts: PruneOptions): Promise<number> {
    const pool = this.require();
    const { rows } = await pool.query<{ id: number | string }>(
      "DELETE FROM agent_requests WHERE ts < $1 RETURNING id",
      [opts.before],
    );
    return rows.length;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

function limitClause(limit: number | undefined, params: unknown[]): string {
  if (limit === undefined || limit < 0) {
    return "";
  }
  params.push(limit);
  return `LIMIT $${params.length}`;
}

interface EventRow {
  ts: number | string;
  type: string;
  tool: string | null;
  method: string | null;
  ms: number | string | null;
  ok: boolean | null;
  error: string | null;
  meta: string | null;
}

interface LogRow {
  ts: number | string;
  level: string;
  msg: string;
  data: string | null;
}

interface AuditRow {
  ts: number | string;
  key: string;
  old_value: string | null;
  new_value: string;
  actor: string;
}

function rowToEvent(r: EventRow): AnalyticsEvent {
  const e: AnalyticsEvent = { ts: Number(r.ts), type: r.type };
  if (r.tool !== null) {
    e.tool = r.tool;
  }
  if (r.method !== null) {
    e.method = r.method;
  }
  if (r.ms !== null) {
    e.ms = Number(r.ms);
  }
  if (r.ok !== null) {
    e.ok = r.ok;
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
    ts: Number(r.ts),
    level: r.level as LogEntry["level"],
    msg: r.msg,
  };
  if (r.data !== null) {
    l.data = JSON.parse(r.data);
  }
  return l;
}

interface UserRow {
  sub: string;
  issuer: string | null;
  created_at: number | string;
  last_seen_at: number | string;
  email: string | null;
  name: string | null;
}

interface SessionRow {
  id: string;
  sub: string;
  issuer: string | null;
  client_id: string | null;
  token_ref: string | null;
  scopes: string | null;
  created_at: number | string;
  last_seen_at: number | string;
  expires_at: number | string | null;
}

function rowToUser(r: UserRow): AuthUser {
  const u: AuthUser = {
    sub: r.sub,
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
    isGuest: isGuestSub(r.sub),
  };
  if (r.issuer !== null) {
    u.issuer = r.issuer;
  }
  if (r.email !== null) {
    u.email = r.email;
  }
  if (r.name !== null) {
    u.name = r.name;
  }
  return u;
}

interface AgentRequestRow {
  ts: number | string;
  site_id: string;
  method: string;
  path: string;
  status: number | string;
  outcome: string;
  http_version: string;
  headers: string;
  ip_hash: string | null;
  ua: string | null;
  referer: string | null;
  ms: number | string | null;
  agent_family: string | null;
  agent_class: string | null;
  confidence: string;
  session_id: string | null;
  task_token: string | null;
  meta: string | null;
}

interface AgentSiteRow {
  id: string;
  origin: string | null;
  ip_salt: string;
  created_at: number | string;
}

function rowToAgentRequest(r: AgentRequestRow): AgentRequestRecord {
  const rec: AgentRequestRecord = {
    ts: Number(r.ts),
    siteId: r.site_id,
    method: r.method,
    path: r.path,
    status: Number(r.status),
    outcome: r.outcome as AgentRequestRecord["outcome"],
    httpVersion: r.http_version,
    headers: JSON.parse(r.headers) as HeaderPair[],
    confidence: r.confidence as AgentRequestRecord["confidence"],
  };
  if (r.ip_hash !== null) {
    rec.ipHash = r.ip_hash;
  }
  if (r.ua !== null) {
    rec.ua = r.ua;
  }
  if (r.referer !== null) {
    rec.referer = r.referer;
  }
  if (r.ms !== null) {
    rec.ms = Number(r.ms);
  }
  if (r.agent_family !== null) {
    rec.agentFamily = r.agent_family;
  }
  if (r.agent_class !== null) {
    rec.agentClass = r.agent_class as AgentRequestRecord["agentClass"];
  }
  if (r.session_id !== null) {
    rec.sessionId = r.session_id;
  }
  if (r.task_token !== null) {
    rec.taskToken = r.task_token;
  }
  if (r.meta !== null) {
    rec.meta = JSON.parse(r.meta);
  }
  return rec;
}

function rowToAgentSite(r: AgentSiteRow): AgentSiteRecord {
  const site: AgentSiteRecord = {
    id: r.id,
    ipSalt: r.ip_salt,
    createdAt: Number(r.created_at),
  };
  if (r.origin !== null) {
    site.origin = r.origin;
  }
  return site;
}

function rowToSession(r: SessionRow): AuthSession {
  const s: AuthSession = {
    id: r.id,
    sub: r.sub,
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
    isGuest: isGuestSub(r.sub),
  };
  if (r.issuer !== null) {
    s.issuer = r.issuer;
  }
  if (r.client_id !== null) {
    s.clientId = r.client_id;
  }
  if (r.token_ref !== null) {
    s.tokenRef = r.token_ref;
  }
  if (r.scopes !== null) {
    s.scopes = r.scopes.split(/\s+/).filter(Boolean);
  }
  if (r.expires_at !== null) {
    s.expiresAt = Number(r.expires_at);
  }
  return s;
}

/**
 * Schema. `BIGINT` for epoch-ms timestamps; `BIGSERIAL` ids give a stable
 * insertion order for most-recent-first queries (`ORDER BY id DESC`). `meta` /
 * `data` / config values are opaque JSON text.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  type TEXT NOT NULL,
  tool TEXT,
  method TEXT,
  ms BIGINT,
  ok BOOLEAN,
  error TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type);
CREATE INDEX IF NOT EXISTS idx_events_tool ON events (tool);

CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
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
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_key ON config_audit (key);

CREATE TABLE IF NOT EXISTS auth_users (
  sub TEXT PRIMARY KEY,
  issuer TEXT,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  email TEXT,
  name TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_users_last_seen ON auth_users (last_seen_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  issuer TEXT,
  client_id TEXT,
  token_ref TEXT,
  scopes TEXT,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_sub ON auth_sessions (sub);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_last_seen ON auth_sessions (last_seen_at);
`;
