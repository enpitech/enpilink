import type { CachedRuleset, RulesetCacheStore } from "./cache-store.js";
import { NoopRulesetCacheStore } from "./cache-store.js";
import { parseRuleset, RulesetValidationError } from "./schema.js";
import type { Ruleset } from "./types.js";

/**
 * THE CACHED RULESET CLIENT (D2) — the runtime-neutral core.
 *
 * It fetches the detection ruleset from a configurable URL, validates every
 * artifact against the schema (`parseRuleset`), and serves it stale-while-
 * revalidate. Its ONE non-negotiable guarantee:
 *
 *   ── THE RESPONSE PATH NEVER AWAITS A FETCH. ──
 *
 * How that holds, structurally:
 *   - {@link getRuleset} is a synchronous field read — the classifier calls it
 *     and gets whatever is currently held (or `null` → `pending`) with zero I/O.
 *   - {@link maybeRefresh} is the only trigger a hot path invokes; it does a
 *     couple of cheap comparisons and, at most, `void`s a background refresh. It
 *     returns immediately and NEVER awaits {@link refresh}.
 *   - {@link refresh} (the actual fetch+validate+swap) is single-flighted and
 *     only ever `await`ed by tests / an explicit background caller — never by a
 *     request.
 * So a deliberately slow or hanging fetch cannot delay classification: the held
 * ruleset (last-good, or empty) is served the entire time, and the new one is
 * swapped in only once it has fetched AND validated.
 *
 * Runtime-neutral: it depends only on the global `fetch`/`AbortController`
 * (present on Node ≥ 18 and every edge runtime) plus injected seams — the
 * persisted cache ({@link RulesetCacheStore}) and the activation callback
 * ({@link RulesetClientOptions.onActivate}, where Node wires the holder +
 * backfill). It DOES use `parseRuleset` (zod), so it is NOT edge-bundle-safe and
 * must never be imported from the `enpilink/next` edge entry — the edge path is
 * handed a ruleset value directly (see `agent/next/index.ts`). A future edge
 * adapter (D4) can reuse this core by supplying a KV-backed cache store; the
 * zod dependency is the only thing keeping it Node-side for now.
 */

/** The subset of `Response` the client reads (keeps mocking trivial). */
export interface RulesetFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/** The subset of `fetch` the client calls. Defaults to the global `fetch`. */
export type RulesetFetcher = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<RulesetFetchResponse>;

/** Live client config — read fresh each time (so a dashboard edit takes effect). */
export interface RulesetClientConfig {
  /** Master switch. `false` ⇒ never fetch (serve on-disk cache only, or empty). */
  enabled: boolean;
  /** The artifact URL. */
  url: string;
  /** TTL override in seconds; `0` ⇒ honor the artifact's `Cache-Control`. */
  ttlSeconds: number;
  /** Hard fetch timeout in ms. */
  timeoutMs: number;
  /** `live` = long/central TTL; `dev` = short TTL for testing signatures. */
  mode: "live" | "dev";
}

/** What changed when a ruleset became live — drives the holder swap + backfill. */
export interface ActivateMeta {
  /** The holder was empty before this — the very first ruleset. */
  firstLoad: boolean;
  /** A DIFFERENT `version` replaced the previous one (backfill must re-run). */
  versionChanged: boolean;
  /** The version that was live before (or `null` on first load). */
  previousVersion: string | null;
  /** Where this artifact came from. */
  source: "network" | "cache";
}

/** The phase an error occurred in (for the injected logger). */
export type RulesetErrorPhase = "fetch" | "validate" | "cache";

/** Options for {@link RulesetClient}. */
export interface RulesetClientOptions {
  /** Read the live config. Called fresh on each schedule decision + fetch. */
  getConfig: () => RulesetClientConfig;
  /** Persisted cache seam. Defaults to {@link NoopRulesetCacheStore}. */
  cacheStore?: RulesetCacheStore;
  /**
   * Called AFTER a fetched/loaded artifact has validated and become the held
   * ruleset — but ONLY when it actually changed the live set (first load or a
   * version change), so a same-version re-fetch is a no-op here. The Node seam
   * wires this to `setCurrentRuleset` + `backfillClassification`. Runs off the
   * hot path; keep it non-blocking (fire-and-forget any backfill).
   */
  onActivate?: (ruleset: Ruleset, meta: ActivateMeta) => void;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: RulesetFetcher;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable error sink. Defaults to swallowing (the core never logs itself). */
  onError?: (err: unknown, phase: RulesetErrorPhase) => void;
}

/** Short fixed TTL in `dev` mode — pick up a new signature within seconds. */
const DEV_TTL_MS = 5_000;
/** Fallback TTL in `live` mode when the artifact carries no `Cache-Control`. */
const DEFAULT_LIVE_TTL_MS = 60 * 60 * 1000;
/** Floor on any success TTL, so a `max-age: 0` artifact can't spin a tight loop. */
const MIN_TTL_MS = 1_000;
/** Retry floor after a FAILED refresh in `live` mode (basic backoff). */
const LIVE_RETRY_MS = 30_000;
/** Retry floor after a failed refresh in `dev` mode. */
const DEV_RETRY_MS = 5_000;

/** Parse `max-age=<n>` (seconds) from a `Cache-Control` value, or `null`. */
export function parseMaxAge(cacheControl: string | null): number | null {
  if (!cacheControl) {
    return null;
  }
  // `no-store`/`no-cache` ⇒ treat as "immediately stale" (max-age 0).
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

/** The default fetcher — the global `fetch`, adapted to {@link RulesetFetcher}. */
const defaultFetcher: RulesetFetcher = (url, init) =>
  fetch(url, init) as unknown as Promise<RulesetFetchResponse>;

export class RulesetClient {
  private readonly getConfig: () => RulesetClientConfig;
  private readonly cacheStore: RulesetCacheStore;
  private readonly onActivate: (ruleset: Ruleset, meta: ActivateMeta) => void;
  private readonly fetchImpl: RulesetFetcher;
  private readonly now: () => number;
  private readonly onError: (err: unknown, phase: RulesetErrorPhase) => void;

  /** The currently-held, validated ruleset — the SWR "serve this" value. */
  private current: Ruleset | null = null;
  /** Epoch-ms the held ruleset was fetched (its freshness clock). */
  private fetchedAt = 0;
  /** The held artifact's `Cache-Control: max-age` (seconds), or `null`. */
  private maxAgeSeconds: number | null = null;
  /** Next epoch-ms a refresh is allowed (TTL on success, backoff on failure). */
  private nextAllowedAt = 0;
  /** Single-flight guard — the in-progress refresh, or `null`. */
  private inflight: Promise<void> | null = null;
  /** `start()` ran (disk warm attempted). */
  private started = false;
  /** `stop()` was called — a late-resolving fetch must not activate after it. */
  private stopped = false;

  constructor(options: RulesetClientOptions) {
    this.getConfig = options.getConfig;
    this.cacheStore = options.cacheStore ?? new NoopRulesetCacheStore();
    this.onActivate = options.onActivate ?? (() => {});
    this.fetchImpl = options.fetchImpl ?? defaultFetcher;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * The held ruleset, or `null` when none has loaded. SYNCHRONOUS + cheap — this
   * is what the classifier reads on the (post-response) path. Never does I/O.
   */
  getRuleset(): Ruleset | null {
    return this.current;
  }

  /**
   * Warm from the persisted cache (if any) and schedule an initial background
   * refresh. Awaitable for tests, but callers on any path should treat it as
   * fire-and-forget (`void client.start()`). Idempotent.
   */
  async start(): Promise<void> {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    // (a) Warm from disk/KV — instant, no network. A corrupt cache is ignored
    // (re-validated here, never trusted blindly). The freshness deadline carries
    // over from WHEN THE CACHED ARTIFACT WAS FETCHED, so a still-fresh cache does
    // not trigger a redundant network fetch on the next line.
    try {
      const cached = await this.cacheStore.load();
      if (cached && !this.stopped) {
        const rs = parseRuleset(cached.body);
        this.activate(rs, cached.fetchedAt, cached.maxAgeSeconds, "cache");
        this.nextAllowedAt =
          cached.fetchedAt +
          this.effectiveTtlMs(this.getConfig(), cached.maxAgeSeconds);
      }
    } catch (err) {
      this.onError(err, "cache");
    }
    // (b) Kick a background refresh if we're stale/empty. NEVER awaited here.
    this.maybeRefresh();
  }

  /**
   * The stale-while-revalidate trigger a hot path calls. Cheap + synchronous:
   * lazy-starts, then — if enabled, not already fetching, and past the TTL /
   * backoff floor — `void`s a background {@link refresh}. It NEVER awaits, so a
   * request is never delayed. Serving continues from the held ruleset throughout.
   */
  maybeRefresh(): void {
    if (this.stopped) {
      return;
    }
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      return;
    }
    if (!this.started) {
      void this.start();
      return;
    }
    if (this.inflight) {
      return;
    }
    if (this.now() < this.nextAllowedAt) {
      return;
    }
    void this.refresh();
  }

  /**
   * Fetch + validate + (maybe) swap, once. Single-flighted: concurrent callers
   * share one in-flight fetch. Returns a promise for tests / explicit background
   * refresh — a request path must NOT await this. Never throws (failures are
   * routed to `onError` and the last-good ruleset keeps serving).
   */
  refresh(): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.doFetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Abandon further activation (a late fetch won't swap in after this). */
  stop(): void {
    this.stopped = true;
  }

  /** Await the current in-flight refresh (or resolve immediately). Test helper. */
  whenIdle(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  private async doFetch(): Promise<void> {
    const cfg = this.getConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(cfg.url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`ruleset fetch failed: HTTP ${res.status}`);
      }
      const maxAge = parseMaxAge(res.headers.get("cache-control"));
      const body = await res.json();
      // VALIDATE before use — a corrupt/hostile artifact never becomes live.
      const rs = parseRuleset(body);
      if (this.stopped) {
        return;
      }
      this.activate(rs, this.now(), maxAge, "network");
      this.nextAllowedAt = this.now() + this.effectiveTtlMs(cfg, maxAge);
      // Persist for a warm restart. Best-effort — a cache write failure never
      // affects the live ruleset.
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
      const phase: RulesetErrorPhase =
        err instanceof RulesetValidationError ? "validate" : "fetch";
      this.onError(err, phase);
      // Keep serving the last-good ruleset (or stay empty ⇒ pending). Back off
      // so a dead URL / corrupt artifact is not retried on every request.
      this.nextAllowedAt = this.now() + this.retryFloorMs(cfg);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Swap the held ruleset; fire {@link onActivate} only when the live set changed. */
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
    // A same-version re-fetch refreshes the freshness clock (above) but does NOT
    // re-activate: nothing changed, so no holder churn and no backfill.
  }

  /** Effective freshness TTL (ms) for a just-fetched artifact. */
  private effectiveTtlMs(
    cfg: RulesetClientConfig,
    maxAge: number | null,
  ): number {
    let ttl: number;
    if (cfg.mode === "dev") {
      ttl = DEV_TTL_MS;
    } else if (cfg.ttlSeconds > 0) {
      ttl = cfg.ttlSeconds * 1000;
    } else if (maxAge !== null) {
      ttl = maxAge * 1000;
    } else {
      ttl = DEFAULT_LIVE_TTL_MS;
    }
    return Math.max(ttl, MIN_TTL_MS);
  }

  /** Backoff floor (ms) before retrying after a failed refresh. */
  private retryFloorMs(cfg: RulesetClientConfig): number {
    return cfg.mode === "dev" ? DEV_RETRY_MS : LIVE_RETRY_MS;
  }
}

export type { CachedRuleset, RulesetCacheStore };
export { NoopRulesetCacheStore };
