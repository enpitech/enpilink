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
  outcome?: AgentRequestRecord["outcome"];
  agentFamily?: string;
  agentClass?: AgentClass;
  ipHash?: string;
  method?: string;
  served?: boolean;
}): AgentRequestRecord {
  return {
    ts: p.ts,
    siteId: "default",
    method: p.method ?? "GET",
    path: "/",
    status: p.outcome === "dead_end" ? 404 : 200,
    outcome: p.outcome ?? "resolved",
    httpVersion: "1.1",
    headers: [],
    confidence: "none",
    ...(p.agentFamily !== undefined ? { agentFamily: p.agentFamily } : {}),
    ...(p.agentClass !== undefined ? { agentClass: p.agentClass } : {}),
    ...(p.ipHash !== undefined ? { ipHash: p.ipHash } : {}),
    ...(p.served ? { served: true } : {}),
  };
}

/** A representative seed: chat-fetchers (served + dead-ends) plus a recovering CLI. */
function seedRecords(now: number): AgentRequestRecord[] {
  return [
    rec({
      ts: now - 5 * MIN,
      agentFamily: "gemini",
      agentClass: "chat-fetcher",
      served: true,
    }),
    rec({
      ts: now - 5 * MIN,
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
    expect(summary.outcomes.deadEnds).toBe(3);
    expect(summary.outcomes.served.total).toBe(2);
    expect(summary.sessions.recovery.recovered).toBe(1);
    // The headline names requests, dead-ends and the served count.
    expect(summary.headline).toContain("6 requests");
    expect(summary.headline).toContain("3 dead-ends");
    expect(summary.headline).toContain("served 2 self-sufficient responses");
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
    expect(body.outcomes.deadEnds).toBe(3);
    expect(body.outcomes.served.total).toBe(2);
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
