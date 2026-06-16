import { setActiveStorage } from "./log-sink.js";
import type { McpMiddlewareEntry, McpMiddlewareFn } from "./middleware.js";
import { seedMockData } from "./mock-seed.js";
import { resolveStorageAdapter } from "./storage/index.js";
import { MemoryStorageAdapter } from "./storage/memory.js";
import type { StorageAdapter } from "./storage/types.js";

/**
 * Analytics + log capture (M2). Opt-in, env-gated, zero overhead when off.
 *
 * When enabled, a single {@link StorageAdapter} is resolved + `init()`ed at
 * server startup and shared in-process: the analytics middleware writes
 * `tool_call` events to it, the log sink mirrors server logs to it, and (M3)
 * the observability API reads from the very same instance via the
 * `server.storage` getter or {@link getActiveStorage}.
 *
 * Gating: OFF unless `ENPILINK_ANALYTICS` is `1` or `true` (case-insensitive).
 * When OFF, no adapter is resolved or initialized (so no `enpilink.db` is
 * created), no middleware is registered, and there is zero network activity.
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

/**
 * Build the analytics middleware entry. Times each request around `next()`,
 * records a `tool_call`-typed event (capturing the tool name for `tools/call`),
 * and ALWAYS swallows storage errors so a storage failure can never break or
 * slow a tool call. Recording is fire-and-forget (non-blocking).
 */
export function createAnalyticsMiddleware(
  storage: StorageAdapter,
  now: () => number = Date.now,
): McpMiddlewareFn {
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
      const ms = now() - start;
      // Fire-and-forget; never block or throw into the request path.
      void recordSafely(storage, {
        ts: start,
        type: "tool_call",
        tool,
        method: request.method,
        ms,
        ok,
        error,
      });
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
 * Install analytics on a server, ONLY when enabled (`ENPILINK_ANALYTICS`).
 *
 * When enabled: resolves a {@link StorageAdapter} via `resolveStorageAdapter()`
 * (`ENPILINK_STORAGE` / `ENPILINK_DB_PATH`), `init()`s it, registers it as the
 * active storage for the log sink + `getActiveStorage()`, and returns the
 * built analytics middleware entry to splice into the chain.
 *
 * When disabled: resolves/initializes NOTHING and returns `null` — zero
 * overhead, zero network, no `enpilink.db` created.
 *
 * @returns the active storage + middleware entry, or `null` when disabled.
 */
export async function installAnalytics(
  opts: InstallAnalyticsOptions = {},
): Promise<{ storage: StorageAdapter; entry: McpMiddlewareEntry } | null> {
  // `--mock` (ENPILINK_MOCK) force-enables analytics for the session even when
  // the env-based gating is off, so demos work without setting both flags.
  const mock = mockEnabled();
  if (!mock && !analyticsEnabled()) {
    return null;
  }

  let storage: StorageAdapter;
  try {
    storage = resolveSessionStorage(mock);
    await storage.init();
  } catch (err) {
    // Never let an analytics/storage failure break server startup.
    console.error(
      "[enpilink] analytics disabled: storage init failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  setActiveStorage(storage);

  // In `--mock` mode, seed the in-memory storage with a deterministic demo
  // dataset so the Dashboard renders full immediately (no real traffic).
  // Determinism: a fixed seed + a base timestamp captured once here.
  if (mock) {
    const now = (opts.now ?? Date.now)();
    try {
      await seedMockData(storage, { now });
    } catch {
      // A seeding failure must never break server startup.
    }
  }

  const entry: McpMiddlewareEntry = {
    // "request" matches every (non-notification) request so non-tool methods
    // are counted too; the handler captures the tool name for tools/call.
    filter: "request",
    handler: createAnalyticsMiddleware(storage, opts.now),
  };

  return { storage, entry };
}
