import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveStorage } from "../log-sink.js";
import { MemoryStorageAdapter } from "../storage/memory.js";
import {
  getAgentCaptureGate,
  refreshAgentCaptureGate,
  setAgentCaptureGate,
} from "./capture-gate.js";

describe("agent capture gate", () => {
  const originalAgent = process.env.ENPILINK_AGENT;

  beforeEach(() => {
    setActiveStorage(null);
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
    delete process.env.ENPILINK_AGENT;
  });
  afterEach(() => {
    setActiveStorage(null);
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
    if (originalAgent === undefined) {
      delete process.env.ENPILINK_AGENT;
    } else {
      process.env.ENPILINK_AGENT = originalAgent;
    }
  });

  it("is OFF by default (before any resolve)", () => {
    expect(getAgentCaptureGate().enabled).toBe(false);
  });

  it("resolves agent.enabled / agent.sampleRate from the DB (live toggle)", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init();
    setActiveStorage(storage);

    await refreshAgentCaptureGate();
    expect(getAgentCaptureGate().enabled).toBe(false); // default

    await storage.setConfig("agent.enabled", true);
    await storage.setConfig("agent.sampleRate", 0.5);
    await storage.setConfig("agent.verifyIpRanges", true);
    await storage.setConfig("agent.serve", true);
    await storage.setConfig("agent.site.title", "Acme");
    await refreshAgentCaptureGate();
    expect(getAgentCaptureGate()).toEqual({
      enabled: true,
      sampleRate: 0.5,
      verifyIpRanges: true,
      serve: true,
      siteTitle: "Acme",
      siteDescription: "",
      spa: false,
      reencode: false,
      getTransport: false,
      getRateLimit: 60,
      getRateBurst: 10,
      rulesetEnabled: true,
      rulesetUrl: "https://cdn.enpitech.dev/agent/ruleset/v1.json",
      rulesetTtlSeconds: 0,
      rulesetTimeoutMs: 5000,
      rulesetMode: "live",
    });

    await storage.close();
  });

  it("env-pins agent.enabled (env > db)", async () => {
    process.env.ENPILINK_AGENT = "1";
    const storage = new MemoryStorageAdapter();
    await storage.init();
    await storage.setConfig("agent.enabled", false); // db says off
    setActiveStorage(storage);

    await refreshAgentCaptureGate();
    expect(getAgentCaptureGate().enabled).toBe(true); // env wins

    await storage.close();
  });

  it("degrades safely (never throws) when the storage read fails", async () => {
    setAgentCaptureGate({ enabled: true, sampleRate: 1 });
    setActiveStorage({
      allConfig: async () => {
        throw new Error("db down");
      },
    } as unknown as MemoryStorageAdapter);
    // resolveConfig swallows the storage error and falls back to defaults, so
    // the refresh must not throw and the gate settles to the safe default (OFF).
    await expect(refreshAgentCaptureGate()).resolves.toBeDefined();
    expect(getAgentCaptureGate().enabled).toBe(false);
  });
});
