import {
  type CaptureGate,
  getCaptureGate,
  refreshCaptureGate,
  setCaptureGate,
} from "./capture-gate.js";
import { getActiveStorage, setActiveStorage } from "./log-sink.js";
import type { McpMiddlewareEntry, McpMiddlewareFn } from "./middleware.js";
import { seedMockData } from "./mock-seed.js";
import { initOtel, type OtelSink } from "./otel.js";
import { resolveStorageAdapter } from "./storage/index.js";
import { MemoryStorageAdapter } from "./storage/memory.js";
import type { StorageAdapter } from "./storage/types.js";

/**
 * Analytics + log capture (M2) — now with a LIVE runtime toggle (bugfix).
 *
 * A single {@link StorageAdapter} is shared in-process: the analytics
 * middleware writes `tool_call` events to it, the log sink mirrors server logs
 * to it, and the observability/config APIs read from the very same instance via
 * the `server.storage` getter or {@link getActiveStorage}.
 *
 * Storage activation (so the Configuration + observability UI always has a
 * backing store) vs. capture gating (whether tool calls are recorded) are now
 * DECOUPLED:
 *
 * - **Storage** is activated whenever the admin/config UI is reachable: always
 *   in dev (default `memory`, honoring `ENPILINK_STORAGE`/`ENPILINK_DB_PATH`),
 *   and in prod-admin (handled separately in `admin.ts`). It reuses any already
 *   active adapter — never double-inits.
 * - **Capture** is governed at runtime by the resolved `analytics.enabled`
 *   config value (env > file > db > default) via the {@link CaptureGate}, so
 *   toggling it in the UI takes effect WITHOUT a restart. `ENPILINK_ANALYTICS`
 *   still works as an env override (env > db).
 *
 * The default `memory` adapter creates NO `enpilink.db` file and does zero
 * network; OTel stays independently gated and off by default.
 */

/** Options for {@link installAnalytics}. */
export interface InstallAnalyticsOptions {
  /**
   * Inject a clock for deterministic tests. Defaults to `Date.now`.
   */
  now?: () => number;
}

/**
 * Resolve a storage adapter for the session. In `--mock` mode we force an
 * in-memory adapter (the demo seed must never touch disk and must vanish on
 * exit); otherwise the configured `ENPILINK_STORAGE` adapter is used.
 */
function resolveSessionStorage(mock: boolean): StorageAdapter {
  return mock ? new MemoryStorageAdapter() : resolveStorageAdapter();
}

/** Whether the process is running in production (no dev admin plane). */
function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Truthy values that enable analytics via {@link analyticsEnabled}. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Whether analytics is enabled. OFF by default; enable with
 * `ENPILINK_ANALYTICS=1` (also accepts `true`/`yes`/`on`, case-insensitive).
 */
export function analyticsEnabled(): boolean {
  const raw = process.env.ENPILINK_ANALYTICS;
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Whether the `--mock` demo seed is enabled (`ENPILINK_MOCK`=1/true/yes/on).
 * Mock mode is opt-in only and IMPLIES analytics-on + in-memory storage for the
 * session, so the Dashboard renders full demo data with NO real traffic. It
 * NEVER touches disk and is never on by default.
 */
export function mockEnabled(): boolean {
  // The demo seed is DEV-ONLY: it must never seed a real deployment. In
  // production `ENPILINK_MOCK` is ignored entirely (read the literal so the
  // guard survives DCE and is unambiguous).
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  const raw = process.env.ENPILINK_MOCK;
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Extract the tool name from a `tools/call` request's params. Returns
 * `undefined` for non-`tools/call` methods or malformed params, never throws.
 */
function toolNameOf(
  method: string,
  params: Record<string, unknown>,
): string | undefined {
  if (method !== "tools/call") {
    return undefined;
  }
  const name = params?.name;
  return typeof name === "string" ? name : undefined;
}

/** Options controlling the live capture gate (injectable for tests). */
export interface AnalyticsMiddlewareOptions {
  /** Read the live capture gate. Defaults to the shared {@link getCaptureGate}. */
  gate?: () => CaptureGate;
  /** RNG for sampling `[0, 1)`. Defaults to `Math.random`. */
  rng?: () => number;
}

/**
 * Build the analytics middleware entry. Times each request around `next()`,
 * and — ONLY when the live capture gate says so — records a `tool_call`-typed
 * event (capturing the tool name for `tools/call`). Always swallows storage
 * errors so a storage failure can never break or slow a tool call. Recording is
 * fire-and-forget (non-blocking).
 *
 * The gate is a cheap, synchronous in-memory snapshot of the resolved
 * `analytics.enabled` / `analytics.sampleRate` config (see `capture-gate.ts`),
 * so toggling analytics in the UI takes effect live without a restart and the
 * hot path does no DB read. `next()` is ALWAYS awaited so the tool call runs
 * identically whether capture is on or off; only the record/export at the end is
 * gated.
 */
export function createAnalyticsMiddleware(
  storage: StorageAdapter,
  now: () => number = Date.now,
  otel: OtelSink | null = null,
  opts: AnalyticsMiddlewareOptions = {},
): McpMiddlewareFn {
  const readGate = opts.gate ?? getCaptureGate;
  const rng = opts.rng ?? Math.random;
  return async (request, _extra, next) => {
    const start = now();
    const tool = toolNameOf(request.method, request.params);
    let ok = true;
    let error: string | undefined;

    try {
      const result = await next();
      // A tool result with `isError: true` is a soft (handled) failure.
      if (
        result &&
        typeof result === "object" &&
        (result as { isError?: unknown }).isError === true
      ) {
        ok = false;
      }
      return result;
    } catch (err) {
      // Record the failure, then rethrow so behavior is unchanged.
      ok = false;
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // Live gate: skip recording entirely when analytics is off, or when this
      // call falls outside the sample rate. Cheap + synchronous + never throws.
      const { enabled, sampleRate } = readGate();
      const sampled = sampleRate >= 1 || (sampleRate > 0 && rng() < sampleRate);
      if (enabled && sampled) {
        const ms = now() - start;
        const event = {
          ts: start,
          type: "tool_call",
          tool,
          method: request.method,
          ms,
          ok,
          error,
        } as const;
        // Fire-and-forget; never block or throw into the request path.
        void recordSafely(storage, event);
        // Optional OTel export — guarded, synchronous, error-swallowing.
        if (otel) {
          try {
            otel.record(event);
          } catch {
            // OTel export must never break or slow a tool call.
          }
        }
      }
    }
  };
}

/** Record an event, swallowing any storage error. */
async function recordSafely(
  storage: StorageAdapter,
  event: Parameters<StorageAdapter["recordEvent"]>[0],
): Promise<void> {
  try {
    await storage.recordEvent(event);
  } catch {
    // A storage failure must never break or slow a tool call.
  }
}

/**
 * Install analytics on a server.
 *
 * STORAGE activation (decoupled from capture):
 * - Reuse any already-active adapter ({@link getActiveStorage}) — never
 *   double-init.
 * - In `--mock` mode, force a fresh in-memory adapter and seed it.
 * - Otherwise, in DEV activate the configured adapter (default `memory`,
 *   honoring `ENPILINK_STORAGE` / `ENPILINK_DB_PATH`) so the Configuration +
 *   observability UI always has a backing store — removing the "no active
 *   storage" 409 on the first config write. `memory` creates NO file and does
 *   zero network.
 * - In PRODUCTION WITHOUT mock, activate NOTHING here (the config UI isn't
 *   reachable; prod-admin activates its own store in `admin.ts`). This preserves
 *   the "no db / no network when off in prod" guarantee.
 *
 * CAPTURE gating: the returned middleware records events only when the live
 * {@link CaptureGate} (resolved `analytics.enabled`/`analytics.sampleRate`, env
 * > file > db > default) allows it — so the toggle is live (no restart). The
 * gate is resolved once here and refreshed on config writes by the router. In
 * `--mock` mode capture is force-enabled for the session.
 *
 * @returns the active storage + middleware entry + otel sink, or `null` when no
 * storage was activated (prod without mock/admin) — zero overhead, no file, no
 * network, no middleware.
 */
export async function installAnalytics(
  opts: InstallAnalyticsOptions = {},
): Promise<{
  storage: StorageAdapter;
  entry: McpMiddlewareEntry;
  otel: OtelSink | null;
} | null> {
  // `--mock` (ENPILINK_MOCK) force-enables capture for the session and uses a
  // throwaway in-memory store so demos work with no real traffic and no disk.
  const mock = mockEnabled();

  // Reuse an already-active adapter if one exists (e.g. set elsewhere); never
  // double-init. Otherwise decide whether to activate one.
  let storage = getActiveStorage();
  let ownedHere = false;
  if (!storage) {
    // In prod we don't activate storage here UNLESS analytics is explicitly
    // enabled via env (the historical M2 behavior — capture to a resolved
    // store). Otherwise the config UI isn't reachable (prod-admin handles its
    // own store), so activating nothing preserves the "no db / no network when
    // off" guarantee. In dev (or mock) we always activate so the UI works.
    if (!mock && isProduction() && !analyticsEnabled()) {
      return null;
    }
    try {
      storage = resolveSessionStorage(mock);
      await storage.init();
      ownedHere = true;
    } catch (err) {
      // Never let a storage failure break server startup.
      console.error(
        "[enpilink] analytics storage init failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    setActiveStorage(storage);
  }

  // In `--mock` mode, seed the (in-memory) storage with a deterministic demo
  // dataset so the Dashboard renders full immediately (no real traffic).
  // Determinism: a fixed seed + a base timestamp captured once here. Only seed a
  // store we just created here, never an adopted/pre-existing one.
  if (mock && ownedHere) {
    const now = (opts.now ?? Date.now)();
    try {
      await seedMockData(storage, { now });
    } catch {
      // A seeding failure must never break server startup.
    }
  }

  // Initialize the live capture gate. `--mock` force-enables capture for the
  // session (full sample); otherwise resolve from env/file/db/default so the UI
  // toggle (and any env override) governs capture live.
  if (mock) {
    setCaptureGate({ enabled: true, sampleRate: 1 });
  } else {
    await refreshCaptureGate();
  }

  // Optional OTel export (M6): off by default, zero network/imports when unset.
  // Mock mode never exports (it's dev-only demo data); requires the explicit env
  // opt-in.
  const otel = mock ? null : await initOtel();

  const entry: McpMiddlewareEntry = {
    // "request" matches every (non-notification) request so non-tool methods
    // are counted too; the handler captures the tool name for tools/call.
    filter: "request",
    handler: createAnalyticsMiddleware(storage, opts.now, otel),
  };

  return { storage, entry, otel };
}
