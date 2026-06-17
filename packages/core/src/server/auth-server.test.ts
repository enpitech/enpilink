// @vitest-environment node
import http from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import express, { type RequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, OAuthTokenVerifier } from "./auth.js";
import { getAuthInfo } from "./auth.js";
import { persistSession, recordingVerifier } from "./auth-server.js";
import { createApp } from "./express.js";
import { McpServer } from "./server.js";
import { MemoryStorageAdapter } from "./storage/memory.js";

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
 * A2 acceptance — co-hosted proxy Authorization Server + branded login +
 * session persistence. Proven with a SYNTHETIC OAuth client and a STUBBED
 * upstream IdP (a local express server) — NO real network, NO real host.
 */

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers) {
    s.close();
  }
  servers.length = 0;
});

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const UPSTREAM_TOKEN = "upstream-access-token-xyz";

/** Spin up a fake upstream IdP: an /authorize that redirects back with a code,
 * and a /token that returns a fixed access token. Returns its base URL. */
async function startUpstream(): Promise<string> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.get("/authorize", (req, res) => {
    // Simulate the user authenticating upstream, then redirecting back to the
    // host's redirect_uri with a code + state.
    const redirectUri = String(req.query.redirect_uri ?? "");
    const url = new URL(redirectUri);
    url.searchParams.set("code", "upstream-auth-code");
    if (req.query.state) {
      url.searchParams.set("state", String(req.query.state));
    }
    res.redirect(302, url.href);
  });
  app.post("/token", (_req, res) => {
    res.json({
      access_token: UPSTREAM_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read",
    });
  });
  const srv = http.createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, resolve));
  servers.push(srv);
  const port = (srv.address() as { port: number }).port;
  return `http://localhost:${port}`;
}

/** A deterministic stub verifier mapping the known upstream token to a sub. */
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

/** Grab a free port by binding to :0, then closing. */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Build + start an enpilink server whose auth issuer == its own listen origin.
 * The issuer/port chicken-and-egg is solved by reserving a free port first,
 * then building the auth config (which references that origin) and listening on
 * exactly that port.
 */
async function startEnpilink(
  build: (base: string) => {
    auth: AuthConfig;
    register?: (s: McpServer) => void;
  },
): Promise<{ base: string; server: McpServer; storage: MemoryStorageAdapter }> {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const { auth, register } = build(base);
  const server = new McpServer({ name: "demo", version: "0.0.0" }, undefined, {
    auth,
  });
  const storage = new MemoryStorageAdapter();
  await storage.init();
  server.adoptStorage(storage);
  register?.(server);
  const httpServer = http.createServer();
  const app = await createApp({ mcpServer: server, httpServer });
  const listening = http.createServer(app);
  await new Promise<void>((resolve) => listening.listen(port, resolve));
  servers.push(listening);
  return { base, server, storage };
}

function authConfig(
  base: string,
  upstreamBase: string,
  verifier: OAuthTokenVerifier,
): AuthConfig {
  return {
    enabled: true,
    issuer: base,
    audience: `${base}/mcp`,
    verifier,
    resourceServerUrl: `${base}/mcp`,
    redirectUris: ["http://localhost:9999/cb"],
    upstream: {
      clientId: "host-client",
      authorizationUrl: `${upstreamBase}/authorize`,
      tokenUrl: `${upstreamBase}/token`,
      scopes: ["read"],
    },
  };
}

async function callTool(
  base: string,
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
  return fetch(`${base}/mcp`, {
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

describe("A2 — co-hosted AS discovery + branded login", () => {
  it("serves AS metadata, PRM, and a branded login page", async () => {
    const upstream = await startUpstream();
    const { base } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream, stubVerifier({})),
    }));

    const asMeta = await fetch(
      `${base}/.well-known/oauth-authorization-server`,
    );
    expect(asMeta.status).toBe(200);
    const asBody = (await asMeta.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint?: string;
    };
    expect(asBody.authorization_endpoint).toContain("/authorize");
    expect(asBody.token_endpoint).toContain("/token");

    const prm = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(prm.status).toBe(200);

    // Branded login page at /authorize (GET, no continue flag).
    const login = await fetch(
      `${base}/authorize?client_id=host-client&response_type=code&code_challenge=abc&code_challenge_method=S256&redirect_uri=${encodeURIComponent(
        "http://localhost:9999/cb",
      )}`,
      { redirect: "manual" },
    );
    expect(login.status).toBe(200);
    const html = await login.text();
    expect(html).toContain("Continue to sign in");
    expect(html).toContain("enpilink_continue=1");
  });
});

describe("A2 — full OAuth loop against a stubbed upstream", () => {
  it("authorize → upstream → callback → token → tools/call sees sub + records a session", async () => {
    const upstream = await startUpstream();
    const verifier = stubVerifier({
      [UPSTREAM_TOKEN]: {
        token: UPSTREAM_TOKEN,
        clientId: "host-client",
        scopes: ["read"],
        expiresAt: FUTURE,
        extra: { sub: "user-42", iss: "https://idp.example", email: "a@b.c" },
      },
    });
    const seen: { sub?: string } = {};
    const { base, storage } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream, verifier),
      register: (s) =>
        s.registerTool(
          {
            name: "me",
            inputSchema: {},
            securitySchemes: [{ type: "oauth2", scopes: ["read"] }],
          },
          async (_args, extra) => {
            seen.sub = getAuthInfo(extra)?.sub;
            return { content: "ok" };
          },
        ),
    }));

    // 1. Tokenless → 401 challenge.
    const challenge = await callTool(base, "me");
    expect(challenge.status).toBe(401);

    // 2. /authorize (with continue flag) → 302 to upstream.
    const redirectUri = "http://localhost:9999/cb";
    const authRes = await fetch(
      `${base}/authorize?enpilink_continue=1&client_id=host-client&response_type=code&code_challenge=challenge123&code_challenge_method=S256&redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&scope=read&state=st`,
      { redirect: "manual" },
    );
    expect(authRes.status).toBe(302);
    const upstreamRedirect = new URL(authRes.headers.get("location") ?? "");
    expect(upstreamRedirect.href).toContain(`${upstream}/authorize`);
    expect(upstreamRedirect.searchParams.get("client_id")).toBe("host-client");

    // 3. Follow the upstream /authorize → it redirects back with a code.
    const upstreamAuth = await fetch(upstreamRedirect.href, {
      redirect: "manual",
    });
    expect(upstreamAuth.status).toBe(302);
    const callback = new URL(upstreamAuth.headers.get("location") ?? "");
    const code = callback.searchParams.get("code");
    expect(code).toBe("upstream-auth-code");

    // 4. Exchange the code at OUR /token (proxied to upstream) → access token.
    const tokenRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "host-client",
        code: code ?? "",
        code_verifier: "verifier123",
        redirect_uri: redirectUri,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string };
    expect(tokens.access_token).toBe(UPSTREAM_TOKEN);

    // 5. Call the protected tool WITH the token → handler sees sub.
    const ok = await callTool(base, "me", tokens.access_token);
    expect(ok.status).toBe(200);
    expect(seen.sub).toBe("user-42");

    // 6. A session + user row was persisted (give the fire-and-forget a tick).
    await new Promise((r) => setTimeout(r, 20));
    const sessions = await storage.listSessions();
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session?.sub).toBe("user-42");
    expect(session?.scopes).toContain("read");
    // Tokens-at-rest: only an opaque ref, NEVER the raw upstream token.
    expect(session?.tokenRef).toBeTruthy();
    expect(session?.tokenRef).not.toBe(UPSTREAM_TOKEN);
    const users = await storage.listUsers();
    expect(users[0]?.sub).toBe("user-42");
    expect(users[0]?.email).toBe("a@b.c");
  });
});

describe("A2 — secrets never leak", () => {
  it("the upstream client secret never appears in AS metadata or the login page", async () => {
    const upstream = await startUpstream();
    const SECRET = "super-secret-client-secret";
    process.env.ENPILINK_AUTH_CLIENT_SECRET = SECRET;
    try {
      const { base } = await startEnpilink((b) => ({
        auth: authConfig(b, upstream, stubVerifier({})),
      }));
      const asMeta = await (
        await fetch(`${base}/.well-known/oauth-authorization-server`)
      ).text();
      const login = await (
        await fetch(
          `${base}/authorize?client_id=host-client&response_type=code&code_challenge=abc&code_challenge_method=S256&redirect_uri=${encodeURIComponent(
            "http://localhost:9999/cb",
          )}`,
          { redirect: "manual" },
        )
      ).text();
      expect(asMeta).not.toContain(SECRET);
      expect(login).not.toContain(SECRET);
    } finally {
      process.env.ENPILINK_AUTH_CLIENT_SECRET = undefined;
    }
  });
});

describe("A2 — recordingVerifier / persistSession (per-adapter)", () => {
  it("recordingVerifier passes through and records a session", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init();
    const base = stubVerifier({
      tok: {
        token: "tok",
        clientId: "c",
        scopes: ["read"],
        expiresAt: FUTURE,
        extra: { sub: "u-1" },
      },
    });
    const v = recordingVerifier(
      base,
      () => storage,
      () => 1000,
    );
    const info = await v.verifyAccessToken("tok");
    expect(info.clientId).toBe("c");
    await new Promise((r) => setTimeout(r, 20));
    const sessions = await storage.listSessions();
    expect(sessions[0]?.sub).toBe("u-1");
    expect(sessions[0]?.lastSeenAt).toBe(1000);
  });

  it("persistSession is a no-op without a sub", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init();
    await persistSession(
      { token: "t", clientId: "c", scopes: [], extra: {} },
      "t",
      storage,
    );
    expect(await storage.listSessions()).toHaveLength(0);
  });
});
