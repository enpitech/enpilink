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

    it("clearConfig removes the row and audits the reset", async () => {
      await store.setConfig("k", "v1");
      await store.clearConfig("k", "bob");
      expect(await store.getConfig("k")).toBeUndefined();
      expect(await store.allConfig()).toEqual({});
      const audit = await store.getConfigAudit();
      expect(audit[0]).toMatchObject({
        key: "k",
        oldValue: "v1",
        newValue: null,
        actor: "bob",
      });
    });

    it("clearConfig is a no-op (no audit) when the key was never set", async () => {
      await store.clearConfig("absent");
      expect(await store.getConfigAudit()).toHaveLength(0);
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

    it("deleteSession removes one session; deleteUser cascades (A5)", async () => {
      await store.upsertUser?.({ sub: "u-1", createdAt: 1, lastSeenAt: 1 });
      await store.recordSession?.({
        id: "s-1",
        sub: "u-1",
        createdAt: 1,
        lastSeenAt: 1,
      });
      await store.recordSession?.({
        id: "s-2",
        sub: "u-1",
        createdAt: 1,
        lastSeenAt: 1,
      });
      await store.deleteSession?.("s-1");
      expect(await store.getSession?.("s-1")).toBeUndefined();
      expect((await store.listSessions?.()) ?? []).toHaveLength(1);

      await store.deleteUser?.("u-1");
      expect((await store.listUsers?.()) ?? []).toHaveLength(0);
      expect((await store.listSessions?.()) ?? []).toHaveLength(0);
    });
  });

  describe("agent capture (M1)", () => {
    it("batch-records and round-trips a request, preserving header order + casing", async () => {
      await store.recordAgentRequests?.([
        {
          ts: 1000,
          siteId: "default",
          method: "GET",
          path: "/products/blue",
          status: 404,
          outcome: "dead_end",
          httpVersion: "1.1",
          headers: [
            ["Host", "acme.com"],
            ["Sec-Ch-Ua", '"Chromium";v="128"'],
            ["User-Agent", "GPTBot/1.0"],
          ],
          ipHash: "abc123",
          ua: "GPTBot/1.0",
          confidence: "none",
          meta: { foo: 1 },
        },
      ]);
      const [row] = (await store.queryAgentRequests?.()) ?? [];
      expect(row).toMatchObject({
        ts: 1000,
        siteId: "default",
        path: "/products/blue",
        status: 404,
        outcome: "dead_end",
        httpVersion: "1.1",
        ipHash: "abc123",
        ua: "GPTBot/1.0",
        confidence: "none",
      });
      // Header order + original casing survive the DB round-trip.
      expect(row?.headers).toEqual([
        ["Host", "acme.com"],
        ["Sec-Ch-Ua", '"Chromium";v="128"'],
        ["User-Agent", "GPTBot/1.0"],
      ]);
      expect(row?.meta).toEqual({ foo: 1 });
    });

    it("ensureAgentSite is get-or-create: the salt is stable across calls", async () => {
      const first = await store.ensureAgentSite?.({
        id: "default",
        ipSalt: "salt-A",
        createdAt: 1,
      });
      expect(first?.ipSalt).toBe("salt-A");
      // A second call with a DIFFERENT candidate salt must keep the first.
      const second = await store.ensureAgentSite?.({
        id: "default",
        ipSalt: "salt-B",
        createdAt: 2,
      });
      expect(second?.ipSalt).toBe("salt-A");
    });

    it("prune deletes rows older than the boundary and returns the count", async () => {
      await store.recordAgentRequests?.([
        mkReq(1000),
        mkReq(2000),
        mkReq(5000),
      ]);
      expect((await store.queryAgentRequests?.()) ?? []).toHaveLength(3);
      const removed = (await store.prune?.({ before: 3000 })) ?? 0;
      expect(removed).toBe(2);
      const left = (await store.queryAgentRequests?.()) ?? [];
      expect(left.map((r) => r.ts)).toEqual([5000]);
    });
  });
});

/** A minimal agent request at a given timestamp (for prune tests). */
function mkReq(ts: number) {
  return {
    ts,
    siteId: "default",
    method: "GET",
    path: "/",
    status: 200,
    outcome: "resolved" as const,
    httpVersion: "1.1",
    headers: [["Host", "x"]] as [string, string][],
    confidence: "none" as const,
  };
}
