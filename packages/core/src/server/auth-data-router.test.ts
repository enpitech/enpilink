import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthDataRouter } from "./auth-data-router.js";
import {
  clearRevocations,
  isTokenRefRevoked,
  tokenRef,
} from "./auth-revocation.js";
import { MemoryStorageAdapter } from "./storage/memory.js";
import type { StorageAdapter } from "./storage/types.js";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return { port, server };
}

function appWith(getStorage: () => StorageAdapter | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createAuthDataRouter(getStorage));
  return app;
}

let openServer: http.Server | undefined;

beforeEach(() => clearRevocations());
afterEach(() => {
  openServer?.close();
  openServer = undefined;
  clearRevocations();
});

async function seeded(): Promise<MemoryStorageAdapter> {
  const store = new MemoryStorageAdapter();
  await store.init();
  await store.upsertUser({
    sub: "user-1",
    issuer: "https://idp",
    createdAt: 100,
    lastSeenAt: 200,
    email: "a@b.c",
    name: "Alice",
  });
  await store.upsertUser({
    sub: "guest:abc",
    createdAt: 50,
    lastSeenAt: 60,
  });
  await store.recordSession({
    id: "sess-authed",
    sub: "user-1",
    clientId: "chatgpt",
    tokenRef: "abc123def456",
    scopes: ["read", "write"],
    createdAt: 100,
    lastSeenAt: 200,
    // Far-future expiry (epoch seconds) so the revocation denylist entry is
    // still live when asserted (a lapsed token auto-evicts).
    expiresAt: 9_999_999_999,
  });
  await store.recordSession({
    id: "sess-guest",
    sub: "guest:abc",
    tokenRef: "guestref",
    scopes: ["guest"],
    createdAt: 50,
    lastSeenAt: 60,
  });
  return store;
}

describe("createAuthDataRouter — read", () => {
  it("lists sessions + users with isGuest flags and no secrets", async () => {
    const store = await seeded();
    const { port, server } = await listen(appWith(() => store));
    openServer = server;

    const sRes = await fetch(
      `http://localhost:${port}/__enpilink/auth/sessions`,
    );
    expect(sRes.status).toBe(200);
    const sBody = (await sRes.json()) as {
      enabled: boolean;
      sessions: Array<Record<string, unknown>>;
    };
    expect(sBody.enabled).toBe(true);
    expect(sBody.sessions).toHaveLength(2);
    const guest = sBody.sessions.find((s) => s.id === "sess-guest");
    const authed = sBody.sessions.find((s) => s.id === "sess-authed");
    expect(guest?.isGuest).toBe(true);
    expect(authed?.isGuest).toBe(false);
    // tokenRef is exposed (opaque), but no raw token/secret field exists.
    const serialized = JSON.stringify(sBody);
    expect(serialized).not.toMatch(/access_token|signingKey|client_secret/i);

    const uRes = await fetch(`http://localhost:${port}/__enpilink/auth/users`);
    const uBody = (await uRes.json()) as {
      enabled: boolean;
      users: Array<Record<string, unknown>>;
    };
    expect(uBody.enabled).toBe(true);
    expect(uBody.users).toHaveLength(2);
    expect(uBody.users.find((u) => u.sub === "guest:abc")?.isGuest).toBe(true);
  });

  it("returns enabled:false empty payloads (never 500) when storage is absent", async () => {
    const { port, server } = await listen(appWith(() => null));
    openServer = server;

    const s = await fetch(`http://localhost:${port}/__enpilink/auth/sessions`);
    expect(s.status).toBe(200);
    expect(await s.json()).toEqual({ enabled: false, sessions: [] });

    const u = await fetch(`http://localhost:${port}/__enpilink/auth/users`);
    expect(u.status).toBe(200);
    expect(await u.json()).toEqual({ enabled: false, users: [] });
  });

  it("returns enabled:false when storage predates the auth methods", async () => {
    // A minimal adapter without listSessions/listUsers (pre-A2 custom adapter).
    const bare = { init: async () => {} } as unknown as StorageAdapter;
    const { port, server } = await listen(appWith(() => bare));
    openServer = server;
    const s = await fetch(`http://localhost:${port}/__enpilink/auth/sessions`);
    expect((await s.json()) as unknown).toEqual({
      enabled: false,
      sessions: [],
    });
  });
});

describe("createAuthDataRouter — revoke", () => {
  it("revokes a session: deletes the row AND denylists its tokenRef", async () => {
    const store = await seeded();
    const { port, server } = await listen(appWith(() => store));
    openServer = server;

    expect(isTokenRefRevoked("abc123def456")).toBe(false);
    const res = await fetch(
      `http://localhost:${port}/__enpilink/auth/sessions/sess-authed`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      ok: true,
      revoked: true,
    });
    // Row gone.
    expect(await store.getSession("sess-authed")).toBeUndefined();
    // Token denylisted (true revocation).
    expect(isTokenRefRevoked("abc123def456")).toBe(true);
  });

  it("deletes a user and cascade-revokes their sessions' tokens", async () => {
    const store = await seeded();
    const { port, server } = await listen(appWith(() => store));
    openServer = server;

    const res = await fetch(
      `http://localhost:${port}/__enpilink/auth/users/user-1`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      ok: true,
      revoked: 1,
    });
    expect((await store.listUsers()).map((u) => u.sub)).not.toContain("user-1");
    expect(isTokenRefRevoked("abc123def456")).toBe(true);
  });

  it("501s revoke when the adapter does not support deletion", async () => {
    const bare = {
      init: async () => {},
      listSessions: async () => [],
      listUsers: async () => [],
    } as unknown as StorageAdapter;
    const { port, server } = await listen(appWith(() => bare));
    openServer = server;
    const res = await fetch(
      `http://localhost:${port}/__enpilink/auth/sessions/x`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(501);
  });
});

describe("revocableVerifier denylist", () => {
  it("a revoked token fails verification (→ 401)", async () => {
    const { revocableVerifier } = await import("./auth-revocation.js");
    const token = "dummy.jwt.token";
    let calls = 0;
    const verifier = revocableVerifier({
      async verifyAccessToken() {
        calls += 1;
        return { token, clientId: "c", scopes: [], expiresAt: 9_999_999_999 };
      },
    });
    // Not revoked yet → passes.
    await expect(verifier.verifyAccessToken(token)).resolves.toBeTruthy();
    expect(calls).toBe(1);
    // Revoke by the same reference the router would use.
    const { revokeTokenRef } = await import("./auth-revocation.js");
    revokeTokenRef(tokenRef(token), 9_999_999_999);
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(/revoked/i);
  });
});
