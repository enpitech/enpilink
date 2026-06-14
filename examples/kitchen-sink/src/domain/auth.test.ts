import { describe, expect, it } from "vitest";
import { verifyOtp } from "@/domain/auth.js";
import { deterministicId, fnv1a, shortId } from "@/domain/id.js";

describe("verifyOtp", () => {
  it("accepts the demo OTP", () => {
    const r = verifyOtp("000000");
    expect(r.ok).toBe(true);
    expect(r.customerName).toBe("Ada Merchant");
  });
  it("rejects anything else with a helpful hint", () => {
    const r = verifyOtp("123456");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("000000");
  });
});

describe("deterministic ids", () => {
  it("fnv1a is stable", () => {
    expect(fnv1a("NW-P-100")).toBe(fnv1a("NW-P-100"));
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
  });
  it("shortId is upper-case, fixed length, stable", () => {
    const id = shortId("seed");
    expect(id).toBe(shortId("seed"));
    expect(id).toMatch(/^[0-9A-Z]{6}$/);
  });
  it("deterministicId is prefixed and stable", () => {
    expect(deterministicId("ORD", "x")).toBe(deterministicId("ORD", "x"));
    expect(deterministicId("ORD", "x")).toMatch(/^ORD-[0-9A-Z]{6}$/);
  });
});
