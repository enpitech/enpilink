import type { RulesetCacheStore } from "./cache-store.js";
import { MemoryRulesetCacheStore } from "./edge-cache.js";
import type { Ruleset } from "./types.js";
import { safeParseRulesetEdge } from "./validate-edge.js";

/**
 * THE EDGE CACHED-RULESET CLIENT (D4b) — the zod-free counterpart of the D2
 * {@link import("./client.js").RulesetClient}.
 *
 * The Node client (`client.ts`) validates with `parseRuleset` (zod) and warms at
 * process boot, so it can never enter an edge bundle. This client is the edge
 * equivalent: it validates with the hand-written {@link safeParseRulesetEdge}
 * (zero zod), persists through an edge {@link RulesetCacheStore} (KV / Cache API /
 * memory), and — because an edge isolate has no boot hook — warms LAZILY from the
 * background driver instead of a `start()`.
 *
 * ── THE LATENCY LAW HOLDS THE SAME WAY (non-negotiable) ───────────────────────
 *   {@link getRuleset} is a synchronous field read — the hot path calls it and
 *   gets the currently-held ruleset (or `null` ⇒ `pending`) with ZERO I/O.
 *   {@link refreshInBackground} is the ONE method a request schedules, and it must
 *   be handed to `ctx.waitUntil()` / `event.waitUntil()` — NEVER awaited on the
 *   response path. It warms from the cache (once) and stale-while-revalidates from
 *   the network, entirely AFTER the response has been returned.
 *
 * ── NO BASELINE (the intended cold-isolate behaviour) ────────────────────────
 * A truly cold isolate with a cold cross-isolate cache serves its FIRST request
 * with `getRuleset() === null` → the record is captured `pending` (never a wrong
 * guess). The `waitUntil` warm then populates the ruleset from KV/Cache (or the
 * network), so every subsequent request on that isolate — and every isolate that
 * shares the KV/Cache — classifies. A malformed artifact DEGRADES (keeps the
 * last-good ruleset, or stays `pending`); it never throws into a request.
 *
 * Runtime-neutral + edge-safe: depends only on the global `fetch`/`AbortController`
 * plus injected seams. No `node:*`, no zod, no Express, no storage — asserted by
 * `next/edge-safety.test.ts`.
 */

/** The subset of `Response` the client reads (keeps mocking trivial). */
export interface EdgeFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/** The subset of `fetch` the client calls. Defaults to the global `fetch`. */
export type EdgeFetcher = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<EdgeFetchResponse>;

/** The phase an error occurred in (for the injected logger). */
export type EdgeRulesetErrorPhase = "fetch" | "validate" | "cache";

/** What changed when a ruleset became live (for observability / logging). */
export interface EdgeActivateMeta {
  /** Nothing was held before this — the very first ruleset on this isolate. */
  firstLoad: boolean;
  /** A DIFFERENT `version` replaced the previous one. */
  versionChanged: boolean;
  /** The version that was live before (or `null` on first load). */
  previousVersion: string | null;
  /** Where this artifact came from. */
  source: "network" | "cache";
}

/** Static config for the edge client (edge config comes from options/env, not a
 * DB gate — there is no config subsystem on the edge). */
export interface EdgeRulesetClientConfig {
  /** Master switch. `false` ⇒ never fetch (serve the cache only, or stay empty). */
  enabled: boolean;
  /** The artifact URL. */
  url: string;
  /** TTL override in seconds; `0`/absent ⇒ honor the artifact's `Cache-Control`. */
  ttlSeconds?: number;
  /** Hard fetch timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** `live` = long/central TTL; `dev` = short TTL for testing signatures. */
  mode?: "live" | "dev";
}

/** Options for {@link EdgeRulesetClient}. */
export interface EdgeRulesetClientOptions extends EdgeRulesetClientConfig {
  /** Persisted cache seam. Defaults to {@link MemoryRulesetCacheStore}. */
  cacheStore?: RulesetCacheStore;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: EdgeFetcher;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable error sink. Defaults to swallowing (the core never logs itself). */
  onError?: (err: unknown, phase: EdgeRulesetErrorPhase) => void;
  /** Called after a first-load / version-change activation (off the hot path). */
  onActivate?: (ruleset: Ruleset, meta: EdgeActivateMeta) => void;
}

/** Short fixed TTL in `dev` mode — pick up a new signature within seconds. */
const DEV_TTL_MS = 5_000;
/** Fallback TTL in `live` mode when the artifact carries no `Cache-Control`. */
const DEFAULT_LIVE_TTL_MS = 60 * 60 * 1000;
/** Floor on any success TTL, so a `max-age: 0` artifact can't spin a tight loop. */
const MIN_TTL_MS = 1_000;
/** Retry floor after a FAILED refresh in `live` / `dev` mode (basic backoff). */
const LIVE_RETRY_MS = 30_000;
const DEV_RETRY_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Parse `max-age=<n>` (seconds) from a `Cache-Control` value, or `null`. Mirrors
 * `client.ts`'s `parseMaxAge` (re-implemented here so the edge never imports the
 * zod-tainted `client.ts`). */
export function parseMaxAgeEdge(cacheControl: string | null): number | null {
  if (!cacheControl) {
    return null;
  }
  if (/\bno-(store|cache)\b/i.test(cacheControl)) {
    return 0;
  }
  const m = /\bmax-age\s*=\s*(\d+)/i.exec(cacheControl);
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The default fetcher — the global `fetch`, adapted to {@link EdgeFetcher}. */
const defaultFetcher: EdgeFetcher = (url, init) =>
  fetch(url, init) as unknown as Promise<EdgeFetchResponse>;

export class EdgeRulesetClient {
  private readonly enabled: boolean;
  private readonly url: string;
  private readonly ttlSeconds: number;
  private readonly timeoutMs: number;
  private readonly mode: "live" | "dev";
  private readonly cacheStore: RulesetCacheStore;
  private readonly fetchImpl: EdgeFetcher;
  private readonly now: () => number;
  private readonly onError: (
    err: unknown,
    phase: EdgeRulesetErrorPhase,
  ) => void;
  private readonly onActivate: (
    ruleset: Ruleset,
    meta: EdgeActivateMeta,
  ) => void;

  /** The currently-held, validated ruleset — the SWR "serve this" value. */
  private current: Ruleset | null = null;
  private currentSource: "network" | "cache" | null = null;
  private fetchedAt = 0;
  private maxAgeSeconds: number | null = null;
  private nextAllowedAt = 0;
  /** Whether the one-time cache warm has been attempted. */
  private warmed = false;
  /** Single-flight guard — the in-progress background tick, or `null`. */
  private inflight: Promise<void> | null = null;

  constructor(options: EdgeRulesetClientOptions) {
    this.enabled = options.enabled;
    this.url = options.url;
    this.ttlSeconds = options.ttlSeconds ?? 0;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.mode = options.mode ?? "live";
    this.cacheStore = options.cacheStore ?? new MemoryRulesetCacheStore();
    this.fetchImpl = options.fetchImpl ?? defaultFetcher;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
    this.onActivate = options.onActivate ?? (() => {});
  }

  /**
   * The held ruleset, or `null` when none has loaded. SYNCHRONOUS + cheap — this
   * is what the capture/serve path reads on the hot path. Never does I/O.
   */
  getRuleset(): Ruleset | null {
    return this.current;
  }

  /** A cheap synchronous read of the live ruleset state (for logging / a status
   * beacon). Never does I/O. */
  getStatus(): {
    version: string | null;
    fetchedAt: number | null;
    source: "network" | "cache" | null;
  } {
    return {
      version: this.current?.version ?? null,
      fetchedAt: this.current ? this.fetchedAt : null,
      source: this.current ? this.currentSource : null,
    };
  }

  /**
   * The background driver — warm from the cache (once) + stale-while-revalidate
   * from the network. **Hand this to `waitUntil()`; NEVER await it on the response
   * path.** Single-flighted (concurrent requests in a warm isolate share one
   * tick) and total (never throws). A no-op refresh when the held ruleset is still
   * fresh.
   */
  refreshInBackground(): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.tick().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async tick(): Promise<void> {
    // (a) Warm from the cross-isolate cache ONCE per isolate — instant vs a cold
    // fetch, and shared across isolates (KV/Cache API). A corrupt entry is
    // re-validated here and ignored, never trusted blindly.
    if (!this.warmed) {
      this.warmed = true;
      try {
        const cached = await this.cacheStore.load();
        if (cached && this.current === null) {
          const parsed = safeParseRulesetEdge(cached.body);
          if (parsed.ok) {
            this.activate(
              parsed.ruleset,
              cached.fetchedAt,
              cached.maxAgeSeconds,
              "cache",
            );
            this.nextAllowedAt =
              cached.fetchedAt + this.effectiveTtlMs(cached.maxAgeSeconds);
          } else {
            this.onError(parsed.error, "validate");
          }
        }
      } catch (err) {
        this.onError(err, "cache");
      }
    }
    // (b) Network refresh when enabled and the held ruleset is stale/empty.
    if (!this.enabled) {
      return;
    }
    if (this.current !== null && this.now() < this.nextAllowedAt) {
      return;
    }
    await this.doFetch();
  }

  private async doFetch(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`ruleset fetch failed: HTTP ${res.status}`);
      }
      const maxAge = parseMaxAgeEdge(res.headers.get("cache-control"));
      const body = await res.json();
      // VALIDATE (zod-free) before use — a corrupt artifact never becomes live;
      // we keep the last-good ruleset and back off.
      const parsed = safeParseRulesetEdge(body);
      if (!parsed.ok) {
        this.onError(parsed.error, "validate");
        this.nextAllowedAt = this.now() + this.retryFloorMs();
        return;
      }
      this.activate(parsed.ruleset, this.now(), maxAge, "network");
      this.nextAllowedAt = this.now() + this.effectiveTtlMs(maxAge);
      // Persist the RAW body for a warm cold-isolate. Best-effort.
      try {
        await this.cacheStore.save({
          body,
          fetchedAt: this.fetchedAt,
          maxAgeSeconds: maxAge,
        });
      } catch (err) {
        this.onError(err, "cache");
      }
    } catch (err) {
      this.onError(err, "fetch");
      this.nextAllowedAt = this.now() + this.retryFloorMs();
    } finally {
      clearTimeout(timer);
    }
  }

  private activate(
    rs: Ruleset,
    fetchedAt: number,
    maxAge: number | null,
    source: "network" | "cache",
  ): void {
    const previousVersion = this.current?.version ?? null;
    const firstLoad = this.current === null;
    const versionChanged =
      previousVersion !== null && previousVersion !== rs.version;
    this.current = rs;
    this.currentSource = source;
    this.fetchedAt = fetchedAt;
    this.maxAgeSeconds = maxAge;
    if (firstLoad || versionChanged) {
      this.onActivate(rs, {
        firstLoad,
        versionChanged,
        previousVersion,
        source,
      });
    }
  }

  private effectiveTtlMs(maxAge: number | null): number {
    let ttl: number;
    if (this.mode === "dev") {
      ttl = DEV_TTL_MS;
    } else if (this.ttlSeconds > 0) {
      ttl = this.ttlSeconds * 1000;
    } else if (maxAge !== null) {
      ttl = maxAge * 1000;
    } else {
      ttl = DEFAULT_LIVE_TTL_MS;
    }
    return Math.max(ttl, MIN_TTL_MS);
  }

  private retryFloorMs(): number {
    return this.mode === "dev" ? DEV_RETRY_MS : LIVE_RETRY_MS;
  }
}
