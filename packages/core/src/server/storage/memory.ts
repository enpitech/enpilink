import {
  type AnalyticsEvent,
  type AuthSession,
  type AuthUser,
  type ConfigAuditEntry,
  type EventQuery,
  isGuestSub,
  type LogEntry,
  type LogQuery,
  type SessionQuery,
  type StorageAdapter,
  type StorageAdapterOptions,
} from "./types.js";

/** Default ring-buffer capacity for events and logs. */
export const DEFAULT_MEMORY_CAP = 5000;

/**
 * In-memory {@link StorageAdapter}. Zero dependencies; the dev default.
 *
 * Events and logs live in fixed-capacity ring buffers (oldest dropped first);
 * config lives in a `Map`; config changes append to an in-memory audit list.
 * Nothing persists across process restarts.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private readonly cap: number;
  private readonly events: AnalyticsEvent[] = [];
  private readonly logs: LogEntry[] = [];
  private readonly config = new Map<string, unknown>();
  private readonly audit: ConfigAuditEntry[] = [];
  private readonly users = new Map<string, AuthUser>();
  private readonly sessions = new Map<string, AuthSession>();

  constructor(opts?: StorageAdapterOptions) {
    const cap = opts?.cap ?? DEFAULT_MEMORY_CAP;
    this.cap = cap > 0 ? cap : DEFAULT_MEMORY_CAP;
  }

  async init(): Promise<void> {
    // No setup required.
  }

  async recordEvent(e: AnalyticsEvent): Promise<void> {
    push(this.events, e, this.cap);
  }

  async queryEvents(f: EventQuery = {}): Promise<AnalyticsEvent[]> {
    let out = this.events;
    if (f.since !== undefined) {
      out = out.filter((e) => e.ts >= (f.since as number));
    }
    if (f.type !== undefined) {
      out = out.filter((e) => e.type === f.type);
    }
    if (f.tool !== undefined) {
      out = out.filter((e) => e.tool === f.tool);
    }
    // Most recent first.
    out = out.slice().reverse();
    if (f.limit !== undefined && f.limit >= 0) {
      out = out.slice(0, f.limit);
    }
    // Defensive copy so callers cannot mutate the buffer.
    return out.map((e) => ({ ...e }));
  }

  async appendLog(l: LogEntry): Promise<void> {
    push(this.logs, l, this.cap);
  }

  async queryLogs(f: LogQuery = {}): Promise<LogEntry[]> {
    let out = this.logs;
    if (f.since !== undefined) {
      out = out.filter((l) => l.ts >= (f.since as number));
    }
    if (f.level !== undefined) {
      out = out.filter((l) => l.level === f.level);
    }
    out = out.slice().reverse();
    if (f.limit !== undefined && f.limit >= 0) {
      out = out.slice(0, f.limit);
    }
    return out.map((l) => ({ ...l }));
  }

  async getConfig(key: string): Promise<unknown> {
    return this.config.get(key);
  }

  async setConfig(key: string, value: unknown, actor?: string): Promise<void> {
    const oldValue = this.config.get(key);
    this.config.set(key, value);
    this.audit.push({
      ts: Date.now(),
      key,
      oldValue,
      newValue: value,
      actor: actor ?? "system",
    });
  }

  async clearConfig(key: string, actor?: string): Promise<void> {
    if (!this.config.has(key)) {
      return;
    }
    const oldValue = this.config.get(key);
    this.config.delete(key);
    this.audit.push({
      ts: Date.now(),
      key,
      oldValue,
      newValue: undefined,
      actor: actor ?? "system",
    });
  }

  async allConfig(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.config);
  }

  async getConfigAudit(): Promise<ConfigAuditEntry[]> {
    // Stored oldest-first; return most-recent-first to match the interface.
    return this.audit.map((a) => ({ ...a })).reverse();
  }

  async upsertUser(user: AuthUser): Promise<void> {
    const existing = this.users.get(user.sub);
    // Mirror the sqlite/postgres COALESCE semantics: keep prior email/name when
    // the new write omits them.
    this.users.set(user.sub, {
      ...user,
      createdAt: existing?.createdAt ?? user.createdAt,
      lastSeenAt: user.lastSeenAt,
      email: user.email ?? existing?.email,
      name: user.name ?? existing?.name,
    });
  }

  async recordSession(session: AuthSession): Promise<void> {
    const existing = this.sessions.get(session.id);
    this.sessions.set(session.id, {
      ...session,
      createdAt: existing?.createdAt ?? session.createdAt,
      lastSeenAt: session.lastSeenAt,
    });
  }

  async getSession(id: string): Promise<AuthSession | undefined> {
    const s = this.sessions.get(id);
    return s ? { ...s, isGuest: isGuestSub(s.sub) } : undefined;
  }

  async listSessions(q: SessionQuery = {}): Promise<AuthSession[]> {
    let out = [...this.sessions.values()];
    if (q.sub !== undefined) {
      out = out.filter((s) => s.sub === q.sub);
    }
    out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    if (q.limit !== undefined && q.limit >= 0) {
      out = out.slice(0, q.limit);
    }
    return out.map((s) => ({ ...s, isGuest: isGuestSub(s.sub) }));
  }

  async listUsers(q: SessionQuery = {}): Promise<AuthUser[]> {
    let out = [...this.users.values()];
    if (q.sub !== undefined) {
      out = out.filter((u) => u.sub === q.sub);
    }
    out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    if (q.limit !== undefined && q.limit >= 0) {
      out = out.slice(0, q.limit);
    }
    return out.map((u) => ({ ...u, isGuest: isGuestSub(u.sub) }));
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteUser(sub: string): Promise<void> {
    this.users.delete(sub);
    // Cascade: drop the user's sessions too.
    for (const [id, s] of this.sessions) {
      if (s.sub === sub) {
        this.sessions.delete(id);
      }
    }
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  /** Audit trail of config writes (most recent last). Synchronous helper for tests. */
  getAuditLog(): ConfigAuditEntry[] {
    return this.audit.map((a) => ({ ...a }));
  }
}

/** Append to a ring buffer, dropping the oldest entries past `cap`. */
function push<T>(buf: T[], item: T, cap: number): void {
  buf.push(item);
  if (buf.length > cap) {
    buf.splice(0, buf.length - cap);
  }
}
