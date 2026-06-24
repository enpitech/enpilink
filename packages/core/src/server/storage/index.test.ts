import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStorageAdapter } from "./index.js";
import { MemoryStorageAdapter } from "./memory.js";
import { SqliteStorageAdapter } from "./sqlite.js";

describe("resolveStorageAdapter — default engine", () => {
  const originalStorage = process.env.ENPILINK_STORAGE;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDbPath = process.env.ENPILINK_DB_PATH;

  const restore = (key: string, original: string | undefined) => {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  };

  afterEach(() => {
    restore("ENPILINK_STORAGE", originalStorage);
    restore("NODE_ENV", originalNodeEnv);
    restore("ENPILINK_DB_PATH", originalDbPath);
  });

  it("defaults to the DURABLE sqlite adapter in dev (no ENPILINK_STORAGE set)", () => {
    delete process.env.ENPILINK_STORAGE;
    delete process.env.NODE_ENV; // dev
    const adapter = resolveStorageAdapter();
    expect(adapter).toBeInstanceOf(SqliteStorageAdapter);
  });

  it("defaults to sqlite in production too (parity, no ENPILINK_STORAGE set)", () => {
    delete process.env.ENPILINK_STORAGE;
    process.env.NODE_ENV = "production";
    const adapter = resolveStorageAdapter();
    expect(adapter).toBeInstanceOf(SqliteStorageAdapter);
  });

  it("honors ENPILINK_STORAGE=memory as an explicit opt-out", () => {
    process.env.ENPILINK_STORAGE = "memory";
    delete process.env.NODE_ENV; // dev
    const adapter = resolveStorageAdapter();
    expect(adapter).toBeInstanceOf(MemoryStorageAdapter);
  });

  it("ENPILINK_STORAGE=memory still gives memory in production", () => {
    process.env.ENPILINK_STORAGE = "memory";
    process.env.NODE_ENV = "production";
    const adapter = resolveStorageAdapter();
    expect(adapter).toBeInstanceOf(MemoryStorageAdapter);
  });
});

describe("sqlite persistence across a simulated restart", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "enpilink-restart-"));
    dbPath = join(dir, "enpilink.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists config + events + logs to the file so a NEW adapter on the same path reads them back", async () => {
    // --- "process 1": write through one adapter instance, then close it.
    const first = new SqliteStorageAdapter({ path: dbPath });
    await first.init();
    await first.setConfig("analytics.enabled", true, "test");
    await first.recordEvent({
      ts: 100,
      type: "tool_call",
      tool: "demo",
      ms: 5,
      ok: true,
    });
    await first.appendLog({ ts: 100, level: "info", msg: "before-restart" });
    await first.close();

    // --- "process 2": a brand new adapter instance on the same file (restart).
    const second = new SqliteStorageAdapter({ path: dbPath });
    await second.init();

    // Config survived → the capture-gate would re-enable analytics on boot.
    expect(await second.getConfig("analytics.enabled")).toBe(true);
    const all = await second.allConfig();
    expect(all["analytics.enabled"]).toBe(true);

    // Events + logs survived too.
    const events = await second.queryEvents({});
    expect(events.some((e) => e.tool === "demo")).toBe(true);
    const logs = await second.queryLogs({});
    expect(logs.some((l) => l.msg === "before-restart")).toBe(true);

    await second.close();
  });
});
