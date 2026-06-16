import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "./memory.js";

describe("MemoryStorageAdapter", () => {
  let store: MemoryStorageAdapter;

  beforeEach(async () => {
    store = new MemoryStorageAdapter({ cap: 100 });
    await store.init();
  });

  describe("events", () => {
    it("records and queries events, most recent first", async () => {
      await store.recordEvent({ ts: 1, type: "tool_call", tool: "a" });
      await store.recordEvent({ ts: 2, type: "tool_call", tool: "b" });
      const all = await store.queryEvents({});
      expect(all.map((e) => e.tool)).toEqual(["b", "a"]);
    });

    it("filters by since, tool, and limit", async () => {
      await store.recordEvent({ ts: 1, type: "tool_call", tool: "a" });
      await store.recordEvent({ ts: 5, type: "tool_call", tool: "a" });
      await store.recordEvent({ ts: 10, type: "ping", tool: "b" });

      expect(await store.queryEvents({ since: 5 })).toHaveLength(2);
      expect(await store.queryEvents({ tool: "a" })).toHaveLength(2);
      expect(await store.queryEvents({ type: "ping" })).toHaveLength(1);
      expect(await store.queryEvents({ limit: 1 })).toHaveLength(1);
      expect((await store.queryEvents({ limit: 1 }))[0]?.ts).toBe(10);
    });

    it("drops oldest events past the cap", async () => {
      const small = new MemoryStorageAdapter({ cap: 3 });
      await small.init();
      for (let i = 0; i < 10; i++) {
        await small.recordEvent({ ts: i, type: "tool_call" });
      }
      const all = await small.queryEvents({});
      expect(all).toHaveLength(3);
      expect(all.map((e) => e.ts)).toEqual([9, 8, 7]);
    });
  });

  describe("logs", () => {
    it("appends and queries logs with level + limit filters", async () => {
      await store.appendLog({ ts: 1, level: "info", msg: "one" });
      await store.appendLog({ ts: 2, level: "error", msg: "two" });
      await store.appendLog({ ts: 3, level: "info", msg: "three" });

      const all = await store.queryLogs({});
      expect(all.map((l) => l.msg)).toEqual(["three", "two", "one"]);
      expect(await store.queryLogs({ level: "error" })).toHaveLength(1);
      expect(await store.queryLogs({ since: 2 })).toHaveLength(2);
      expect(await store.queryLogs({ limit: 1 })).toHaveLength(1);
    });
  });

  describe("config + audit", () => {
    it("get/set/all round-trips opaque values", async () => {
      expect(await store.getConfig("missing")).toBeUndefined();
      await store.setConfig("analytics.enabled", true);
      await store.setConfig("retention", { days: 7 });
      expect(await store.getConfig("analytics.enabled")).toBe(true);
      expect(await store.getConfig("retention")).toEqual({ days: 7 });
      expect(await store.allConfig()).toEqual({
        "analytics.enabled": true,
        retention: { days: 7 },
      });
    });

    it("writes an audit row on setConfig with old → new + actor", async () => {
      await store.setConfig("k", "v1");
      await store.setConfig("k", "v2", "alice");
      const audit = store.getAuditLog();
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({
        key: "k",
        oldValue: undefined,
        newValue: "v1",
        actor: "system",
      });
      expect(audit[1]).toMatchObject({
        key: "k",
        oldValue: "v1",
        newValue: "v2",
        actor: "alice",
      });
    });
  });
});
