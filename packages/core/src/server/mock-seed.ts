import type {
  AnalyticsEvent,
  LogEntry,
  StorageAdapter,
} from "./storage/types.js";

/**
 * Mock demo seed (MD). Populates a {@link StorageAdapter} with a realistic,
 * clearly-labelled spread of demo analytics so the observability Dashboard
 * renders full and good-looking immediately — for demos and screenshots, with
 * NO real traffic.
 *
 * Determinism is a hard requirement: given the same `seed` + the same base
 * timestamp (`now`), {@link generateMockEvents} / {@link generateMockLogs}
 * produce byte-identical output every run. There is NO `Math.random()` and NO
 * `Date.now()` drift — the only randomness comes from the seeded
 * {@link mulberry32} PRNG, and every timestamp is derived from the injected
 * base. This keeps screenshots reproducible across runs and machines.
 *
 * This is opt-in only (wired to `enpilink dev --mock` / `ENPILINK_MOCK`); it is
 * never invoked on a normal dev/prod run.
 */

/**
 * `mulberry32` — a tiny, fast, well-distributed 32-bit PRNG. Pure function of
 * its seed: same seed → same sequence. Returns a generator producing floats in
 * `[0, 1)`. Used for ALL "randomness" in the mock seed so output is fully
 * deterministic.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default seed for the demo dataset (arbitrary fixed constant). */
export const MOCK_SEED = 0x5eed1234;

/** A demo tool: name, MCP method, baseline latency, and a relative error rate. */
interface MockTool {
  tool: string;
  method: string;
  /** Baseline latency in ms (the distribution is built around this). */
  baseMs: number;
  /** Fraction of calls that error, in `[0, 1]`. */
  errorRate: number;
  /** Relative call-volume weight (higher → more calls). */
  weight: number;
}

/**
 * A curated, realistic spread of demo tools — varied names, latencies (fast
 * lookups → slow LLM/search calls), and a sensible error rate per tool. Fixed
 * data, no randomness, so the shape of the dashboard is stable.
 */
const MOCK_TOOLS: MockTool[] = [
  {
    tool: "search_documents",
    method: "tools/call",
    baseMs: 180,
    errorRate: 0.04,
    weight: 9,
  },
  {
    tool: "get_weather",
    method: "tools/call",
    baseMs: 90,
    errorRate: 0.02,
    weight: 7,
  },
  {
    tool: "create_invoice",
    method: "tools/call",
    baseMs: 320,
    errorRate: 0.08,
    weight: 5,
  },
  {
    tool: "send_email",
    method: "tools/call",
    baseMs: 240,
    errorRate: 0.11,
    weight: 4,
  },
  {
    tool: "summarize_text",
    method: "tools/call",
    baseMs: 1100,
    errorRate: 0.06,
    weight: 6,
  },
  {
    tool: "list_customers",
    method: "tools/call",
    baseMs: 60,
    errorRate: 0.01,
    weight: 8,
  },
  {
    tool: "run_report",
    method: "tools/call",
    baseMs: 1700,
    errorRate: 0.13,
    weight: 3,
  },
  {
    tool: "translate",
    method: "tools/call",
    baseMs: 420,
    errorRate: 0.05,
    weight: 5,
  },
  {
    tool: undefined as unknown as string,
    method: "tools/list",
    baseMs: 8,
    errorRate: 0.0,
    weight: 6,
  },
  {
    tool: undefined as unknown as string,
    method: "initialize",
    baseMs: 4,
    errorRate: 0.0,
    weight: 4,
  },
];

/** Demo log messages, paired with a level, for the live-log feed. */
const MOCK_LOGS: Array<{ level: LogEntry["level"]; msg: string }> = [
  { level: "info", msg: "MCP server ready — accepting tool calls" },
  { level: "info", msg: "search_documents: indexed 1,284 documents" },
  { level: "debug", msg: "cache hit for get_weather(region=eu-west)" },
  { level: "info", msg: "create_invoice: invoice #INV-4821 generated" },
  {
    level: "warning",
    msg: "send_email: rate limit approaching (87% of quota)",
  },
  { level: "info", msg: "summarize_text: 4,096 tokens → 312 tokens" },
  {
    level: "error",
    msg: "run_report: upstream timeout after 5000ms, retrying",
  },
  { level: "info", msg: "translate: en → ja (confidence 0.97)" },
  { level: "debug", msg: "list_customers: page 3 of 12 served from replica" },
  {
    level: "warning",
    msg: "create_invoice: tax rate fallback used for region=unknown",
  },
  { level: "error", msg: "send_email: SMTP 421 service not available" },
  {
    level: "info",
    msg: "health check ok — storage=memory, analytics=on (demo)",
  },
];

/** Options for {@link generateMockEvents} / {@link seedMockData}. */
export interface MockSeedOptions {
  /**
   * The base "now" timestamp (epoch ms). All events are placed BEFORE this so
   * the dashboard's default trailing window shows them. Injected (never
   * `Date.now()`) so output is deterministic.
   */
  now: number;
  /** PRNG seed. Defaults to {@link MOCK_SEED}. */
  seed?: number;
  /** Number of `tool_call` events to generate. Defaults to 600. */
  count?: number;
  /** Time span the events are spread over, in ms. Defaults to ~10 days. */
  spanMs?: number;
}

const DEFAULT_COUNT = 600;
// Spread the demo events across ~10 days so the dashboard's default 7-day range
// (M9) looks full rather than sparse. Still deterministic (same seed+base →
// identical output) — only the time window widened, the count is unchanged.
const DEFAULT_SPAN_MS = 10 * 24 * 60 * 60 * 1000; // ~10 days

/**
 * Build a deterministic, weighted, time-ordered list of demo `tool_call`
 * events spanning `[now - spanMs, now]`. Latencies follow a per-tool
 * distribution (with an occasional heavy tail), and errors are injected at each
 * tool's configured rate. Pure function of `(now, seed, count, spanMs)`.
 */
export function generateMockEvents(opts: MockSeedOptions): AnalyticsEvent[] {
  const now = opts.now;
  const seed = opts.seed ?? MOCK_SEED;
  const count = opts.count ?? DEFAULT_COUNT;
  const spanMs = opts.spanMs ?? DEFAULT_SPAN_MS;
  const rand = mulberry32(seed);

  // Weighted pick table for tools.
  const totalWeight = MOCK_TOOLS.reduce((sum, t) => sum + t.weight, 0);

  const events: AnalyticsEvent[] = [];
  for (let i = 0; i < count; i++) {
    // Pick a tool by weight.
    let pick = rand() * totalWeight;
    let chosen = MOCK_TOOLS[0] as MockTool;
    for (const t of MOCK_TOOLS) {
      pick -= t.weight;
      if (pick <= 0) {
        chosen = t;
        break;
      }
    }

    // Spread events across the window with a slight rising trend toward `now`
    // (more recent activity), so the volume chart looks alive.
    const trend = (i / count) ** 0.85;
    const jitter = (rand() - 0.5) * (spanMs / count) * 8;
    const ts = Math.round(now - spanMs + trend * spanMs + jitter);
    const clampedTs = Math.min(now - 250, Math.max(now - spanMs, ts));

    // Latency: baseline ± lognormal-ish spread, with a rare heavy tail.
    const noise = 0.55 + rand() * 0.95; // 0.55x .. 1.5x
    const tail = rand() < 0.05 ? 2.4 + rand() * 2.2 : 1; // ~5% slow tail
    const ms = Math.max(1, Math.round(chosen.baseMs * noise * tail));

    const ok = rand() >= chosen.errorRate;

    events.push({
      ts: clampedTs,
      type: "tool_call",
      tool: chosen.tool,
      method: chosen.method,
      ms,
      ok,
      error: ok ? undefined : "demo error: simulated upstream failure",
      meta: { demo: true },
    });
  }

  // Storage adapters return most-recent-first; keep the seeded array
  // oldest-first for readability (recordEvent order doesn't matter).
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

/**
 * Build a deterministic list of demo log lines spread across the same window.
 * Pure function of `(now, seed)`.
 */
export function generateMockLogs(opts: MockSeedOptions): LogEntry[] {
  const now = opts.now;
  const seed = opts.seed ?? MOCK_SEED;
  const spanMs = opts.spanMs ?? DEFAULT_SPAN_MS;
  // Offset the seed so log jitter is independent of event jitter but still
  // fully deterministic.
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);

  const logs: LogEntry[] = [];
  const n = MOCK_LOGS.length;
  for (let i = 0; i < n; i++) {
    const entry = MOCK_LOGS[i] as { level: LogEntry["level"]; msg: string };
    const frac = (i + 1) / (n + 1);
    const jitter = (rand() - 0.5) * (spanMs / n);
    const ts = Math.round(now - spanMs + frac * spanMs + jitter);
    logs.push({
      ts: Math.min(now - 100, Math.max(now - spanMs, ts)),
      level: entry.level,
      msg: entry.msg,
      data: { demo: true },
    });
  }
  logs.sort((a, b) => a.ts - b.ts);
  return logs;
}

/**
 * Seed `storage` with the deterministic demo dataset. Records all generated
 * events + logs. Errors are swallowed per-write (a demo seed must never break
 * server startup). Idempotency is NOT guaranteed — call once at startup.
 */
export async function seedMockData(
  storage: StorageAdapter,
  opts: MockSeedOptions,
): Promise<{ events: number; logs: number }> {
  const events = generateMockEvents(opts);
  const logs = generateMockLogs(opts);

  for (const e of events) {
    try {
      await storage.recordEvent(e);
    } catch {
      // Demo seeding must never break startup.
    }
  }
  for (const l of logs) {
    try {
      await storage.appendLog(l);
    } catch {
      // Demo seeding must never break startup.
    }
  }
  return { events: events.length, logs: logs.length };
}
