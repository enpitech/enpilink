import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorageAdapter } from "./sqlite.js";

describe("SqliteStorageAdapter", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteStorageAdapter;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "enpilink-sqlite-"));
    dbPath = join(dir, "test.db");
    store = new SqliteStorageAdapter({ path: dbPath });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("events", () => {
    it("records and queries events with since/tool/type/limit filters", async () => {
      await store.recordEvent({
        ts: 1,
        type: "tool_call",
        tool: "a",
        ms: 5,
        ok: true,
      });
      await store.recordEvent({
        ts: 5,
        type: "tool_call",
        tool: "a",
        ms: 9,
        ok: false,
        error: "boom",
      });
      await store.recordEvent({ ts: 10, type: "ping", tool: "b" });

      const all = await store.queryEvents({});
      expect(all.map((e) => e.ts)).toEqual([10, 5, 1]);
      expect(await store.queryEvents({ since: 5 })).toHaveLength(2);
      expect(await store.queryEvents({ tool: "a" })).toHaveLength(2);
      expect(await store.queryEvents({ type: "ping" })).toHaveLength(1);
      expect(await store.queryEvents({ limit: 1 })).toHaveLength(1);

      const errored = (await store.queryEvents({ since: 5, tool: "a" }))[0];
      expect(errored).toMatchObject({ ok: false, error: "boom", ms: 9 });
    });

    it("round-trips the meta object", async () => {
      await store.recordEvent({
        ts: 1,
        type: "tool_call",
        meta: { user: "x", nested: { n: 1 } },
      });
      const [e] = await store.queryEvents({});
      expect(e?.meta).toEqual({ user: "x", nested: { n: 1 } });
    });
  });

  describe("logs", () => {
    it("appends and queries logs with level/limit/since", async () => {
      await store.appendLog({ ts: 1, level: "info", msg: "one" });
      await store.appendLog({
        ts: 2,
        level: "error",
        msg: "two",
        data: { code: 42 },
      });
      await store.appendLog({ ts: 3, level: "info", msg: "three" });

      const all = await store.queryLogs({});
      expect(all.map((l) => l.msg)).toEqual(["three", "two", "one"]);
      expect(await store.queryLogs({ level: "error" })).toHaveLength(1);
      expect(await store.queryLogs({ since: 2 })).toHaveLength(2);
      expect(await store.queryLogs({ limit: 1 })).toHaveLength(1);
      expect((await store.queryLogs({ level: "error" }))[0]?.data).toEqual({
        code: 42,
      });
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

    it("writes a config_audit row on setConfig with old → new + actor", async () => {
      await store.setConfig("k", "v1");
      await store.setConfig("k", "v2", "alice");
      const audit = store.getAuditLog();
      expect(audit).toHaveLength(2);
      // Most recent first.
      expect(audit[0]).toMatchObject({
        key: "k",
        oldValue: "v1",
        newValue: "v2",
        actor: "alice",
      });
      expect(audit[1]).toMatchObject({
        key: "k",
        oldValue: undefined,
        newValue: "v1",
        actor: "system",
      });
    });
  });

  describe("persistence", () => {
    it("retains data across close + reopen on the same path", async () => {
      await store.recordEvent({ ts: 1, type: "tool_call", tool: "persisted" });
      await store.appendLog({ ts: 1, level: "warning", msg: "stays" });
      await store.setConfig("flag", { on: true }, "bob");
      await store.close();

      const reopened = new SqliteStorageAdapter({ path: dbPath });
      await reopened.init();
      try {
        const events = await reopened.queryEvents({});
        expect(events).toHaveLength(1);
        expect(events[0]?.tool).toBe("persisted");

        const logs = await reopened.queryLogs({});
        expect(logs[0]?.msg).toBe("stays");

        expect(await reopened.getConfig("flag")).toEqual({ on: true });
        expect(reopened.getAuditLog()).toHaveLength(1);
        expect(reopened.getAuditLog()[0]).toMatchObject({ actor: "bob" });
      } finally {
        await reopened.close();
      }
    });
  });
});
