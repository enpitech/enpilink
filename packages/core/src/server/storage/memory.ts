import {
  type AgentClassificationUpdate,
  type AgentOutcomeGroup,
  type AgentRequestQuery,
  type AgentRequestRecord,
  type AgentRouteGroup,
  type AgentSiteRecord,
  type AnalyticsEvent,
  type AuthSession,
  type AuthUser,
  type ConfigAuditEntry,
  type EventQuery,
  isGuestSub,
  type LogEntry,
  type LogQuery,
  type PruneOptions,
  type SessionQuery,
  type StorageAdapter,
  type StorageAdapterOptions,
  type UnclassifiedAgentRequestQuery,
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
  private readonly agentRequests: AgentRequestRecord[] = [];
  private readonly agentSites = new Map<string, AgentSiteRecord>();
  /** Monotonic id assigned to each captured request, so backfill can target one. */
  private agentSeq = 0;

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

  async recordAgentRequests(records: AgentRequestRecord[]): Promise<void> {
    for (const r of records) {
      // Defensive copy so callers can't mutate the buffer (headers included). A
      // fresh monotonic id lets backfill target this exact row.
      this.agentSeq += 1;
      push(
        this.agentRequests,
        {
          ...r,
          id: this.agentSeq,
          headers: r.headers.map((p) => [p[0], p[1]] as [string, string]),
        },
        this.cap,
      );
    }
  }

  async queryAgentRequests(
    q: AgentRequestQuery = {},
  ): Promise<AgentRequestRecord[]> {
    let out = this.agentRequests;
    if (q.since !== undefined) {
      out = out.filter((r) => r.ts >= (q.since as number));
    }
    if (q.until !== undefined) {
      out = out.filter((r) => r.ts < (q.until as number));
    }
    if (q.siteId !== undefined) {
      out = out.filter((r) => r.siteId === q.siteId);
    }
    if (q.classes !== undefined && q.classes.length > 0) {
      const set = new Set(q.classes);
      out = out.filter(
        (r) => r.agentClass !== undefined && set.has(r.agentClass),
      );
    }
    if (q.outcome !== undefined) {
      out = out.filter((r) => r.outcome === q.outcome);
    }
    if (q.agentFamily !== undefined) {
      out = out.filter((r) => r.agentFamily === q.agentFamily);
    }
    if (q.agentClass !== undefined) {
      out = out.filter((r) => r.agentClass === q.agentClass);
    }
    if (q.status !== undefined) {
      out = out.filter((r) => r.status === q.status);
    }
    if (q.path !== undefined) {
      out = out.filter((r) => r.path === q.path);
    }
    out = out.slice().reverse();
    // Offset then limit — the paginated drill-down's page cursor.
    const offset = q.offset !== undefined && q.offset > 0 ? q.offset : 0;
    if (offset > 0) {
      out = out.slice(offset);
    }
    if (q.limit !== undefined && q.limit >= 0) {
      out = out.slice(0, q.limit);
    }
    return out.map((r) => ({
      ...r,
      headers: r.headers.map((p) => [p[0], p[1]] as [string, string]),
    }));
  }

  async queryUnclassifiedAgentRequests(
    q: UnclassifiedAgentRequestQuery,
  ): Promise<AgentRequestRecord[]> {
    // pending (no version) OR classified under a different version. OLDEST-first
    // (insertion order) so the backfill pages forward deterministically.
    let out = this.agentRequests.filter(
      (r) =>
        r.rulesetVersion === undefined || r.rulesetVersion !== q.rulesetVersion,
    );
    if (q.siteId !== undefined) {
      out = out.filter((r) => r.siteId === q.siteId);
    }
    if (q.limit !== undefined && q.limit >= 0) {
      out = out.slice(0, q.limit);
    }
    return out.map((r) => ({
      ...r,
      headers: r.headers.map((p) => [p[0], p[1]] as [string, string]),
    }));
  }

  async updateAgentClassifications(
    updates: AgentClassificationUpdate[],
  ): Promise<void> {
    const byId = new Map(updates.map((u) => [u.id, u]));
    for (const r of this.agentRequests) {
      const u = r.id === undefined ? undefined : byId.get(r.id);
      if (!u) {
        continue;
      }
      if (u.agentFamily === null) {
        r.agentFamily = undefined;
      } else {
        r.agentFamily = u.agentFamily;
      }
      r.agentClass = u.agentClass;
      r.confidence = u.confidence;
      r.rulesetVersion = u.rulesetVersion;
    }
  }

  async aggregateAgentOutcomes(
    q: AgentRequestQuery = {},
  ): Promise<AgentOutcomeGroup[]> {
    let rows = this.agentRequests;
    if (q.since !== undefined) {
      rows = rows.filter((r) => r.ts >= (q.since as number));
    }
    if (q.until !== undefined) {
      rows = rows.filter((r) => r.ts < (q.until as number));
    }
    if (q.siteId !== undefined) {
      rows = rows.filter((r) => r.siteId === q.siteId);
    }
    // Same GROUP BY the SQL adapters run, done in JS: bounded low-cardinality keys.
    const groups = new Map<string, AgentOutcomeGroup>();
    for (const r of rows) {
      const family = r.agentFamily ?? null;
      const cls = r.agentClass ?? null;
      const served = r.served === true;
      const key = `${r.outcome} ${family} ${cls} ${r.method} ${served}`;
      const g = groups.get(key);
      if (g) {
        g.count += 1;
      } else {
        groups.set(key, {
          outcome: r.outcome,
          agentFamily: family,
          agentClass: cls,
          method: r.method,
          served,
          count: 1,
        });
      }
    }
    return [...groups.values()];
  }

  async aggregateAgentRoutes(
    q: AgentRequestQuery = {},
  ): Promise<AgentRouteGroup[]> {
    let rows = this.agentRequests;
    if (q.since !== undefined) {
      rows = rows.filter((r) => r.ts >= (q.since as number));
    }
    if (q.until !== undefined) {
      rows = rows.filter((r) => r.ts < (q.until as number));
    }
    if (q.siteId !== undefined) {
      rows = rows.filter((r) => r.siteId === q.siteId);
    }
    // Same GROUP BY path/outcome/family/served the SQL adapters run, in JS.
    const groups = new Map<string, AgentRouteGroup>();
    for (const r of rows) {
      const family = r.agentFamily ?? null;
      const served = r.served === true;
      const key = `${r.path} ${r.outcome} ${family} ${served}`;
      const g = groups.get(key);
      if (g) {
        g.count += 1;
      } else {
        groups.set(key, {
          path: r.path,
          outcome: r.outcome,
          agentFamily: family,
          served,
          count: 1,
        });
      }
    }
    return [...groups.values()];
  }

  async ensureAgentSite(site: AgentSiteRecord): Promise<AgentSiteRecord> {
    const existing = this.agentSites.get(site.id);
    if (existing) {
      return { ...existing };
    }
    this.agentSites.set(site.id, { ...site });
    return { ...site };
  }

  async prune(opts: PruneOptions): Promise<number> {
    let removed = 0;
    for (let i = this.agentRequests.length - 1; i >= 0; i--) {
      if ((this.agentRequests[i] as AgentRequestRecord).ts < opts.before) {
        this.agentRequests.splice(i, 1);
        removed++;
      }
    }
    return removed;
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
