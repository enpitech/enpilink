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

    it("clearConfig removes the override and audits old → undefined", async () => {
      await store.setConfig("k", "v1");
      await store.clearConfig("k", "bob");
      expect(await store.getConfig("k")).toBeUndefined();
      expect(await store.allConfig()).toEqual({});
      const audit = await store.getConfigAudit();
      expect(audit[0]).toMatchObject({
        key: "k",
        oldValue: "v1",
        newValue: undefined,
        actor: "bob",
      });
    });

    it("clearConfig is a no-op (no audit) when the key was never set", async () => {
      await store.clearConfig("absent");
      expect(await store.getConfigAudit()).toHaveLength(0);
    });
  });

  describe("auth users + sessions (A2)", () => {
    it("upserts a user (createdAt sticks, lastSeenAt bumps) and lists it", async () => {
      await store.upsertUser?.({
        sub: "u-1",
        issuer: "iss",
        createdAt: 100,
        lastSeenAt: 100,
        email: "a@b.c",
      });
      await store.upsertUser?.({
        sub: "u-1",
        issuer: "iss",
        createdAt: 999,
        lastSeenAt: 200,
      });
      const users = (await store.listUsers?.()) ?? [];
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        sub: "u-1",
        createdAt: 100,
        lastSeenAt: 200,
        email: "a@b.c",
      });
    });

    it("records a session, reads it back, and refreshes on repeat id", async () => {
      const s = {
        id: "sess-1",
        sub: "u-1",
        issuer: "iss",
        clientId: "c",
        tokenRef: "deadbeef",
        scopes: ["read", "write"],
        createdAt: 100,
        lastSeenAt: 100,
        expiresAt: 9999,
      };
      await store.recordSession?.(s);
      await store.recordSession?.({ ...s, lastSeenAt: 250 });
      const got = await store.getSession?.("sess-1");
      expect(got).toMatchObject({
        sub: "u-1",
        tokenRef: "deadbeef",
        createdAt: 100,
        lastSeenAt: 250,
      });
      expect(got?.scopes).toEqual(["read", "write"]);
      const all = (await store.listSessions?.()) ?? [];
      expect(all).toHaveLength(1);
      const filtered = (await store.listSessions?.({ sub: "absent" })) ?? [];
      expect(filtered).toHaveLength(0);
    });
  });
});
