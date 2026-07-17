import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "./rate-limit.js";

describe("TokenBucketLimiter", () => {
  it("allows up to the burst, then 429s with a Retry-After", () => {
    const now = 0;
    const lim = new TokenBucketLimiter({ now: () => now });
    const cfg = { rpm: 60, burst: 3 };
    expect(lim.check("k", cfg).allowed).toBe(true);
    expect(lim.check("k", cfg).allowed).toBe(true);
    expect(lim.check("k", cfg).allowed).toBe(true);
    const blocked = lim.check("k", cfg);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("refills over time", () => {
    let now = 0;
    const lim = new TokenBucketLimiter({ now: () => now });
    const cfg = { rpm: 60, burst: 1 }; // 1 token / second
    expect(lim.check("k", cfg).allowed).toBe(true);
    expect(lim.check("k", cfg).allowed).toBe(false);
    now += 1000;
    expect(lim.check("k", cfg).allowed).toBe(true);
  });

  it("keys buckets independently (one client cannot starve another)", () => {
    const now = 0;
    const lim = new TokenBucketLimiter({ now: () => now });
    const cfg = { rpm: 60, burst: 1 };
    expect(lim.check("a", cfg).allowed).toBe(true);
    expect(lim.check("a", cfg).allowed).toBe(false);
    expect(lim.check("b", cfg).allowed).toBe(true);
  });

  it("bounds its map by pruning stale buckets", () => {
    let now = 0;
    const lim = new TokenBucketLimiter({
      now: () => now,
      maxBuckets: 2,
      staleMs: 100,
    });
    const cfg = { rpm: 60, burst: 1 };
    lim.check("a", cfg);
    now += 1000;
    lim.check("b", cfg);
    now += 1000;
    lim.check("c", cfg);
    expect(lim.size()).toBeLessThanOrEqual(2);
  });
});
