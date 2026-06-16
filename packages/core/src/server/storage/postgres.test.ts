import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PgPoolLike,
  PostgresStorageAdapter,
  resolvePostgresConnectionString,
} from "./postgres.js";

/**
 * Tests run against `pg-mem` (pure-JS in-memory Postgres). pg-mem's
 * `createPg().Pool` is a drop-in `pg.Pool`, so the adapter exercises the SAME
 * code paths it would against a real Postgres — only the engine differs. We
 * inject the pool via `opts.pool` so no real connection / env is touched.
 *
 * Each test gets a fresh `newDb()` so state is isolated and deterministic.
 */
function makePool(): PgPoolLike {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as PgPoolLike;
}

describe("PostgresStorageAdapter (pg-mem)", () => {
  let store: PostgresStorageAdapter;

  beforeEach(async () => {
    store = new PostgresStorageAdapter({ pool: makePool() });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
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

    it("upserts on repeated setConfig (no duplicate key)", async () => {
      await store.setConfig("k", "v1");
      await store.setConfig("k", "v2");
      expect(await store.getConfig("k")).toBe("v2");
      expect(Object.keys(await store.allConfig())).toEqual(["k"]);
    });

    it("writes a config_audit row on setConfig with old → new + actor (most recent first)", async () => {
      await store.setConfig("k", "v1");
      await store.setConfig("k", "v2", "alice");
      const audit = await store.getConfigAudit();
      expect(audit).toHaveLength(2);
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

  describe("persistence within a session", () => {
    it("retains writes across queries on the same pool", async () => {
      await store.recordEvent({ ts: 1, type: "tool_call", tool: "persisted" });
      await store.appendLog({ ts: 1, level: "warning", msg: "stays" });
      await store.setConfig("flag", { on: true }, "bob");

      const events = await store.queryEvents({});
      expect(events).toHaveLength(1);
      expect(events[0]?.tool).toBe("persisted");

      const logs = await store.queryLogs({});
      expect(logs[0]?.msg).toBe("stays");

      expect(await store.getConfig("flag")).toEqual({ on: true });
      const audit = await store.getConfigAudit();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor: "bob" });
    });
  });

  describe("init is idempotent", () => {
    it("can be called twice without error", async () => {
      await store.init();
      await store.recordEvent({ ts: 1, type: "tool_call" });
      expect(await store.queryEvents({})).toHaveLength(1);
    });
  });

  describe("use-before-init guard", () => {
    it("throws when querying before init", async () => {
      const s = new PostgresStorageAdapter({ pool: makePool() });
      await expect(s.queryEvents({})).rejects.toThrow(/init\(\) before use/);
    });
  });
});

describe("resolvePostgresConnectionString", () => {
  const saved = {
    url: process.env.ENPILINK_DB_URL,
    db: process.env.DATABASE_URL,
  };
  afterEach(() => {
    if (saved.url === undefined) {
      delete process.env.ENPILINK_DB_URL;
    } else {
      process.env.ENPILINK_DB_URL = saved.url;
    }
    if (saved.db === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = saved.db;
    }
  });

  it("prefers ENPILINK_DB_URL, falls back to DATABASE_URL, else undefined", () => {
    delete process.env.ENPILINK_DB_URL;
    delete process.env.DATABASE_URL;
    expect(resolvePostgresConnectionString()).toBeUndefined();

    process.env.DATABASE_URL = "postgres://db/standard";
    expect(resolvePostgresConnectionString()).toBe("postgres://db/standard");

    process.env.ENPILINK_DB_URL = "postgres://db/enpilink";
    expect(resolvePostgresConnectionString()).toBe("postgres://db/enpilink");

    // Whitespace-only is treated as unset (no hardcoded default ever).
    process.env.ENPILINK_DB_URL = "   ";
    expect(resolvePostgresConnectionString()).toBe("postgres://db/standard");
  });
});
