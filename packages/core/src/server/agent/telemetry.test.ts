import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../storage/memory.js";
import type {
  AgentClass,
  AgentRequestRecord,
  StorageAdapter,
} from "../storage/types.js";
import {
  buildHeadline,
  createAgentTelemetryRouter,
  summarizeAgentTelemetry,
} from "./telemetry.js";

const MIN = 60_000;

function rec(p: {
  ts: number;
  path?: string;
  outcome?: AgentRequestRecord["outcome"];
  status?: number;
  agentFamily?: string;
  agentClass?: AgentClass;
  ipHash?: string;
  method?: string;
  served?: boolean;
  ua?: string;
}): AgentRequestRecord {
  return {
    ts: p.ts,
    siteId: "default",
    method: p.method ?? "GET",
    path: p.path ?? "/",
    status: p.status ?? (p.outcome === "dead_end" ? 404 : 200),
    outcome: p.outcome ?? "resolved",
    httpVersion: "1.1",
    headers: [],
    confidence: "none",
    ...(p.agentFamily !== undefined ? { agentFamily: p.agentFamily } : {}),
    ...(p.agentClass !== undefined ? { agentClass: p.agentClass } : {}),
    ...(p.ipHash !== undefined ? { ipHash: p.ipHash } : {}),
    ...(p.served ? { served: true } : {}),
    ...(p.ua !== undefined ? { ua: p.ua } : {}),
  };
}

/**
 * A representative seed under the M3.5 rescue model: two chat-fetcher
 * would-be-404s RESCUED by a served representation (status 200, but recorded as
 * the dead-ends they were, with served=1), two chat-fetcher dead-ends that were
 * NOT rescued, plus a recovering CLI.
 */
function seedRecords(now: number): AgentRequestRecord[] {
  return [
    rec({
      ts: now - 5 * MIN,
      outcome: "dead_end",
      status: 200,
      agentFamily: "gemini",
      agentClass: "chat-fetcher",
      served: true,
    }),
    rec({
      ts: now - 5 * MIN,
      outcome: "dead_end",
      status: 200,
      agentFamily: "gemini",
      agentClass: "chat-fetcher",
      served: true,
    }),
    rec({
      ts: now - 4 * MIN,
      outcome: "dead_end",
      agentFamily: "gemini",
      agentClass: "chat-fetcher",
    }),
    rec({
      ts: now - 4 * MIN,
      outcome: "dead_end",
      agentFamily: "gemini",
      agentClass: "chat-fetcher",
    }),
    // A CLI dead-end followed by a resolved on the same IP → recovered.
    rec({
      ts: now - 3 * MIN,
      outcome: "dead_end",
      agentClass: "cli",
      ipHash: "DEV",
    }),
    rec({
      ts: now - 2 * MIN,
      outcome: "resolved",
      agentClass: "cli",
      ipHash: "DEV",
    }),
  ];
}

describe("summarizeAgentTelemetry + buildHeadline (pure)", () => {
  it("assembles outcomes + sessions and a grounded headline sentence", () => {
    const now = Date.now();
    const summary = summarizeAgentTelemetry(seedRecords(now), { since: 0 });
    expect(summary.enabled).toBe(true);
    expect(summary.outcomes.total).toBe(6);
    expect(summary.outcomes.deadEnds).toBe(5);
    expect(summary.outcomes.served.total).toBe(2);
    // The rescued segment: served + outcome=dead_end (the two rescued 404s).
    expect(summary.rescuedDeadEnds).toBe(2);
    expect(summary.outcomes.served.deadEnds).toBe(2);
    expect(summary.sessions.recovery.recovered).toBe(1);
    // The headline names requests, dead-ends and the rescued count (M3.5 money view).
    expect(summary.headline).toContain("6 requests");
    expect(summary.headline).toContain("5 dead-ends");
    expect(summary.headline).toContain("2 rescued by a served representation");
    // Coverage metadata is present so M5 can render confidence.
    expect(summary.coverage.escalationBestEffort).toBe(true);
    expect(summary.coverage.sessionable).toBeGreaterThan(0);
  });

  it("buildHeadline omits the recovery clause when there is nothing correlatable", () => {
    const summary = summarizeAgentTelemetry([
      rec({
        ts: 0,
        outcome: "dead_end",
        agentClass: "chat-fetcher",
        ipHash: "POOL",
      }),
    ]);
    expect(summary.headline).not.toContain("never recovered");
    // buildHeadline is exported for M5's use.
    expect(buildHeadline(summary.outcomes, summary.sessions)).toBe(
      summary.headline,
    );
  });
});

// --- Router behaviour (incl. the disabled/no-storage path) ---

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function mount(getStorage: () => StorageAdapter | null) {
  const app = express();
  app.use(createAgentTelemetryRouter(getStorage));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  });
  return `http://127.0.0.1:${port}`;
}

describe("createAgentTelemetryRouter (disabled / no storage)", () => {
  it("returns 200 { enabled: false }, never 500", async () => {
    const url = await mount(() => null);
    const res = await fetch(`${url}/__enpilink/agents/summary`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});

describe("createAgentTelemetryRouter (with storage)", () => {
  it("serves the accurate outcome summary + correlation numbers", async () => {
    const now = Date.now();
    const storage = new MemoryStorageAdapter();
    await storage.init();
    await storage.recordAgentRequests(seedRecords(now));

    const url = await mount(() => storage);
    const res = await fetch(`${url}/__enpilink/agents/summary?since=0`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.enabled).toBe(true);
    // Outcome numbers come from the DB-side aggregate — accurate over the window.
    expect(body.outcomes.total).toBe(6);
    expect(body.outcomes.deadEnds).toBe(5);
    expect(body.outcomes.served.total).toBe(2);
    // Of the 5 dead-ends, 2 were rescued by a served representation (M3.5).
    expect(body.rescuedDeadEnds).toBe(2);
    // Correlation: the CLI dead-end recovered; coverage is honest (2 of 6).
    expect(body.sessions.sessionableRequests).toBe(2);
    expect(body.sessions.sessionableCoverage).toBeCloseTo(2 / 6, 5);
    expect(body.sessions.recovery.recovered).toBe(1);
    expect(body.coverage.correlationSampled).toBe(false);
    expect(body.headline).toContain("6 requests");
    // The unsessionable breakdown NAMES chat-fetchers even though the bounded
    // correlation pull never fetched them (derived from the all-traffic aggregate).
    const chat = body.sessions.unsessionableByClass.find(
      (c: { agentClass: string }) => c.agentClass === "chat-fetcher",
    );
    expect(chat?.count).toBe(4);
  });

  it("returns 200 { enabled: false } when storage throws", async () => {
    const bad: Partial<StorageAdapter> = {
      queryAgentRequests: async () => {
        throw new Error("boom");
      },
    };
    const url = await mount(() => bad as StorageAdapter);
    const res = await fetch(`${url}/__enpilink/agents/summary?since=0`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});

// --- A1: /routes + /requests (by-route aggregation + drill-down) ---

/**
 * A multi-endpoint seed: /search (mixed, one rescued dead-end + one blocked),
 * /old (all dead-ends, unrescued), /about (clean). Enough to exercise the
 * per-route breakdown, the errors-only filter, the drill-down filters, and
 * pagination.
 */
function routeSeed(now: number): AgentRequestRecord[] {
  return [
    rec({ ts: now - 9 * MIN, path: "/search", agentFamily: "gemini" }),
    rec({ ts: now - 8 * MIN, path: "/search", agentFamily: "gemini" }),
    rec({
      ts: now - 7 * MIN,
      path: "/search",
      outcome: "dead_end",
      agentFamily: "gemini",
      agentClass: "chat-fetcher",
      served: true,
      ua: "Gemini",
    }),
    rec({
      ts: now - 6 * MIN,
      path: "/search",
      outcome: "blocked",
      status: 403,
      agentFamily: "perplexity",
      agentClass: "cli",
    }),
    rec({
      ts: now - 5 * MIN,
      path: "/old",
      outcome: "dead_end",
      status: 410,
      agentFamily: "gptbot",
      agentClass: "crawler",
    }),
    rec({
      ts: now - 4 * MIN,
      path: "/old",
      outcome: "dead_end",
      status: 410,
      agentFamily: "gptbot",
      agentClass: "crawler",
    }),
    rec({ ts: now - 3 * MIN, path: "/about", agentFamily: "gemini" }),
  ];
}

async function seededUrl(now: number): Promise<string> {
  const storage = new MemoryStorageAdapter();
  await storage.init();
  await storage.recordAgentRequests(routeSeed(now));
  return mount(() => storage);
}

describe("GET /routes (by-route aggregation)", () => {
  it("returns the per-endpoint breakdown, sorted by volume", async () => {
    const now = Date.now();
    const url = await seededUrl(now);
    const res = await fetch(`${url}/__enpilink/agents/routes?since=0`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.routes.map((r: { path: string }) => r.path)).toEqual([
      "/search",
      "/old",
      "/about",
    ]);
    const search = body.routes.find(
      (r: { path: string }) => r.path === "/search",
    );
    expect(search.requests).toBe(4);
    expect(search.outcomeHistogram).toEqual({
      resolved: 2,
      dead_end: 1,
      blocked: 1,
      broken: 0,
    });
    // The rescued dead-end is counted as servedCount; errors = dead_end + blocked.
    expect(search.servedCount).toBe(1);
    expect(search.errorCount).toBe(2);
    // gemini made 3 of /search's 4 requests (2 resolved + 1 rescued dead-end).
    expect(search.topFamilies[0]).toEqual({ family: "gemini", count: 3 });
  });

  it("errorsOnly drops routes with no errors", async () => {
    const now = Date.now();
    const url = await seededUrl(now);
    const res = await fetch(
      `${url}/__enpilink/agents/routes?since=0&errorsOnly=true`,
    );
    const body = await res.json();
    expect(body.routes.map((r: { path: string }) => r.path)).toEqual([
      "/search",
      "/old",
    ]);
  });

  it("degrades to { enabled: false } with no storage", async () => {
    const url = await mount(() => null);
    const res = await fetch(`${url}/__enpilink/agents/routes`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("returns enabled:true + empty routes when on-but-empty", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init();
    const url = await mount(() => storage);
    const res = await fetch(`${url}/__enpilink/agents/routes?since=0`);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.routes).toEqual([]);
  });
});

describe("GET /requests (filterable drill-down)", () => {
  it("returns rows with the responded detail + attribution", async () => {
    const now = Date.now();
    const url = await seededUrl(now);
    const res = await fetch(`${url}/__enpilink/agents/requests?since=0`);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.hasMore).toBe(false);
    expect(body.requests).toHaveLength(7);
    // Rows never carry raw headers / ipHash — a behavioural view, not a dump.
    expect(body.requests[0]).not.toHaveProperty("headers");
    expect(body.requests[0]).not.toHaveProperty("ipHash");
  });

  it("filters by outcome and surfaces what was served", async () => {
    const now = Date.now();
    const url = await seededUrl(now);
    const res = await fetch(
      `${url}/__enpilink/agents/requests?since=0&outcome=dead_end`,
    );
    const body = await res.json();
    expect(
      body.requests.every((r: { outcome: string }) => r.outcome === "dead_end"),
    ).toBe(true);
    // The rescued /search dead-end reports served + its markdown encoding + confidence.
    const rescued = body.requests.find(
      (r: { path: string }) => r.path === "/search",
    );
    expect(rescued.served).toBe(true);
    expect(rescued.status).toBe(404);
    expect(rescued.agentClass).toBe("chat-fetcher");
    expect(rescued.confidence).toBe("none");
  });

  it("filters by family, class, status and path", async () => {
    const now = Date.now();
    const url = await seededUrl(now);
    const family = await (
      await fetch(`${url}/__enpilink/agents/requests?since=0&family=gptbot`)
    ).json();
    expect(family.requests).toHaveLength(2);
    const cls = await (
      await fetch(`${url}/__enpilink/agents/requests?since=0&class=crawler`)
    ).json();
    expect(cls.requests).toHaveLength(2);
    const status = await (
      await fetch(`${url}/__enpilink/agents/requests?since=0&status=403`)
    ).json();
    expect(status.requests).toHaveLength(1);
    const path = await (
      await fetch(`${url}/__enpilink/agents/requests?since=0&path=%2Fsearch`)
    ).json();
    expect(path.requests).toHaveLength(4);
  });

  it("paginates with limit + offset and reports hasMore", async () => {
    const now = Date.now();
    const url = await seededUrl(now);
    const p1 = await (
      await fetch(`${url}/__enpilink/agents/requests?since=0&limit=3`)
    ).json();
    expect(p1.requests).toHaveLength(3);
    expect(p1.hasMore).toBe(true);
    const p3 = await (
      await fetch(`${url}/__enpilink/agents/requests?since=0&limit=3&offset=6`)
    ).json();
    expect(p3.requests).toHaveLength(1);
    expect(p3.hasMore).toBe(false);
  });

  it("clamps an over-large page size to the hard cap", async () => {
    const now = Date.now();
    const url = await seededUrl(now);
    const body = await (
      await fetch(`${url}/__enpilink/agents/requests?since=0&limit=100000`)
    ).json();
    expect(body.limit).toBe(200);
  });

  it("degrades to { enabled: false } with no storage", async () => {
    const url = await mount(() => null);
    const res = await fetch(`${url}/__enpilink/agents/requests`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});
