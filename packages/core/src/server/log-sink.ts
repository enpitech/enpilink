import type { LogEntry, StorageAdapter } from "./storage/types.js";

/**
 * Log capture sink (M2) + shared active-storage holder.
 *
 * The module keeps a single process-wide reference to the active
 * {@link StorageAdapter} (set by `installAnalytics` at startup, cleared on
 * shutdown). This is the in-process handoff the observability API (M3) reads
 * from — see {@link getActiveStorage} and the `McpServer.storage` getter.
 *
 * {@link serverLog} is the minimal, surgical logging hook the framework uses to
 * mirror its own logs to storage IN ADDITION to printing them. It is cheap,
 * async (fire-and-forget), and error-swallowing — log capture must never break
 * or slow the server, and when analytics is OFF there is no active storage so
 * it is a plain `console.*` call with no extra cost.
 */

let activeStorage: StorageAdapter | null = null;

/** Set the active storage instance (called by `installAnalytics`). */
export function setActiveStorage(storage: StorageAdapter | null): void {
  activeStorage = storage;
}

/**
 * The active {@link StorageAdapter} for this process, or `null` when analytics
 * is disabled / before startup. M3's observability API should read from this
 * (or the equivalent `server.storage` getter) so it sees exactly the data the
 * server writes.
 */
export function getActiveStorage(): StorageAdapter | null {
  return activeStorage;
}

/** Map a log level to the name of the `console` method to print with. */
const CONSOLE_METHOD: Record<
  LogEntry["level"],
  "debug" | "info" | "warn" | "error"
> = {
  debug: "debug",
  info: "info",
  warning: "warn",
  error: "error",
};

/**
 * The framework's server-log hook. Prints to the console as usual AND, when an
 * active storage is set, mirrors the line to `storage.appendLog` without
 * blocking and swallowing any error.
 */
export function serverLog(
  level: LogEntry["level"],
  msg: string,
  data?: unknown,
): void {
  // Resolve the console method by name at call time so test spies / runtime
  // console replacements are honored (binding the ref at module init would not).
  const method = CONSOLE_METHOD[level] ?? "log";
  if (data !== undefined) {
    console[method](msg, data);
  } else {
    console[method](msg);
  }

  const storage = activeStorage;
  if (!storage) {
    return;
  }
  // Fire-and-forget; never block the caller; never throw.
  void appendSafely(storage, { ts: Date.now(), level, msg, data });
}

async function appendSafely(
  storage: StorageAdapter,
  entry: LogEntry,
): Promise<void> {
  try {
    await storage.appendLog(entry);
  } catch {
    // Log capture must never break or slow the server.
  }
}
