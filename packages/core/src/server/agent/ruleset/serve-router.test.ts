import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentCaptureGate, setAgentCaptureGate } from "../capture-gate.js";
import { classify } from "../detect.js";
import { RulesetClient, type RulesetClientConfig } from "./client.js";
import { buildRulesetArtifact } from "./publish.js";
import {
  createRulesetServeRouter,
  createRulesetStatusRouter,
  RULESET_SERVE_PATH,
  RULESET_STATUS_PATH,
  resetServedArtifactCache,
  servedMaxAgeSeconds,
} from "./serve-router.js";

const OFF_GATE: AgentCaptureGate = { enabled: false, sampleRate: 1 };

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
  setAgentCaptureGate(OFF_GATE);
  resetServedArtifactCache();
});

async function mount(routers: express.Router[]): Promise<string> {
  const app = express();
  for (const r of routers) {
    app.use(r);
  }
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

describe("servedMaxAgeSeconds", () => {
  it("dev mode forces a short max-age", () => {
    expect(servedMaxAgeSeconds("dev", 0)).toBe(30);
    expect(servedMaxAgeSeconds("dev", 999)).toBe(30);
  });
  it("live mode uses the TTL override, or the 1h default when 0", () => {
    expect(servedMaxAgeSeconds("live", 0)).toBe(3600);
    expect(servedMaxAgeSeconds("live", 120)).toBe(120);
  });
});

describe("createRulesetServeRouter (the self-host endpoint)", () => {
  it("serves the versioned artifact with a Cache-Control header", async () => {
    setAgentCaptureGate({
      ...OFF_GATE,
      rulesetMode: "live",
      rulesetTtlSeconds: 0,
    });
    const url = await mount([createRulesetServeRouter()]);
    const res = await fetch(`${url}${RULESET_SERVE_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const expected = buildRulesetArtifact();
    expect(res.headers.get("x-enpilink-ruleset-version")).toBe(
      expected.version,
    );
    const body = await res.json();
    expect(body.version).toBe(expected.version);
    // It is exactly the pipeline's artifact — the CDN and self-host agree.
    expect(body).toEqual(expected.body);
  });

  it("reflects the dashboard mode/TTL in Cache-Control (the live-mode knob)", async () => {
    setAgentCaptureGate({ ...OFF_GATE, rulesetMode: "dev" });
    const url = await mount([createRulesetServeRouter()]);
    const res = await fetch(`${url}${RULESET_SERVE_PATH}`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
  });
});

describe("D2 client consumes the self-host endpoint", () => {
  it("fetches + validates + classifies a known agent at the served version", async () => {
    setAgentCaptureGate({ ...OFF_GATE, rulesetMode: "live" });
    const url = await mount([createRulesetServeRouter()]);

    const config: RulesetClientConfig = {
      enabled: true,
      url: `${url}${RULESET_SERVE_PATH}`,
      ttlSeconds: 0,
      timeoutMs: 5000,
      mode: "live",
    };
    const client = new RulesetClient({ getConfig: () => config });

    // Awaiting refresh is fine in a TEST — the response-path guarantee (never
    // await) is proven elsewhere; here we assert the fetched artifact is live.
    await client.refresh();

    const ruleset = client.getRuleset();
    expect(ruleset).not.toBeNull();
    expect(ruleset?.version).toBe(buildRulesetArtifact().version);

    const det = classify(ruleset, [["User-Agent", "GPTBot/1.1"]]);
    expect(det.family).toBe("gptbot");
    expect(det.class).toBe("crawler");
    expect(client.getStatus().source).toBe("network");
    client.stop();
  });
});

describe("createRulesetStatusRouter", () => {
  it("returns the injected live status", async () => {
    const url = await mount([
      createRulesetStatusRouter(() => ({
        enabled: true,
        loaded: true,
        version: "2026-07-23-abc123",
        fetchedAt: 1000,
        source: "network",
        mode: "live",
        ttlSeconds: 0,
        url: "https://cdn.enpitech.dev/agent/ruleset/v1.json",
        fetchEnabled: true,
      })),
    ]);
    const res = await fetch(`${url}${RULESET_STATUS_PATH}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.version).toBe("2026-07-23-abc123");
    expect(body.source).toBe("network");
  });

  it("degrades to { enabled: false }, never a 500", async () => {
    const url = await mount([
      createRulesetStatusRouter(() => {
        throw new Error("boom");
      }),
    ]);
    const res = await fetch(`${url}${RULESET_STATUS_PATH}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});
