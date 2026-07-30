import { describe, expect, it } from "vitest";
import {
  agentRequestsResponseSchema,
  agentRoutesResponseSchema,
} from "./agents-routes-store.js";

describe("agents-routes-store schemas (A2 ↔ A1 contract)", () => {
  it("parses a populated /routes payload", () => {
    const parsed = agentRoutesResponseSchema.parse({
      enabled: true,
      since: 1,
      routes: [
        {
          path: "/coverage",
          requests: 120,
          outcomeHistogram: {
            resolved: 90,
            dead_end: 25,
            blocked: 3,
            broken: 2,
          },
          deadEndRate: 0.208,
          servedCount: 18,
          errorCount: 30,
          topFamilies: [
            { family: "gptbot", count: 40 },
            { family: null, count: 5 },
          ],
        },
      ],
    });
    expect(parsed.enabled).toBe(true);
    if (parsed.enabled) {
      expect(parsed.routes[0]?.path).toBe("/coverage");
      expect(parsed.routes[0]?.topFamilies[1]?.family).toBeNull();
    }
  });

  it("parses a populated /requests page with what-was-responded + confidence", () => {
    const parsed = agentRequestsResponseSchema.parse({
      enabled: true,
      since: 1,
      limit: 50,
      offset: 0,
      hasMore: true,
      requests: [
        {
          id: 7,
          ts: 123,
          method: "GET",
          path: "/coverage/dental-2026",
          status: 200,
          outcome: "dead_end",
          served: true,
          servedEncoding: "markdown",
          agentFamily: "chatgpt-user",
          agentClass: "chat-fetcher",
          confidence: "ua+shape",
          ua: "ChatGPT-User/1.0",
        },
      ],
    });
    expect(parsed.enabled).toBe(true);
    if (parsed.enabled) {
      const row = parsed.requests[0];
      expect(row?.served).toBe(true);
      expect(row?.outcome).toBe("dead_end"); // a rescued would-be-404
      expect(row?.confidence).toBe("ua+shape");
    }
  });

  it("accepts the degraded {enabled:false} shape for both endpoints", () => {
    expect(agentRoutesResponseSchema.parse({ enabled: false }).enabled).toBe(
      false,
    );
    expect(agentRequestsResponseSchema.parse({ enabled: false }).enabled).toBe(
      false,
    );
  });
});
