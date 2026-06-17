// @vitest-environment node
import http from "node:http";
import express, { type RequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "./auth.js";
import { getAuthInfo } from "./auth.js";
import {
  deriveSigningKeys,
  FederatingOAuthProvider,
  GUEST_SCOPES,
  type SigningKeys,
  verifyEnpilinkToken,
} from "./auth-federation.js";
import {
  buildFederationRouter,
  PendingAuthStore,
} from "./auth-federation-router.js";
import { createApp } from "./express.js";
import { McpServer } from "./server.js";
import { MemoryStorageAdapter } from "./storage/memory.js";
import type { AuthSession, AuthUser } from "./storage/types.js";
import { isGuestSub } from "./storage/types.js";

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
 * A3 acceptance — federating Authorization Server (WE mint + sign tokens),
 * guest mode, and lazy/step-up auth. Synthetic OAuth client + stubbed upstream
 * IdP (local express). NO real network, NO real host. Clock + ids injected for
 * determinism.
 */

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers) {
    s.close();
  }
  servers.length = 0;
});

const SIGNING_KEY = "test-signing-key-keep-stable";

async function keys(): Promise<SigningKeys> {
  return deriveSigningKeys(SIGNING_KEY);
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** A fake upstream IdP whose /token returns an access_token JWT carrying a sub. */
async function startUpstream(sub = "upstream-user-1"): Promise<string> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.get("/authorize", (req, res) => {
    const redirectUri = String(req.query.redirect_uri ?? "");
    const url = new URL(redirectUri);
    url.searchParams.set("code", "upstream-code");
    if (req.query.state) {
      url.searchParams.set("state", String(req.query.state));
    }
    res.redirect(302, url.href);
  });
  app.post("/token", (_req, res) => {
    // A JWT whose payload carries the user's sub + profile (signature ignored;
    // we only lift the claims to track — never forward this token).
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({ sub, email: "u@example.com", name: "Up Stream" }),
    ).toString("base64url");
    res.json({
      access_token: `${header}.${payload}.`,
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  const srv = http.createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, resolve));
  servers.push(srv);
  const port = (srv.address() as { port: number }).port;
  return `http://localhost:${port}`;
}

function authConfig(base: string, upstreamBase: string): AuthConfig {
  return {
    enabled: true,
    issuer: base,
    audience: `${base}/mcp`,
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

async function startEnpilink(
  build: (base: string) => {
    auth: AuthConfig;
    register?: (s: McpServer) => void;
  },
): Promise<{ base: string; server: McpServer }> {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  // A stable signing key so the federating AS mints verifiable tokens.
  process.env.ENPILINK_AUTH_SIGNING_KEY = SIGNING_KEY;
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
  // Sessions are recorded into the server's LIVE active storage (dev activates
  // its own analytics store on the first `/mcp` call), so query `server.storage`
  // rather than the seed adapter.
  return { base, server };
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

function registerTools(s: McpServer): void {
  s.registerTool(
    {
      name: "public",
      inputSchema: {},
      securitySchemes: [{ type: "noauth" }],
    },
    async (_a, extra) => ({
      content: `hello ${getAuthInfo(extra)?.sub ?? "anon"}`,
    }),
  );
  s.registerTool(
    {
      name: "secure",
      inputSchema: {},
      securitySchemes: [{ type: "oauth2", scopes: ["read"] }],
    },
    async (_a, extra) => ({ content: getAuthInfo(extra)?.sub ?? "?" }),
  );
}

afterEach(() => {
  process.env.ENPILINK_AUTH_SIGNING_KEY = undefined;
});

describe("A3 — federating AS discovery + branded page with guest option", () => {
  it("serves AS metadata (jwks_uri), JWKS, and a page with BOTH choices", async () => {
    const upstream = await startUpstream();
    const { base } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
    }));

    const asMeta = await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json();
    expect(asMeta.authorization_endpoint).toContain("/authorize");
    expect(asMeta.token_endpoint).toContain("/token");
    expect(asMeta.jwks_uri).toContain("/.well-known/jwks.json");

    const jwks = await (await fetch(`${base}/.well-known/jwks.json`)).json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kty).toBe("OKP");
    // The JWKS must NEVER include private key material.
    expect(jwks.keys[0].d).toBeUndefined();

    // The SDK /authorize redirects to our branded page.
    const auth = await fetch(
      `${base}/authorize?client_id=host-client&response_type=code&code_challenge=abc&code_challenge_method=S256&redirect_uri=${encodeURIComponent(
        "http://localhost:9999/cb",
      )}`,
      { redirect: "manual" },
    );
    expect(auth.status).toBe(302);
    const branded = await fetch(auth.headers.get("location") ?? "");
    const html = await branded.text();
    expect(html).toContain("Sign in");
    expect(html).toContain("Continue as guest");
  });
});

describe("A3 — continue-as-guest → full guest token via /token", () => {
  it("mints a guest token (guest: sub, guest scope); public tool works, secure → 403", async () => {
    const upstream = await startUpstream();
    const { base, server } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
      register: registerTools,
    }));
    const redirectUri = "http://localhost:9999/cb";
    const { verifier, challenge } = await pkce();

    // Authorize with a real S256 challenge → branded → guest link → code.
    const { html, cookie } = await startFlow(
      base,
      `client_id=host-client&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&scope=read&state=s1`,
    );
    const guestUrl = decodeHtml(
      (/href="([^"]*\/authorize\/guest[^"]*)"/.exec(html)?.[1] as string) ?? "",
    );
    const guestRes = await fetch(new URL(guestUrl, base).href, {
      redirect: "manual",
      headers: { cookie },
    });
    const code = new URL(
      guestRes.headers.get("location") ?? "",
    ).searchParams.get("code");

    // /token exchange (public client → no client_secret).
    const tokenRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "host-client",
        code: code ?? "",
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      scope: string;
    };
    expect(tokens.scope).toBe(GUEST_SCOPES.join(" "));

    // The minted token validates against OUR JWKS + carries a guest: sub.
    const info = await verifyEnpilinkToken(tokens.access_token, {
      issuer: base,
      audience: `${base}/mcp`,
      keys: await keys(),
    });
    expect(isGuestSub(getAuthInfo({ authInfo: info })?.sub)).toBe(true);

    // noauth tool works with the guest token.
    const pub = await callTool(base, "public", tokens.access_token);
    expect(pub.status).toBe(200);

    // oauth2 tool → 403 insufficient_scope step-up (guest lacks `read`).
    const sec = await callTool(base, "secure", tokens.access_token);
    expect(sec.status).toBe(403);
    expect(sec.headers.get("WWW-Authenticate")).toContain("insufficient_scope");

    // A guest session was recorded (flagged), distinguishable for the Auth tab.
    await new Promise((r) => setTimeout(r, 20));
    const sessions = await listSessionsOf(server);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.isGuest).toBe(true);
    expect(sessions[0]?.sub?.startsWith("guest:")).toBe(true);
  });
});

describe("A3 — full login loop (federated upstream) mints OUR token", () => {
  it("authorize → upstream → callback → /token → OUR token; secure tool sees real sub", async () => {
    const upstream = await startUpstream("real-user-77");
    const { base, server } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
      register: registerTools,
    }));
    const redirectUri = "http://localhost:9999/cb";
    const { verifier, challenge } = await pkce();

    // Tokenless secure call → 401 challenge (lazy auth, not forced on connect).
    expect((await callTool(base, "secure")).status).toBe(401);
    // Public tool works with NO token at all (true anonymous).
    expect((await callTool(base, "public")).status).toBe(200);

    // Authorize → branded → "Sign in" link → upstream.
    const { html, cookie } = await startFlow(
      base,
      `client_id=host-client&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&scope=read&state=s2`,
    );
    const signInUrl = decodeHtml(
      (/href="([^"]*\/authorize\/upstream[^"]*)"/.exec(html)?.[1] as string) ??
        "",
    );
    // "Sign in" → our /authorize/upstream → 302 to the upstream authorize.
    const toUpstream = await fetch(new URL(signInUrl, base).href, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(toUpstream.status).toBe(302);
    const upstreamAuthorize = toUpstream.headers.get("location") ?? "";
    expect(upstreamAuthorize).toContain(`${upstream}/authorize`);

    // Follow upstream authorize → it redirects to OUR callback with a code.
    const upstreamRes = await fetch(upstreamAuthorize, { redirect: "manual" });
    const ourCallback = upstreamRes.headers.get("location") ?? "";
    expect(ourCallback).toContain("/authorize/callback");

    // Our callback REQUIRES the binding cookie (CSRF defense) — replay it.
    const cbRes = await fetch(ourCallback, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(cbRes.status).toBe(302);
    const hostRedirect = new URL(cbRes.headers.get("location") ?? "");
    expect(hostRedirect.origin + hostRedirect.pathname).toBe(redirectUri);
    expect(hostRedirect.searchParams.get("state")).toBe("s2");
    const code = hostRedirect.searchParams.get("code");

    // /token → OUR minted token.
    const tokenRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "host-client",
        code: code ?? "",
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string };

    // The same secure tool NOW succeeds, and the handler sees the real sub.
    const ok = await callTool(base, "secure", tokens.access_token);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(JSON.stringify(body)).toContain("real-user-77");

    // An authed (non-guest) session + user row was persisted.
    await new Promise((r) => setTimeout(r, 50));
    const sessions = await listSessionsOf(server);
    expect(sessions[0]?.sub).toBe("real-user-77");
    expect(sessions[0]?.isGuest).toBe(false);
    const users = await listUsersOf(server);
    expect(users[0]?.email).toBe("u@example.com");
    expect(users[0]?.isGuest).toBe(false);
  });
});

describe("A3 — PKCE is validated at /token", () => {
  it("rejects a bad code_verifier", async () => {
    const upstream = await startUpstream();
    const { base } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
      register: registerTools,
    }));
    const redirectUri = "http://localhost:9999/cb";
    const { challenge } = await pkce();
    const { html, cookie } = await startFlow(
      base,
      `client_id=host-client&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&scope=read`,
    );
    const guestUrl = decodeHtml(
      (/href="([^"]*\/authorize\/guest[^"]*)"/.exec(html)?.[1] as string) ?? "",
    );
    const guestRes = await fetch(new URL(guestUrl, base).href, {
      redirect: "manual",
      headers: { cookie },
    });
    const code = new URL(
      guestRes.headers.get("location") ?? "",
    ).searchParams.get("code");
    const tokenRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "host-client",
        code: code ?? "",
        code_verifier: "this-is-the-wrong-verifier-aaaaaaaaaaaaaaaa",
        redirect_uri: redirectUri,
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
  });
});

describe("A3 — provider unit (deterministic, no HTTP)", () => {
  it("mints + verifies a token; refresh narrows scopes; guest sub prefix", async () => {
    let n = 0;
    const provider = new FederatingOAuthProvider(
      {
        issuer: "https://as.test",
        audience: "https://as.test/mcp",
        keys: await keys(),
        now: () => 1_000_000,
        randomId: () => `id-${++n}`,
      },
      {
        async getClient() {
          return {
            client_id: "host",
            redirect_uris: ["http://localhost:1/cb"],
            token_endpoint_auth_method: "none",
          };
        },
      },
    );
    expect(provider.skipLocalPkceValidation).toBe(false);
    expect(provider.newGuestSub().startsWith("guest:")).toBe(true);

    const redirect = provider.issueCode({
      redirectUri: "http://localhost:1/cb",
      codeChallenge: "c",
      scopes: ["read", "write"],
      sub: "u1",
      isGuest: false,
    });
    const code = new URL(redirect).searchParams.get("code") as string;
    const tokens = await provider.exchangeAuthorizationCode(
      { client_id: "host", redirect_uris: [] },
      code,
    );
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(getAuthInfo({ authInfo: info })?.sub).toBe("u1");
    expect(info.scopes).toEqual(["read", "write"]);

    // Re-using the code fails (one-time).
    await expect(
      provider.exchangeAuthorizationCode(
        { client_id: "host", redirect_uris: [] },
        code,
      ),
    ).rejects.toThrow();

    // Refresh narrows scopes (never widens).
    const refreshed = await provider.exchangeRefreshToken(
      { client_id: "host", redirect_uris: [] },
      tokens.refresh_token as string,
      ["read"],
    );
    const rInfo = await provider.verifyAccessToken(refreshed.access_token);
    expect(rInfo.scopes).toEqual(["read"]);
  });
});

describe("A3 — signing key never leaks", () => {
  it("the signing key string never appears in metadata, JWKS, or page", async () => {
    const upstream = await startUpstream();
    const { base } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
    }));
    const meta = await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).text();
    const jwks = await (await fetch(`${base}/.well-known/jwks.json`)).text();
    const auth = await fetch(
      `${base}/authorize?client_id=host-client&response_type=code&code_challenge=c&code_challenge_method=S256&redirect_uri=${encodeURIComponent(
        "http://localhost:9999/cb",
      )}`,
      { redirect: "manual" },
    );
    const page = await (await fetch(auth.headers.get("location") ?? "")).text();
    for (const body of [meta, jwks, page]) {
      expect(body).not.toContain(SIGNING_KEY);
    }
  });
});

describe("A3 — federation router unit with injected upstream resolver", () => {
  it("login via injected resolveUpstream mints OUR token with the resolved sub", async () => {
    const k = await keys();
    let n = 0;
    const provider = new FederatingOAuthProvider(
      {
        issuer: "https://as.local",
        audience: "https://as.local/mcp",
        keys: k,
        randomId: () => `c-${++n}`,
        resolveUpstream: async (c) =>
          c === "good-code" ? { sub: "resolved-9", email: "r@x.y" } : undefined,
      },
      {
        async getClient() {
          return {
            client_id: "host",
            redirect_uris: ["http://localhost:9999/cb"],
            token_endpoint_auth_method: "none",
          };
        },
      },
    );
    // Deterministic pending store so we can seed an id directly (skipping the
    // branded page) and bind the callback's cookie to that exact id.
    const pendingStore = new PendingAuthStore();
    const router = buildFederationRouter({
      issuerUrl: "https://as.local",
      resourceServerUrl: "https://as.local/mcp",
      provider,
      publicJwk: k.publicJwk,
      upstream: {
        clientId: "host",
        authorizationUrl: "http://up/authorize",
        tokenUrl: "http://up/token",
      },
      redirectUris: ["http://localhost:9999/cb"],
      pendingStore,
    });
    const app = express();
    app.use(router);
    const srv = http.createServer(app);
    await new Promise<void>((r) => srv.listen(0, r));
    servers.push(srv);
    const port = (srv.address() as { port: number }).port;
    const b = `http://localhost:${port}`;

    // Seed a server-side pending entry + its opaque id (what the branded page
    // would have stored), then simulate the upstream callback with the matching
    // binding cookie.
    const seed = () =>
      pendingStore.create({
        redirectUri: "http://localhost:9999/cb",
        codeChallenge: "ch",
        scope: "read",
        state: "z",
      });

    const goodId = seed();
    const cb = await fetch(
      `${b}/authorize/callback?code=good-code&state=${goodId}`,
      {
        redirect: "manual",
        headers: { cookie: `enpilink_auth_flow=${goodId}` },
      },
    );
    expect(cb.status).toBe(302);
    const code = new URL(cb.headers.get("location") ?? "").searchParams.get(
      "code",
    );
    const tokens = await provider.exchangeAuthorizationCode(
      { client_id: "host", redirect_uris: [] },
      code as string,
    );
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(getAuthInfo({ authInfo: info })?.sub).toBe("resolved-9");

    // A bad upstream code → 502 (no identity resolved).
    const badId = seed();
    const bad = await fetch(
      `${b}/authorize/callback?code=nope&state=${badId}`,
      {
        redirect: "manual",
        headers: { cookie: `enpilink_auth_flow=${badId}` },
      },
    );
    expect(bad.status).toBe(502);
  });
});

/**
 * A4.5 — state-binding / CSRF security regression suite.
 *
 * Each test maps to a specific attack flagged by the security review:
 * forgeable upstream `state`, missing/mismatched browser cookie, unregistered
 * `redirect_uri`, and expired/already-used pending auth. The happy path is
 * proven above (the A3 full-loop + guest tests, now cookie-bound).
 */
describe("A4.5 — federation state binding + cookie + redirect allowlist", () => {
  const REDIRECT = "http://localhost:9999/cb";
  const AUTHZ = (extra = "") =>
    `client_id=host-client&response_type=code&code_challenge=abc&code_challenge_method=S256&redirect_uri=${encodeURIComponent(
      REDIRECT,
    )}&scope=read${extra}`;

  /** Run authorize → branded, follow "Sign in" → our /authorize/callback URL. */
  async function reachCallback(
    base: string,
    cookie: string,
    signInUrl: string,
  ): Promise<string> {
    const toUpstream = await fetch(new URL(signInUrl, base).href, {
      redirect: "manual",
      headers: { cookie },
    });
    const upstreamAuthorize = toUpstream.headers.get("location") ?? "";
    const upstreamRes = await fetch(upstreamAuthorize, { redirect: "manual" });
    return upstreamRes.headers.get("location") ?? "";
  }

  function signInUrlFrom(html: string): string {
    return decodeHtml(
      (/href="([^"]*\/authorize\/upstream[^"]*)"/.exec(html)?.[1] as string) ??
        "",
    );
  }
  function guestUrlFrom(html: string): string {
    return decodeHtml(
      (/href="([^"]*\/authorize\/guest[^"]*)"/.exec(html)?.[1] as string) ?? "",
    );
  }

  // ATTACK 1: forged/tampered upstream `state` (id not backed by a stored
  // pending auth) → callback rejected, no token, no session for a forged sub.
  it("rejects a forged upstream state (no matching server-side pending auth)", async () => {
    const upstream = await startUpstream("attacker-sub");
    const { base, server } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
      register: registerTools,
    }));
    // The attacker invents an id and supplies it as BOTH state + cookie (so the
    // cookie==state check passes) — but no server-side pending entry exists.
    const forgedId = "forged-opaque-id-not-in-store";
    const res = await fetch(
      `${base}/authorize/callback?code=upstream-code&state=${forgedId}`,
      {
        redirect: "manual",
        headers: { cookie: `enpilink_auth_flow=${forgedId}` },
      },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    const sessions = await listSessionsOf(server);
    expect(sessions.some((s) => s.sub === "attacker-sub")).toBe(false);
  });

  // ATTACK 2a: callback with the right state but NO browser cookie → rejected.
  it("rejects a callback with a missing browser cookie", async () => {
    const upstream = await startUpstream();
    const { base } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
    }));
    const { html, cookie } = await startFlow(base, AUTHZ("&state=s"));
    const ourCallback = await reachCallback(base, cookie, signInUrlFrom(html));
    // Replay the callback WITHOUT the cookie.
    const res = await fetch(ourCallback, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  // ATTACK 2b: callback with a MISMATCHED cookie (cross-session replay) →
  // rejected even though both cookie and state are present.
  it("rejects a callback whose cookie does not match the state", async () => {
    const upstream = await startUpstream();
    const { base } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
    }));
    const { html, cookie } = await startFlow(base, AUTHZ("&state=s"));
    const ourCallback = await reachCallback(base, cookie, signInUrlFrom(html));
    const res = await fetch(ourCallback, {
      redirect: "manual",
      headers: { cookie: "enpilink_auth_flow=some-other-session-id" },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  // ATTACK 2c: guest path requires the cookie too (missing → rejected).
  it("rejects the guest path with a missing/mismatched cookie", async () => {
    const upstream = await startUpstream();
    const { base } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
    }));
    const { html } = await startFlow(base, AUTHZ("&state=s"));
    const guestUrl = new URL(guestUrlFrom(html), base).href;
    // No cookie.
    const noCookie = await fetch(guestUrl, { redirect: "manual" });
    expect(noCookie.status).toBe(400);
    // Wrong cookie.
    const wrong = await fetch(guestUrl, {
      redirect: "manual",
      headers: { cookie: "enpilink_auth_flow=nope" },
    });
    expect(wrong.status).toBe(400);
  });

  // ATTACK 3: unregistered redirect_uri rejected at flow start (branded), so it
  // never reaches the upstream / guest steps.
  it("rejects an unregistered redirect_uri at the branded entry", async () => {
    const upstream = await startUpstream();
    const { base } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
    }));
    const evil = "http://evil.example.com/steal";
    const authRes = await fetch(
      `${base}/authorize?client_id=host-client&response_type=code&code_challenge=abc&code_challenge_method=S256&redirect_uri=${encodeURIComponent(
        evil,
      )}`,
      { redirect: "manual" },
    );
    // The SDK /authorize itself rejects an unregistered redirect_uri before our
    // branded page; if it does redirect, our branded page must 400.
    if (authRes.status === 302) {
      const branded = await fetch(authRes.headers.get("location") ?? "");
      expect(branded.status).toBe(400);
    } else {
      expect(authRes.status).toBeGreaterThanOrEqual(400);
    }
  });

  // ATTACK 4: an already-used (single-use) pending auth → second callback fails.
  it("rejects an already-used pending auth (single-use)", async () => {
    const upstream = await startUpstream("real-user-1");
    const { base } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
    }));
    const { html, cookie } = await startFlow(base, AUTHZ("&state=s"));
    const ourCallback = await reachCallback(base, cookie, signInUrlFrom(html));
    // First callback succeeds (consumes the pending entry).
    const first = await fetch(ourCallback, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(first.status).toBe(302);
    // Replaying the SAME callback + cookie now fails (single-use).
    const replay = await fetch(ourCallback, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();
  });

  // EXPIRY: an expired pending entry is rejected (deterministic clock).
  it("rejects an expired pending auth", async () => {
    const k = await keys();
    let clock = 1_000_000;
    const provider = new FederatingOAuthProvider(
      {
        issuer: "https://as.local",
        audience: "https://as.local/mcp",
        keys: k,
        now: () => clock,
        resolveUpstream: async () => ({ sub: "u" }),
      },
      {
        async getClient() {
          return { client_id: "host", redirect_uris: [REDIRECT] };
        },
      },
    );
    const pendingStore = new PendingAuthStore({
      now: () => clock,
      newId: () => "fixed-id",
    });
    const router = buildFederationRouter({
      issuerUrl: "https://as.local",
      resourceServerUrl: "https://as.local/mcp",
      provider,
      publicJwk: k.publicJwk,
      upstream: {
        clientId: "host",
        authorizationUrl: "http://up/authorize",
        tokenUrl: "http://up/token",
      },
      redirectUris: [REDIRECT],
      pendingStore,
    });
    const app = express();
    app.use(router);
    const srv = http.createServer(app);
    await new Promise<void>((r) => srv.listen(0, r));
    servers.push(srv);
    const port = (srv.address() as { port: number }).port;
    const b = `http://localhost:${port}`;

    const id = pendingStore.create({
      redirectUri: REDIRECT,
      codeChallenge: "c",
    });
    // Advance the clock past the 10-minute TTL.
    clock += 11 * 60 * 1000;
    const res = await fetch(`${b}/authorize/callback?code=ok&state=${id}`, {
      redirect: "manual",
      headers: { cookie: `enpilink_auth_flow=${id}` },
    });
    expect(res.status).toBe(400);
  });

  // SECURITY PROPERTY: the branded page sets an HttpOnly, SameSite=Lax binding
  // cookie (the browser-binding seam).
  it("sets an HttpOnly SameSite binding cookie on flow start", async () => {
    const upstream = await startUpstream();
    const { base } = await startEnpilink((b) => ({
      auth: authConfig(b, upstream),
    }));
    const authRes = await fetch(`${base}/authorize?${AUTHZ()}`, {
      redirect: "manual",
    });
    const branded = await fetch(authRes.headers.get("location") ?? "");
    const setCookie = branded.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("enpilink_auth_flow=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });
});

// --- helpers ---

/** Read recorded sessions from the server's live active storage. */
async function listSessionsOf(server: McpServer): Promise<AuthSession[]> {
  const storage = server.storage;
  if (!storage?.listSessions) {
    return [];
  }
  return storage.listSessions();
}

/** Read tracked users from the server's live active storage. */
async function listUsersOf(server: McpServer): Promise<AuthUser[]> {
  const storage = server.storage;
  if (!storage?.listUsers) {
    return [];
  }
  return storage.listUsers();
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Extract the `enpilink_auth_flow` cookie value from a Set-Cookie header. */
function flowCookieValue(res: Response): string | undefined {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    return undefined;
  }
  const m = /enpilink_auth_flow=([^;]*)/.exec(setCookie);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

/**
 * Drive the start of a federation flow: hit `/authorize`, follow to the branded
 * page, and return the page HTML + the binding cookie header to replay on the
 * callback / guest step (browsers do this automatically; fetch does not).
 */
async function startFlow(
  base: string,
  query: string,
): Promise<{ html: string; cookie: string }> {
  const auth = await fetch(`${base}/authorize?${query}`, {
    redirect: "manual",
  });
  const branded = await fetch(auth.headers.get("location") ?? "");
  const cookieVal = flowCookieValue(branded);
  return {
    html: await branded.text(),
    cookie: `enpilink_auth_flow=${cookieVal ?? ""}`,
  };
}

/** Generate a real PKCE S256 pair using jose-free node crypto. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const crypto = await import("node:crypto");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}
