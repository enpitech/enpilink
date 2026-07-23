// TYPE-ONLY (erased): implements the D2 persistence seam without importing its
// runtime (`NoopRulesetCacheStore` is a value, so we take only the interface).
import type { CachedRuleset, RulesetCacheStore } from "./cache-store.js";

/**
 * THE EDGE PERSISTED-CACHE stores (D4b) — the KV / Cache-API implementations of
 * the D2 {@link RulesetCacheStore} seam that D2 left deferred ("edge KV/Cache-API
 * persistence is DEFERRED to D4").
 *
 * A warm edge isolate keeps the fetched ruleset in the client's in-memory field;
 * these stores make a COLD isolate warm WITHOUT a re-fetch by persisting the
 * validated artifact in a durable, cross-isolate slot:
 *   - {@link KVRulesetCacheStore} — Cloudflare KV (the recommended CF-native path;
 *     also the template for Vercel KV / Deno KV, which match {@link EdgeKvLike}).
 *   - {@link CacheApiRulesetCacheStore} — the Web `Cache` API (`caches.default` on
 *     Workers), for a deploy with no KV binding.
 *   - {@link MemoryRulesetCacheStore} — an in-isolate slot (no cross-isolate
 *     warmth), the safe default when neither a KV nor a Cache is wired.
 *
 * Every store is ZOD-FREE and imports nothing at runtime (the seam is type-only),
 * so it never pulls a Node dependency into an edge bundle — asserted by
 * `next/edge-safety.test.ts`. The stored body is UNVALIDATED JSON; the edge client
 * re-validates it with `parseRulesetEdge` before it goes live (a corrupt or
 * tampered cache entry can never silently become the live ruleset), so these
 * stores only need to be structurally defensive about the ENVELOPE.
 */

/** The default cross-isolate cache key / synthetic URL (schema major = v1). */
const DEFAULT_KEY = "enpilink:agent:ruleset:v1";
const DEFAULT_CACHE_URL = "https://enpilink.internal/agent/ruleset/v1";
/** Default `Cache-Control` max-age on the synthetic Cache-API entry (1 day). It
 * governs the Cache API's own eviction, NOT ruleset freshness (the client's
 * `fetchedAt` + the artifact's `max-age` drive stale-while-revalidate). */
const DEFAULT_CACHE_MAX_AGE_SECONDS = 86_400;

/**
 * Re-shape a parsed cache envelope into a {@link CachedRuleset}, tolerating a
 * malformed/legacy entry (missing bookkeeping → safe defaults; wrong shape →
 * `null` ⇒ a cold fetch). Never throws. The `body` is passed through UNVALIDATED
 * — the client validates it.
 */
function coerceEntry(parsed: unknown): CachedRuleset | null {
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("body" in parsed) ||
    !("fetchedAt" in parsed)
  ) {
    return null;
  }
  const entry = parsed as Record<string, unknown>;
  const fetchedAt = typeof entry.fetchedAt === "number" ? entry.fetchedAt : 0;
  const maxAgeSeconds =
    typeof entry.maxAgeSeconds === "number" ? entry.maxAgeSeconds : null;
  return { body: entry.body, fetchedAt, maxAgeSeconds };
}

/**
 * The minimal KV surface this store needs — a subset of a Cloudflare
 * `KVNamespace`. Structural, so no `@cloudflare/workers-types` dependency is
 * pulled into the bundle, and Vercel KV / a Deno-KV wrapper can satisfy it with a
 * ~5-line adapter (the "thin variant" the brief asks for).
 */
export interface EdgeKvLike {
  /** Read a text value, or `null` when absent. */
  get(key: string, options?: { type?: "text" }): Promise<string | null>;
  /** Write a text value, optionally with a KV expiry (seconds). */
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

/** Options for {@link KVRulesetCacheStore}. */
export interface KVRulesetCacheStoreOptions {
  /** The KV namespace binding (e.g. a Worker's `env.RULESET_KV`). */
  kv: EdgeKvLike;
  /** The key to store the entry under. Default {@link DEFAULT_KEY}. */
  key?: string;
  /**
   * Optional KV `expirationTtl` (seconds) — a hard eviction floor. Left UNSET by
   * default: freshness is governed by the client's stale-while-revalidate clock,
   * not KV expiry, and Cloudflare KV rejects a TTL below 60s. Set it only as a
   * belt-and-braces cap on how long a truly-idle site keeps a stale entry.
   */
  expirationTtlSeconds?: number;
}

/**
 * A {@link RulesetCacheStore} over Cloudflare KV (or any {@link EdgeKvLike}). The
 * recommended cross-isolate warm cache for a CF-native deploy: one shared KV read
 * warms every cold isolate instead of each one re-fetching the CDN.
 */
export class KVRulesetCacheStore implements RulesetCacheStore {
  private readonly kv: EdgeKvLike;
  private readonly key: string;
  private readonly expirationTtlSeconds: number | undefined;

  constructor(opts: KVRulesetCacheStoreOptions) {
    this.kv = opts.kv;
    this.key = opts.key ?? DEFAULT_KEY;
    this.expirationTtlSeconds = opts.expirationTtlSeconds;
  }

  async load(): Promise<CachedRuleset | null> {
    try {
      const raw = await this.kv.get(this.key, { type: "text" });
      if (!raw) {
        return null;
      }
      return coerceEntry(JSON.parse(raw) as unknown);
    } catch {
      // Unreadable / malformed KV value → treat as no cache (cold fetch).
      return null;
    }
  }

  async save(entry: CachedRuleset): Promise<void> {
    const body = JSON.stringify(entry);
    if (this.expirationTtlSeconds !== undefined) {
      await this.kv.put(this.key, body, {
        expirationTtl: this.expirationTtlSeconds,
      });
    } else {
      await this.kv.put(this.key, body);
    }
  }
}

/**
 * The minimal Web `Cache` surface this store needs — a subset of the standard
 * `Cache` interface (`caches.default` on Cloudflare Workers). Structural, so no
 * runtime types dependency. Keyed by a synthetic in-namespace URL.
 */
export interface EdgeCacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** Options for {@link CacheApiRulesetCacheStore}. */
export interface CacheApiRulesetCacheStoreOptions {
  /** The cache instance (e.g. `caches.default`). */
  cache: EdgeCacheLike;
  /** The synthetic key URL. Default {@link DEFAULT_CACHE_URL}. */
  cacheUrl?: string;
  /** `Cache-Control` max-age on the stored entry. Default 1 day. */
  maxAgeSeconds?: number;
}

/**
 * A {@link RulesetCacheStore} over the Web `Cache` API — for a Worker/edge deploy
 * with no KV binding. Stores the entry as a synthetic JSON `Response` under an
 * in-namespace URL. Cross-isolate on Cloudflare (the Cache API is colo-shared);
 * effectively per-isolate elsewhere (still better than a cold fetch every time).
 */
export class CacheApiRulesetCacheStore implements RulesetCacheStore {
  private readonly cache: EdgeCacheLike;
  private readonly cacheUrl: string;
  private readonly maxAgeSeconds: number;

  constructor(opts: CacheApiRulesetCacheStoreOptions) {
    this.cache = opts.cache;
    this.cacheUrl = opts.cacheUrl ?? DEFAULT_CACHE_URL;
    this.maxAgeSeconds = opts.maxAgeSeconds ?? DEFAULT_CACHE_MAX_AGE_SECONDS;
  }

  async load(): Promise<CachedRuleset | null> {
    try {
      const res = await this.cache.match(new Request(this.cacheUrl));
      if (!res) {
        return null;
      }
      return coerceEntry((await res.json()) as unknown);
    } catch {
      return null;
    }
  }

  async save(entry: CachedRuleset): Promise<void> {
    const res = new Response(JSON.stringify(entry), {
      headers: {
        "content-type": "application/json",
        "cache-control": `max-age=${this.maxAgeSeconds}`,
      },
    });
    await this.cache.put(new Request(this.cacheUrl), res);
  }
}

/**
 * An in-isolate {@link RulesetCacheStore} — a single field, no cross-isolate
 * durability. The safe default when neither a KV nor a Cache is wired: a warm
 * isolate still avoids re-fetching, and a cold isolate simply cold-fetches (then
 * classifies `pending` for its first request — the intended no-baseline default).
 */
export class MemoryRulesetCacheStore implements RulesetCacheStore {
  private entry: CachedRuleset | null = null;

  async load(): Promise<CachedRuleset | null> {
    return this.entry;
  }

  async save(entry: CachedRuleset): Promise<void> {
    this.entry = entry;
  }
}
