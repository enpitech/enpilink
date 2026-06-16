import { describe, expect, it } from "vitest";
import {
  generateMockEvents,
  generateMockLogs,
  MOCK_SEED,
  mulberry32,
  seedMockData,
} from "./mock-seed.js";
import { MemoryStorageAdapter } from "./storage/memory.js";

const BASE = 1_700_000_000_000; // fixed base timestamp

describe("mulberry32", () => {
  it("is a pure function of its seed (same seed → same sequence)", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces floats in [0, 1)", () => {
    const r = mulberry32(MOCK_SEED);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("differs for different seeds", () => {
    expect(mulberry32(1)()).not.toEqual(mulberry32(2)());
  });
});

describe("generateMockEvents (determinism)", () => {
  it("same seed + base → byte-identical events", () => {
    const a = generateMockEvents({ now: BASE });
    const b = generateMockEvents({ now: BASE });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("a different base shifts every timestamp by the same delta", () => {
    const a = generateMockEvents({ now: BASE });
    const b = generateMockEvents({ now: BASE + 10_000 });
    expect(a).toHaveLength(b.length);
    // Non-ts fields are identical (PRNG sequence unchanged); ts shifts by +10s.
    for (let i = 0; i < a.length; i++) {
      const ea = a[i];
      const eb = b[i];
      expect(eb?.ts).toBe((ea?.ts ?? 0) + 10_000);
      expect(eb?.tool).toBe(ea?.tool);
      expect(eb?.ms).toBe(ea?.ms);
      expect(eb?.ok).toBe(ea?.ok);
    }
  });

  it("a different seed produces a different dataset", () => {
    const a = generateMockEvents({ now: BASE, seed: 1 });
    const b = generateMockEvents({ now: BASE, seed: 2 });
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it("honors count, keeps events within the window, oldest-first", () => {
    const span = 6 * 60 * 60 * 1000;
    const events = generateMockEvents({ now: BASE, count: 120, spanMs: span });
    expect(events).toHaveLength(120);
    for (let i = 1; i < events.length; i++) {
      expect((events[i]?.ts ?? 0) >= (events[i - 1]?.ts ?? 0)).toBe(true);
    }
    for (const e of events) {
      expect(e.ts).toBeGreaterThanOrEqual(BASE - span);
      expect(e.ts).toBeLessThanOrEqual(BASE);
      expect(e.ms).toBeGreaterThanOrEqual(1);
      expect(e.type).toBe("tool_call");
    }
  });

  it("produces a sensible (non-zero, non-total) error spread", () => {
    const events = generateMockEvents({ now: BASE, count: 600 });
    const errors = events.filter((e) => e.ok === false).length;
    expect(errors).toBeGreaterThan(0);
    expect(errors).toBeLessThan(events.length);
  });
});

describe("generateMockLogs (determinism)", () => {
  it("same seed + base → identical logs", () => {
    expect(JSON.stringify(generateMockLogs({ now: BASE }))).toEqual(
      JSON.stringify(generateMockLogs({ now: BASE })),
    );
  });

  it("includes multiple severity levels", () => {
    const levels = new Set(generateMockLogs({ now: BASE }).map((l) => l.level));
    expect(levels.has("info")).toBe(true);
    expect(levels.has("error")).toBe(true);
  });
});

describe("seedMockData", () => {
  it("writes the generated events + logs into storage deterministically", async () => {
    const s1 = new MemoryStorageAdapter();
    await s1.init();
    const r1 = await seedMockData(s1, { now: BASE, count: 50 });
    expect(r1.events).toBe(50);

    const s2 = new MemoryStorageAdapter();
    await s2.init();
    await seedMockData(s2, { now: BASE, count: 50 });

    const e1 = await s1.queryEvents({ since: 0, limit: 5000 });
    const e2 = await s2.queryEvents({ since: 0, limit: 5000 });
    expect(JSON.stringify(e1)).toEqual(JSON.stringify(e2));
    expect(e1.length).toBe(50);

    const l1 = await s1.queryLogs({ since: 0, limit: 5000 });
    expect(l1.length).toBeGreaterThan(0);
  });
});
