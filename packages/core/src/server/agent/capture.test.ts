import { describe, expect, it } from "vitest";
import type { HeaderPair } from "../storage/types.js";
import {
  classifyOutcome,
  headerValue,
  type MinimalRequest,
  pairRawHeaders,
  toCaptureRecord,
} from "./capture.js";

describe("pairRawHeaders", () => {
  it("reshapes Node's flat rawHeaders into ordered pairs, preserving order + casing", () => {
    const flat = [
      "Host",
      "example.com",
      "Sec-Ch-Ua",
      '"Chromium";v="128"',
      "user-agent",
      "curl/8",
    ];
    expect(pairRawHeaders(flat)).toEqual([
      ["Host", "example.com"],
      ["Sec-Ch-Ua", '"Chromium";v="128"'],
      ["user-agent", "curl/8"],
    ]);
  });

  it("ignores a trailing unpaired element (malformed input)", () => {
    expect(pairRawHeaders(["A", "1", "B"])).toEqual([["A", "1"]]);
  });
});

describe("headerValue", () => {
  const pairs: HeaderPair[] = [
    ["Sec-Ch-Ua", "x"],
    ["User-Agent", "GPTBot/1.0"],
  ];
  it("matches case-insensitively and returns the first value", () => {
    expect(headerValue(pairs, "user-agent")).toBe("GPTBot/1.0");
    expect(headerValue(pairs, "USER-AGENT")).toBe("GPTBot/1.0");
    expect(headerValue(pairs, "missing")).toBeUndefined();
  });
});

describe("classifyOutcome", () => {
  it("maps status codes to the S3 outcome classes", () => {
    expect(classifyOutcome(200)).toBe("resolved");
    expect(classifyOutcome(204)).toBe("resolved");
    expect(classifyOutcome(301)).toBe("resolved");
    expect(classifyOutcome(400)).toBe("resolved"); // a plain bad-request is not a dead-end
    expect(classifyOutcome(404)).toBe("dead_end");
    expect(classifyOutcome(410)).toBe("dead_end");
    expect(classifyOutcome(401)).toBe("blocked");
    expect(classifyOutcome(403)).toBe("blocked");
    expect(classifyOutcome(429)).toBe("blocked");
    expect(classifyOutcome(500)).toBe("broken");
    expect(classifyOutcome(503)).toBe("broken");
  });
});

describe("toCaptureRecord", () => {
  const base: MinimalRequest = {
    method: "GET",
    path: "/products/blue-widget",
    httpVersion: "1.1",
    rawHeaders: [
      ["Host", "acme.com"],
      ["Sec-Ch-Ua", '"Chromium";v="128"'],
      ["User-Agent", "GPTBot/1.0"],
      ["Referer", "https://ref.example"],
    ],
    ipHash: "deadbeef",
  };

  it("assembles a record, derives outcome, and lifts ua/referer", () => {
    const rec = toCaptureRecord(
      base,
      { status: 200, ts: 1000, ms: 12 },
      "site-1",
    );
    expect(rec).toMatchObject({
      ts: 1000,
      siteId: "site-1",
      method: "GET",
      path: "/products/blue-widget",
      status: 200,
      outcome: "resolved",
      httpVersion: "1.1",
      ms: 12,
      ipHash: "deadbeef",
      ua: "GPTBot/1.0",
      referer: "https://ref.example",
      confidence: "none",
    });
  });

  it("defaults confidence to 'none' and leaves detection fields unset (M1)", () => {
    const rec = toCaptureRecord(base, { status: 404, ts: 1, ms: 1 }, "s");
    expect(rec.confidence).toBe("none");
    expect(rec.agentFamily).toBeUndefined();
    expect(rec.agentClass).toBeUndefined();
    expect(rec.sessionId).toBeUndefined();
    expect(rec.outcome).toBe("dead_end");
  });

  it("omits ipHash when the adapter could not hash the IP (never a raw IP)", () => {
    const noHash: MinimalRequest = { ...base, ipHash: undefined };
    const rec = toCaptureRecord(noHash, { status: 200, ts: 1, ms: 1 }, "s");
    expect(rec.ipHash).toBeUndefined();
  });

  // MANDATORY: the fingerprint's whole value is header casing. A title-cased
  // `Sec-Ch-Ua` (a disguised library's tell) must survive verbatim — never
  // lowercased to the `sec-ch-ua` a real Chrome would send.
  it("preserves original header CASING and ORDER verbatim", () => {
    const rec = toCaptureRecord(base, { status: 200, ts: 1, ms: 1 }, "s");
    expect(rec.headers).toEqual([
      ["Host", "acme.com"],
      ["Sec-Ch-Ua", '"Chromium";v="128"'],
      ["User-Agent", "GPTBot/1.0"],
      ["Referer", "https://ref.example"],
    ]);
    // Title-case is retained, not folded to lowercase.
    expect(rec.headers[1]?.[0]).toBe("Sec-Ch-Ua");
    expect(rec.headers.map((h) => h[0])).not.toContain("sec-ch-ua");
  });
});
