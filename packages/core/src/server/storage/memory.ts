import type {
  AnalyticsEvent,
  ConfigAuditEntry,
  EventQuery,
  LogEntry,
  LogQuery,
  StorageAdapter,
  StorageAdapterOptions,
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

  async allConfig(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.config);
  }

  async getConfigAudit(): Promise<ConfigAuditEntry[]> {
    // Stored oldest-first; return most-recent-first to match the interface.
    return this.audit.map((a) => ({ ...a })).reverse();
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
