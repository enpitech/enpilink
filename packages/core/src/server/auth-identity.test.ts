// @vitest-environment node
import http from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, OAuthTokenVerifier } from "./auth.js";
import {
  type AuthIdentity,
  buildIdentity,
  IDENTITY_TOOL_NAME,
} from "./auth-identity.js";
import { createApp } from "./express.js";
import { McpServer } from "./server.js";

vi.mock("@enpilink/console", () => ({
  devtoolsStaticServer: () =>
    ((_req: unknown, _res: unknown, next: () => void) =>
      next()) as RequestHandler,
}));

vi.mock("./viewsDevServer.js", () => ({
  viewsDevServer: (_httpServer: unknown) =>
    ((_req: unknown, _res: unknown, next: () => void) =>
      next()) as RequestHandler,
}));

/**
 * A4 acceptance — the auto-registered built-in identity tool (`enpilink_whoami`)
 * returns the right `{ state, sub, isGuest, scopes, email, name }` for
 * anonymous / guest / authed callers. Proven with a SYNTHETIC MCP client (raw
 * JSON-RPC over HTTP), reusing the A1 harness. No real host / no JWKS network.
 */

let openServer: http.Server | undefined;
afterEach(() => {
  openServer?.close();
  openServer = undefined;
});

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const ISSUER = "https://auth.example.com";

function stubVerifier(table: Record<string, AuthInfo>): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const info = table[token];
      if (!info) {
        throw new Error("unknown token");
      }
      return info;
    },
  };
}

function authEnabled(verifier: OAuthTokenVerifier): AuthConfig {
  return {
    enabled: true,
    issuer: ISSUER,
    audience: "https://rs.example.com/mcp",
    verifier,
    resourceServerUrl: "https://rs.example.com/mcp",
  };
}

async function start(server: McpServer): Promise<number> {
  const httpServer = http.createServer();
  const app = await createApp({ mcpServer: server, httpServer });
  const listening = http.createServer(app);
  await new Promise<void>((resolve) => listening.listen(0, resolve));
  openServer = listening;
  return (listening.address() as { port: number }).port;
}

async function whoami(port: number, token?: string): Promise<AuthIdentity> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: IDENTITY_TOOL_NAME, arguments: {} },
      id: 1,
    }),
  });
  expect(res.status).toBe(200);
  const payload = (await res.json()) as {
    result: { structuredContent: AuthIdentity };
  };
  return payload.result.structuredContent;
}

describe("A4 — built-in identity tool (auto-registered when auth on)", () => {
  it("anonymous: no token → state anonymous", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" }, undefined, {
      auth: authEnabled(stubVerifier({})),
    });
    const port = await start(server);

    const id = await whoami(port);
    expect(id.state).toBe("anonymous");
    expect(id.sub).toBeUndefined();
    expect(id.isGuest).toBe(false);
    expect(id.scopes).toEqual([]);
  });

  it("guest: a guest:* sub → state guest", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" }, undefined, {
      auth: authEnabled(
        stubVerifier({
          "guest-token": {
            token: "guest-token",
            clientId: "c",
            scopes: ["guest"],
            expiresAt: FUTURE,
            extra: { sub: "guest:xyz", guest: true },
          },
        }),
      ),
    });
    const port = await start(server);

    const id = await whoami(port, "guest-token");
    expect(id.state).toBe("guest");
    expect(id.isGuest).toBe(true);
    expect(id.sub).toBe("guest:xyz");
    expect(id.scopes).toEqual(["guest"]);
  });

  it("authed: a real sub → state authed, surfaces email/name, never a token", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" }, undefined, {
      auth: authEnabled(
        stubVerifier({
          "good-token": {
            token: "good-token",
            clientId: "c",
            scopes: ["openid", "profile"],
            expiresAt: FUTURE,
            extra: {
              sub: "user-123",
              email: "ada@example.com",
              name: "Ada Lovelace",
            },
          },
        }),
      ),
    });
    const port = await start(server);

    const id = await whoami(port, "good-token");
    expect(id.state).toBe("authed");
    expect(id.isGuest).toBe(false);
    expect(id.sub).toBe("user-123");
    expect(id.email).toBe("ada@example.com");
    expect(id.name).toBe("Ada Lovelace");
    expect(id.scopes).toContain("openid");
    // Never leak the token.
    expect(JSON.stringify(id)).not.toContain("good-token");
  });

  it("auth OFF: the identity tool is NOT registered", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const port = await start(server);

    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: IDENTITY_TOOL_NAME, arguments: {} },
        id: 1,
      }),
    });
    const text = await res.text();
    // The tool does not exist → JSON-RPC error (not a 200 success result).
    expect(text).toMatch(/error|not found|unknown|Tool/i);
  });
});

describe("A4 — buildIdentity (pure)", () => {
  it("anonymous when no authInfo", () => {
    expect(buildIdentity({})).toEqual({
      state: "anonymous",
      isGuest: false,
      scopes: [],
    });
  });

  it("guest from the guest: sub prefix", () => {
    const id = buildIdentity({
      authInfo: {
        token: "t",
        clientId: "c",
        scopes: ["guest"],
        extra: { sub: "guest:1" },
      },
    });
    expect(id.state).toBe("guest");
    expect(id.isGuest).toBe(true);
  });

  it("authed from a real sub + claims", () => {
    const id = buildIdentity({
      authInfo: {
        token: "t",
        clientId: "c",
        scopes: ["openid"],
        extra: { sub: "u1", email: "x@y.z", name: "X" },
      },
    });
    expect(id.state).toBe("authed");
    expect(id.email).toBe("x@y.z");
    expect(id.name).toBe("X");
  });
});
