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
      // Cascade: the remaining session is gone too.
      expect((await store.listSessions?.()) ?? []).toHaveLength(0);
    });
  });

  describe("agent capture (M1)", () => {
    it("round-trips records (defensive header copy) and filters by since/until", async () => {
      await store.recordAgentRequests?.([
        memReq(1000),
        memReq(2000),
        memReq(5000),
      ]);
      const all = (await store.queryAgentRequests?.()) ?? [];
      expect(all.map((r) => r.ts)).toEqual([5000, 2000, 1000]);
      expect((await store.queryAgentRequests?.({ since: 2000 }))?.length).toBe(
        2,
      );
      expect((await store.queryAgentRequests?.({ until: 2000 }))?.length).toBe(
        1,
      );

      // The stored headers are a copy — mutating a returned row is harmless.
      const [row] = all;
      row?.headers.push(["X", "y"]);
      const fresh = (await store.queryAgentRequests?.()) ?? [];
      expect(fresh[0]?.headers).toEqual([["Host", "x"]]);
    });

    it("round-trips the served flag, filters by class, and aggregates outcomes (M4)", async () => {
      await store.recordAgentRequests?.([
        {
          ts: 1000,
          siteId: "default",
          method: "GET",
          path: "/",
          status: 200,
          outcome: "resolved",
          httpVersion: "1.1",
          headers: [["Host", "x"]],
          confidence: "none",
          agentClass: "chat-fetcher",
          agentFamily: "gemini",
          served: true,
          servedEncoding: "markdown",
        },
        {
          ts: 2000,
          siteId: "default",
          method: "POST",
          path: "/contact",
          status: 403,
          outcome: "blocked",
          httpVersion: "1.1",
          headers: [["Host", "x"]],
          confidence: "none",
          agentClass: "cli",
          agentFamily: "claude-code",
        },
      ]);
      const served = (await store.queryAgentRequests?.())?.find(
        (r) => r.path === "/",
      );
      expect(served?.served).toBe(true);
      expect(served?.servedEncoding).toBe("markdown");

      const cli =
        (await store.queryAgentRequests?.({ classes: ["cli"] })) ?? [];
      expect(cli).toHaveLength(1);

      const groups = (await store.aggregateAgentOutcomes?.()) ?? [];
      expect(groups.reduce((a, g) => a + g.count, 0)).toBe(2);
      expect(groups.find((g) => g.method === "POST")?.outcome).toBe("blocked");
      expect(groups.find((g) => g.served)?.count).toBe(1);
    });

    it("ensureAgentSite keeps the first salt", async () => {
      const a = await store.ensureAgentSite?.({
        id: "default",
        ipSalt: "salt-A",
        createdAt: 1,
      });
      const b = await store.ensureAgentSite?.({
        id: "default",
        ipSalt: "salt-B",
        createdAt: 2,
      });
      expect(a?.ipSalt).toBe("salt-A");
      expect(b?.ipSalt).toBe("salt-A");
    });

    it("prune deletes rows older than the boundary and returns the count", async () => {
      await store.recordAgentRequests?.([
        memReq(1000),
        memReq(2000),
        memReq(5000),
      ]);
      const removed = (await store.prune?.({ before: 3000 })) ?? 0;
      expect(removed).toBe(2);
      const left = (await store.queryAgentRequests?.()) ?? [];
      expect(left.map((r) => r.ts)).toEqual([5000]);
    });
  });
});

/** A minimal agent request at a given timestamp. */
function memReq(ts: number) {
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
