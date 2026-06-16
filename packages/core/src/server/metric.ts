/**
 * Metrics are removed in enpilink. Upstream emitted a DogStatsD/UDP counter to
 * a hardcoded vendor IP for every tool call; that coupling is gone.
 *
 * The monitoring slot is now filled by the opt-in analytics installer in
 * `./analytics.ts` (`installAnalytics`), which records `tool_call` events to a
 * pluggable {@link StorageAdapter} — but ONLY when `ENPILINK_ANALYTICS` is set,
 * so the default remains zero monitoring middleware and zero network activity.
 *
 * This file is retained as a thin re-export for discoverability.
 */
export { installAnalytics } from "./analytics.js";
