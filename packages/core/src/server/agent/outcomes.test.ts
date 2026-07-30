import { describe, expect, it } from "vitest";
import type { AgentRequestRecord } from "../storage/types.js";
import {
  computeAgentOutcomes,
  computeAgentRoutes,
  foldOutcomeGroups,
  foldRouteGroups,
  groupRecords,
  groupRouteRecords,
  isWriteMethod,
} from "./outcomes.js";

/** Build an agent request record from the few fields these tests care about. */
function rec(p: Partial<AgentRequestRecord>): AgentRequestRecord {
  return {
    ts: p.ts ?? 0,
    siteId: "default",
    method: p.method ?? "GET",
    path: p.path ?? "/",
    status: p.status ?? 200,
    outcome: p.outcome ?? "resolved",
    httpVersion: "1.1",
    headers: [],
    confidence: p.confidence ?? "none",
    ...p,
  };
}

describe("isWriteMethod", () => {
  it("recognises mutating methods case-insensitively", () => {
    expect(isWriteMethod("POST")).toBe(true);
    expect(isWriteMethod("put")).toBe(true);
    expect(isWriteMethod("PATCH")).toBe(true);
    expect(isWriteMethod("delete")).toBe(true);
    expect(isWriteMethod("GET")).toBe(false);
    expect(isWriteMethod("HEAD")).toBe(false);
  });
});

describe("computeAgentOutcomes", () => {
  // A realistic mix: 20 requests, deliberately arranged so the dead-end rate is
  // the F2 headline 35% and a POST-blocked write attempt is NOT swallowed into
  // the read `blocked` bucket.
  const records: AgentRequestRecord[] = [
    // 10 resolved GETs from Gemini (4 of them served the representation).
    ...Array.from({ length: 10 }, (_, i) =>
      rec({
        outcome: "resolved",
        agentFamily: "gemini",
        agentClass: "chat-fetcher",
        served: i < 4,
      }),
    ),
    // 5 dead-end GETs from Gemini.
    ...Array.from({ length: 5 }, () =>
      rec({
        status: 404,
        outcome: "dead_end",
        agentFamily: "gemini",
        agentClass: "chat-fetcher",
      }),
    ),
    // 2 dead-end GETs from GPTBot (a crawler).
    ...Array.from({ length: 2 }, () =>
      rec({
        status: 410,
        outcome: "dead_end",
        agentFamily: "gptbot",
        agentClass: "crawler",
      }),
    ),
    // 3 blocked POSTs — write attempts, not read failures.
    ...Array.from({ length: 3 }, () =>
      rec({
        method: "POST",
        status: 403,
        outcome: "blocked",
        agentFamily: "gemini",
        agentClass: "chat-fetcher",
      }),
    ),
  ];

  const agg = computeAgentOutcomes(records);

  it("counts the overall total", () => {
    expect(agg.total).toBe(20);
  });

  it("computes the dead-end rate (the F2 35% number)", () => {
    expect(agg.deadEnds).toBe(7);
    expect(agg.deadEndRate).toBeCloseTo(0.35, 5);
  });

  it("keeps write attempts OUT of the read buckets (money event)", () => {
    // classHistogram: writes → write_attempt, never `blocked`.
    expect(agg.classHistogram).toEqual({
      resolved: 10,
      dead_end: 7,
      blocked: 0,
      broken: 0,
      write_attempt: 3,
    });
    // The raw outcome histogram still reflects the POSTs' 403 as blocked.
    expect(agg.outcomeHistogram).toEqual({
      resolved: 10,
      dead_end: 7,
      blocked: 3,
      broken: 0,
    });
    // The write breakdown surfaces the failures explicitly.
    expect(agg.write.total).toBe(3);
    expect(agg.write.byOutcome.blocked).toBe(3);
  });

  it("computes dead-end rate per family", () => {
    const gemini = agg.byFamily.find((f) => f.family === "gemini");
    const gptbot = agg.byFamily.find((f) => f.family === "gptbot");
    // Gemini: 18 requests (10 resolved + 5 dead + 3 blocked-POST), 5 dead-ends.
    expect(gemini).toMatchObject({ total: 18, deadEnds: 5 });
    expect(gemini?.deadEndRate).toBeCloseTo(5 / 18, 5);
    // GPTBot: 2 requests, both dead-ends.
    expect(gptbot).toMatchObject({ total: 2, deadEnds: 2, deadEndRate: 1 });
  });

  it("computes dead-end rate per class", () => {
    const chat = agg.byClass.find((c) => c.agentClass === "chat-fetcher");
    const crawler = agg.byClass.find((c) => c.agentClass === "crawler");
    expect(chat).toMatchObject({ total: 18, deadEnds: 5 });
    expect(crawler).toMatchObject({ total: 2, deadEnds: 2 });
  });

  it("segments served-vs-not (the confabulation-gap headline)", () => {
    // 4 served — all resolved, no dead-ends.
    expect(agg.served.total).toBe(4);
    expect(agg.served.deadEnds).toBe(0);
    expect(agg.served.deadEndRate).toBe(0);
    expect(agg.served.outcomeHistogram.resolved).toBe(4);
    // 16 not served — carry all 7 dead-ends.
    expect(agg.notServed.total).toBe(16);
    expect(agg.notServed.deadEnds).toBe(7);
    expect(agg.notServed.deadEndRate).toBeCloseTo(7 / 16, 5);
  });

  it("is empty-safe (no divide-by-zero)", () => {
    const empty = computeAgentOutcomes([]);
    expect(empty.total).toBe(0);
    expect(empty.deadEndRate).toBe(0);
    expect(empty.served.deadEndRate).toBe(0);
    expect(empty.byFamily).toEqual([]);
  });

  it("folding DB groups yields the SAME numbers as folding records", () => {
    // The route path (DB GROUP BY) and the record path must agree exactly.
    const viaGroups = foldOutcomeGroups(groupRecords(records));
    expect(viaGroups).toEqual(agg);
  });
});

describe("computeAgentRoutes (by-route aggregation)", () => {
  // Two endpoints with distinct error profiles + a rescued dead-end, so the
  // per-route counts, servedCount, errorCount and topFamilies are all exercised.
  const records: AgentRequestRecord[] = [
    // /search — 3 resolved (2 gemini, 1 gptbot) + 1 dead-end (gemini) that was
    // RESCUED (served), + 1 blocked (perplexity).
    rec({ path: "/search", outcome: "resolved", agentFamily: "gemini" }),
    rec({ path: "/search", outcome: "resolved", agentFamily: "gemini" }),
    rec({ path: "/search", outcome: "resolved", agentFamily: "gptbot" }),
    rec({
      path: "/search",
      status: 404,
      outcome: "dead_end",
      agentFamily: "gemini",
      served: true,
    }),
    rec({
      path: "/search",
      status: 403,
      outcome: "blocked",
      agentFamily: "perplexity",
    }),
    // /old-page — all dead-ends, none rescued (a clearly-broken route).
    rec({ path: "/old-page", status: 410, outcome: "dead_end" }),
    rec({ path: "/old-page", status: 410, outcome: "dead_end" }),
    // /about — clean: one resolved, no errors.
    rec({ path: "/about", outcome: "resolved", agentFamily: "gemini" }),
  ];

  const routes = computeAgentRoutes(records);

  it("groups by path and sorts by request volume desc", () => {
    expect(routes.map((r) => r.path)).toEqual([
      "/search",
      "/old-page",
      "/about",
    ]);
    expect(routes.map((r) => r.requests)).toEqual([5, 2, 1]);
  });

  it("computes the per-route outcome histogram + dead-end rate", () => {
    const search = routes.find((r) => r.path === "/search");
    expect(search?.outcomeHistogram).toEqual({
      resolved: 3,
      dead_end: 1,
      blocked: 1,
      broken: 0,
    });
    expect(search?.deadEndRate).toBeCloseTo(1 / 5, 5);
  });

  it("counts rescues (served && dead_end) as servedCount", () => {
    const search = routes.find((r) => r.path === "/search");
    // 1 of the /search dead-ends was rescued by a served representation.
    expect(search?.servedCount).toBe(1);
    // /old-page dead-ends were never rescued.
    const old = routes.find((r) => r.path === "/old-page");
    expect(old?.servedCount).toBe(0);
  });

  it("counts errors as dead_end + blocked + broken", () => {
    const search = routes.find((r) => r.path === "/search");
    // 1 dead-end + 1 blocked = 2 errors (the rescued dead-end still counts).
    expect(search?.errorCount).toBe(2);
    const about = routes.find((r) => r.path === "/about");
    expect(about?.errorCount).toBe(0);
  });

  it("surfaces the busiest families per route, most first", () => {
    const search = routes.find((r) => r.path === "/search");
    expect(search?.topFamilies).toEqual([
      { family: "gemini", count: 3 },
      { family: "gptbot", count: 1 },
      { family: "perplexity", count: 1 },
    ]);
    // An unnamed family surfaces as null.
    const old = routes.find((r) => r.path === "/old-page");
    expect(old?.topFamilies).toEqual([{ family: null, count: 2 }]);
  });

  it("errorsOnly drops routes with no errors", () => {
    const errorRoutes = computeAgentRoutes(records, { errorsOnly: true });
    // /about (clean) is gone; /search + /old-page remain.
    expect(errorRoutes.map((r) => r.path)).toEqual(["/search", "/old-page"]);
  });

  it("caps topFamilies via topFamiliesLimit", () => {
    const capped = computeAgentRoutes(records, { topFamiliesLimit: 1 });
    const search = capped.find((r) => r.path === "/search");
    expect(search?.topFamilies).toEqual([{ family: "gemini", count: 3 }]);
  });

  it("folding DB route-groups yields the SAME numbers as folding records", () => {
    const viaGroups = foldRouteGroups(groupRouteRecords(records));
    expect(viaGroups).toEqual(routes);
  });

  it("is empty-safe", () => {
    expect(computeAgentRoutes([])).toEqual([]);
  });
});
