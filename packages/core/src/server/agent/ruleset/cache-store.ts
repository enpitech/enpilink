/**
 * The PERSISTED-CACHE seam for the ruleset client (D2).
 *
 * The client warms instantly from a persisted cache on start (so a restart does
 * not wait on the network) and writes back every artifact it validates. WHERE
 * that cache lives is a runtime concern:
 *   - Node: on disk (see `./disk-cache.js`, `DiskRulesetCacheStore`).
 *   - Edge (D4/adapter territory): KV / the Cache API, shared across isolates so
 *     cold starts stay warm.
 *
 * This module is the runtime-NEUTRAL contract between them — a tiny async
 * key-value slot. It imports NOTHING (no `node:*`, no zod), so an edge adapter
 * can implement {@link RulesetCacheStore} against KV without pulling any Node
 * dependency into its bundle. D2 ships the interface + the Node disk store + a
 * no-op default; the edge KV store is D4's to add.
 *
 * The stored body is re-validated with `parseRuleset` on load — a corrupt or
 * tampered cache file never silently becomes the live ruleset.
 */

/** One persisted cache entry — the raw artifact plus the SWR bookkeeping. */
export interface CachedRuleset {
  /**
   * The raw ruleset object AS FETCHED (unvalidated JSON). Re-validated with
   * `parseRuleset` when the client loads it — never trusted blindly.
   */
  body: unknown;
  /** Epoch-ms when this artifact was fetched — the stale-while-revalidate clock. */
  fetchedAt: number;
  /**
   * The artifact's `Cache-Control: max-age` in seconds, or `null` if it carried
   * none. Persisted so the TTL survives a restart without a re-fetch.
   */
  maxAgeSeconds: number | null;
}

/** An async persisted slot for exactly one {@link CachedRuleset}. */
export interface RulesetCacheStore {
  /** Load the cached entry, or `null` when absent/unreadable (never throws). */
  load(): Promise<CachedRuleset | null>;
  /** Persist the entry, overwriting any previous one. May reject on I/O error. */
  save(entry: CachedRuleset): Promise<void>;
}

/**
 * A cache store that persists NOTHING — the default when no persistence is
 * wired. The client still works (it just always cold-fetches on start); useful
 * for tests and for a runtime with no durable store.
 */
export class NoopRulesetCacheStore implements RulesetCacheStore {
  async load(): Promise<CachedRuleset | null> {
    return null;
  }
  async save(): Promise<void> {
    // Intentionally nothing.
  }
}
