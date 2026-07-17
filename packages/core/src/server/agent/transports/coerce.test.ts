import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractToolParams } from "../represent.js";
import { coerceQuery } from "./coerce.js";

const shape = {
  q: z.string(),
  limit: z.number().max(50).optional(),
  flag: z.boolean().default(false),
  tags: z.array(z.string()).optional(),
};
const params = extractToolParams(shape);

describe("coerceQuery", () => {
  it("coerces strings, numbers, booleans and arrays, then validates", () => {
    const r = coerceQuery(shape, params, {
      q: "shoes",
      limit: "10",
      flag: "true",
      tags: ["a", "b"],
    });
    expect(r).toEqual({
      ok: true,
      args: { q: "shoes", limit: 10, flag: true, tags: ["a", "b"] },
    });
  });

  it("applies schema defaults for absent params", () => {
    const r = coerceQuery(shape, params, { q: "x" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.args.flag).toBe(false);
  });

  it("ignores undeclared query keys (via=, utm_*)", () => {
    const r = coerceQuery(shape, params, {
      q: "x",
      via: "jsonld",
      utm_source: "z",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args).not.toHaveProperty("via");
      expect(r.args).not.toHaveProperty("utm_source");
    }
  });

  it("fails readably on a non-numeric number param (limit=abc)", () => {
    const r = coerceQuery(shape, params, { q: "x", limit: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(typeof r.message).toBe("string");
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it("fails on a value that violates the schema bound (limit>50)", () => {
    const r = coerceQuery(shape, params, { q: "x", limit: "100" });
    expect(r.ok).toBe(false);
  });

  it("fails on a missing required param", () => {
    expect(coerceQuery(shape, params, {}).ok).toBe(false);
  });

  it("takes the last value of a repeated scalar param", () => {
    const r = coerceQuery(shape, params, { q: ["a", "b"] });
    expect(r.ok && r.args.q).toBe("b");
  });

  it("accepts a no-input tool and drops all query keys", () => {
    expect(coerceQuery(undefined, [], { anything: "x" })).toEqual({
      ok: true,
      args: {},
    });
  });
});
