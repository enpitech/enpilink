/**
 * Token-bucket rate limiter for the GET transport (M7, ARCHITECTURE §3.7).
 *
 * The GET transport is an UNAUTHENTICATED SCRAPING SURFACE. There is no attack
 * surface — the data is public and read-only, already scrapeable — so the ONLY
 * real cost is compute, and rate limiting (not identity) is what bounds it. A
 * bucket is keyed by `(ip, tool)`: conservative refill (rpm) with a small burst.
 * Over-limit → the caller returns 429 with `Retry-After` + a readable body.
 *
 * Kept deliberately simple (per the brief): a single uniform bucket per key, no
 * confidence tiering. The clock is injectable for tests; the bucket map is bounded
 * and self-prunes stale (fully-refilled) entries so it cannot grow without bound.
 */

/** A resolved bucket size for one check. */
export interface RateLimitConfig {
  /** Sustained requests per minute per key. */
  rpm: number;
  /** Maximum burst (bucket capacity). */
  burst: number;
}

/** The limiter verdict for one request. */
export interface RateLimitVerdict {
  /** Whether the request is within the limit. */
  allowed: boolean;
  /** Seconds until the next token is available (0 when allowed). */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export interface TokenBucketLimiterOptions {
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Soft cap on tracked keys before a prune sweep. Default 10000. */
  maxBuckets?: number;
  /** Age (ms) past which an idle bucket is considered stale/droppable. Default 5m. */
  staleMs?: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly maxBuckets: number;
  private readonly staleMs: number;

  constructor(opts?: TokenBucketLimiterOptions) {
    this.now = opts?.now ?? Date.now;
    this.maxBuckets = opts?.maxBuckets ?? 10000;
    this.staleMs = opts?.staleMs ?? 5 * 60_000;
  }

  /** Consume one token for `key`, or report how long until one is free. */
  check(key: string, cfg: RateLimitConfig): RateLimitVerdict {
    const now = this.now();
    const capacity = Math.max(1, cfg.burst);
    const refillPerMs = cfg.rpm > 0 ? cfg.rpm / 60_000 : 0;

    const existing = this.buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: capacity, last: now };
    if (existing) {
      const elapsed = Math.max(0, now - bucket.last);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.last = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      this.pruneIfNeeded(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    this.buckets.set(key, bucket);
    const needed = 1 - bucket.tokens;
    const waitMs = refillPerMs > 0 ? needed / refillPerMs : 60_000;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
    };
  }

  /** Current tracked-key count (for tests / introspection). */
  size(): number {
    return this.buckets.size;
  }

  /** Drop stale/full buckets once the map grows past its soft cap. */
  private pruneIfNeeded(now: number): void {
    if (this.buckets.size <= this.maxBuckets) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.last > this.staleMs) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.size <= this.maxBuckets) {
      return;
    }
    const oldestFirst = [...this.buckets.entries()].sort(
      (a, b) => a[1].last - b[1].last,
    );
    for (const [key] of oldestFirst) {
      if (this.buckets.size <= this.maxBuckets) {
        break;
      }
      this.buckets.delete(key);
    }
  }
}
