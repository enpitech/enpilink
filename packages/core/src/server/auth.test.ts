// @vitest-environment node
import http from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandler } from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, OAuthTokenVerifier } from "./auth.js";
import { createJwtVerifier, getAuthInfo } from "./auth.js";
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
 * A1 acceptance — resource-server auth foundation, proven with a SYNTHETIC MCP
 * client (raw JSON-RPC over HTTP). No real host / no real JWKS network.
 */

let openServer: http.Server | undefined;
afterEach(() => {
  openServer?.close();
  openServer = undefined;
});

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

/**
 * A deterministic stub verifier: maps a fixed set of opaque tokens to
 * principals. No network, no JWT parsing — exactly the injection seam A2 / the
 * tests use.
 */
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

const ISSUER = "https://auth.example.com";

async function start(server: McpServer): Promise<number> {
  const httpServer = http.createServer();
  const app = await createApp({ mcpServer: server, httpServer });
  const listening = http.createServer(app);
  await new Promise<void>((resolve) => listening.listen(0, resolve));
  openServer = listening;
  return (listening.address() as { port: number }).port;
}

async function callTool(
  port: number,
  name: string,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: {} },
      id: 1,
    }),
  });
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

describe("A1 — auth disabled (default): existing apps unaffected", () => {
  it("does not require a token and serves no PRM metadata", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" }).registerTool(
      { name: "ping", inputSchema: {} },
      async () => ({ content: "pong" }),
    );
    const port = await start(server);

    // Tokenless tools/call → NOT a 401 (auth is off).
    const res = await callTool(port, "ping");
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);

    // No protected-resource metadata endpoint.
    const prm = await fetch(
      `http://localhost:${port}/.well-known/oauth-protected-resource`,
    );
    expect(prm.status).toBe(404);
  });
});

describe("A1 — auth enabled: PRM metadata", () => {
  it("serves RFC 9728 PRM listing the configured AS", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" }, undefined, {
      auth: authEnabled(stubVerifier({})),
    }).registerTool({ name: "ping", inputSchema: {} }, async () => ({
      content: "pong",
    }));
    const port = await start(server);

    const prm = await fetch(
      `http://localhost:${port}/.well-known/oauth-protected-resource`,
    );
    expect(prm.status).toBe(200);
    const body = (await prm.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(body.authorization_servers).toContain(ISSUER);
    expect(body.resource).toContain("rs.example.com");
  });
});

describe("A1 — auth enabled: tokenless → 401 challenge", () => {
  it("a protected tool with no token → 401 + WWW-Authenticate with resource_metadata", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" }, undefined, {
      auth: authEnabled(stubVerifier({})),
    }).registerTool(
      {
        name: "secret",
        inputSchema: {},
        securitySchemes: [{ type: "oauth2" }],
      },
      async () => ({ content: "top secret" }),
    );
    const port = await start(server);

    const res = await callTool(port, "secret");
    expect(res.status).toBe(401);
    const wch = res.headers.get("WWW-Authenticate") ?? "";
    expect(wch).toMatch(/^Bearer/);
    expect(wch).toContain("resource_metadata=");
  });
});

describe("A1 — auth enabled: valid token reaches the handler", () => {
  it("a valid token → tool handler sees extra.authInfo with the expected sub/scopes", async () => {
    const seen: { sub?: string; scopes: string[] } = { scopes: [] };
    const verifier = stubVerifier({
      "good-token": {
        token: "good-token",
        clientId: "client-1",
        scopes: ["read"],
        expiresAt: FUTURE,
        extra: { sub: "user-123" },
      },
    });
    const server = new McpServer({ name: "t", version: "0.0.0" }, undefined, {
      auth: authEnabled(verifier),
    }).registerTool(
      {
        name: "me",
        inputSchema: {},
        securitySchemes: [{ type: "oauth2", scopes: ["read"] }],
      },
      async (_args, extra) => {
        const id = getAuthInfo(extra);
        seen.sub = id?.sub;
        seen.scopes = id?.scopes ?? [];
        return { content: `hello ${id?.sub}` };
      },
    );
    const port = await start(server);

    const res = await callTool(port, "me", "good-token");
    expect(res.status).toBe(200);
    expect(seen.sub).toBe("user-123");
    expect(seen.scopes).toContain("read");
  });
});

describe("A1 — auth enabled: per-tool securityScheme enforcement", () => {
  it("oauth2 tool with a token missing the scope → 403 insufficient_scope", async () => {
    const verifier = stubVerifier({
      "weak-token": {
        token: "weak-token",
        clientId: "c",
        scopes: ["read"],
        expiresAt: FUTURE,
        extra: { sub: "u1" },
      },
    });
    const server = new McpServer({ name: "t", version: "0.0.0" }, undefined, {
      auth: authEnabled(verifier),
    }).registerTool(
      {
        name: "admin-op",
        inputSchema: {},
        securitySchemes: [{ type: "oauth2", scopes: ["admin"] }],
      },
      async () => ({ content: "did admin thing" }),
    );
    const port = await start(server);

    const res = await callTool(port, "admin-op", "weak-token");
    expect(res.status).toBe(403);
    const wch = res.headers.get("WWW-Authenticate") ?? "";
    expect(wch).toContain("insufficient_scope");
    expect(wch).toContain('scope="admin"');
  });

  it("a { type: noauth } tool runs with NO token even when auth is on", async () => {
    let ran = false;
    const server = new McpServer({ name: "t", version: "0.0.0" }, undefined, {
      auth: authEnabled(stubVerifier({})),
    }).registerTool(
      {
        name: "public",
        inputSchema: {},
        securitySchemes: [{ type: "noauth" }],
      },
      async () => {
        ran = true;
        return { content: "anyone can call me" };
      },
    );
    const port = await start(server);

    const res = await callTool(port, "public");
    expect(res.status).toBe(200);
    expect(ran).toBe(true);
  });
});

describe("A1 — JWT verifier (no network: injected local key set)", () => {
  it("verifies a signed JWT, surfaces sub/scopes, and rejects bad aud", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    const getKey = createLocalJWKSet({ keys: [jwk] });

    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: "https://rs.example.com/mcp",
      getKey,
    });

    const goodJwt = await new SignJWT({ scope: "read write", sub: "user-9" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience("https://rs.example.com/mcp")
      .setExpirationTime("1h")
      .sign(privateKey);

    const info = await verifier.verifyAccessToken(goodJwt);
    expect(info.scopes).toEqual(["read", "write"]);
    expect((info.extra as { sub?: string }).sub).toBe("user-9");

    // Wrong audience → rejected.
    const wrongAud = await new SignJWT({ sub: "user-9" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience("https://other.example.com")
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(verifier.verifyAccessToken(wrongAud)).rejects.toThrow();
  });
});

describe("A1 — getAuthInfo helper", () => {
  it("returns undefined for an unauthenticated (guest) call", () => {
    expect(getAuthInfo({})).toBeUndefined();
  });

  it("reads sub + scopes + claims from extra.authInfo", () => {
    const id = getAuthInfo({
      authInfo: {
        token: "t",
        clientId: "c",
        scopes: ["a", "b"],
        extra: { sub: "u-1", email: "x@y.z" },
      },
    });
    expect(id?.sub).toBe("u-1");
    expect(id?.scopes).toEqual(["a", "b"]);
    expect(id?.claims.email).toBe("x@y.z");
  });
});
