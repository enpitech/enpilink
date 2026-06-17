import crypto from "node:crypto";
import type { RequestHandler, Router } from "express";
import express from "express";
import {
  type AuthInfo,
  mcpAuthRouter,
  type OAuthClientInformationFull,
  type OAuthTokenVerifier,
  ProxyOAuthServerProvider,
  type UpstreamIdpConfig,
} from "./auth.js";
import { serverLog } from "./log-sink.js";
import type { AuthSession, AuthUser, StorageAdapter } from "./storage/types.js";

/**
 * Co-hosted proxy Authorization Server (A2).
 *
 * enpilink acts as the OAuth Authorization Server the host (ChatGPT/Claude)
 * discovers and authenticates against, while delegating the actual credential
 * check to a configurable upstream IdP via the SDK's
 * {@link ProxyOAuthServerProvider}. Tokens are issued by the upstream provider
 * (transparent proxy); we validate them via the configured JWKS (the A1
 * verifier) and — critically — record a session keyed by the user's stable
 * `sub` at the first valid use of each token, so every auth is tracked.
 *
 * Provider choice (proxy vs. federating): we use the proxy because it is the
 * most robustly SDK-supported path to a real-host loop that actually completes,
 * and because it never makes enpilink a token issuer (smaller security
 * surface). A3 (guest tokens) will need us to MINT our own tokens — that will
 * require a federating `OAuthServerProvider`; this module's seams (the verifier
 * wrapper + session recorder) carry over.
 *
 * Tokens-at-rest: we persist only an OPAQUE one-way reference (a SHA-256 hash)
 * to the upstream token — never the raw access/refresh token. No secret token
 * is stored, so there is no token to encrypt or leak.
 */

/** SHA-256 hex of a value — a one-way, opaque reference (never reversible). */
function opaqueRef(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Wrap a token verifier so that EVERY successful verification records a user +
 * session in storage (keyed by the `sub`). The write is best-effort: it never
 * throws into the auth path and never slows the verification result — failures
 * are swallowed and logged, exactly like analytics. When no storage is active
 * the wrapper is a no-op passthrough.
 *
 * @param verifier the underlying verifier (A1 JWKS verifier or an injected one)
 * @param getStorage resolves the active storage adapter (or null)
 * @param now injectable clock (ms epoch) for deterministic tests
 */
export function recordingVerifier(
  verifier: OAuthTokenVerifier,
  getStorage: () => StorageAdapter | null,
  now: () => number = Date.now,
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const info = await verifier.verifyAccessToken(token);
      // Fire-and-forget the tracking write so it never delays the request.
      void persistSession(info, token, getStorage(), now).catch((err) => {
        serverLog("warning", "auth session persistence failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return info;
    },
  };
}

/**
 * Persist (upsert) the user + session for a verified principal. Stores only an
 * opaque token reference, never the raw token. No-op without a `sub` (we key on
 * the stable per-user id) or without storage / the A2 methods.
 */
export async function persistSession(
  info: AuthInfo,
  token: string,
  storage: StorageAdapter | null,
  now: () => number = Date.now,
): Promise<void> {
  if (!storage?.upsertUser || !storage.recordSession) {
    return;
  }
  const claims = (info.extra ?? {}) as Record<string, unknown>;
  const sub = typeof claims.sub === "string" ? claims.sub : undefined;
  if (!sub) {
    return;
  }
  const ts = now();
  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const tokenRef = opaqueRef(token);

  const user: AuthUser = {
    sub,
    issuer,
    createdAt: ts,
    lastSeenAt: ts,
    email: typeof claims.email === "string" ? claims.email : undefined,
    name: typeof claims.name === "string" ? claims.name : undefined,
  };
  // Session id is derived from the (sub, tokenRef) pair so repeat calls with
  // the same token refresh one row instead of creating duplicates.
  const session: AuthSession = {
    id: opaqueRef(`${sub}:${tokenRef}`),
    sub,
    issuer,
    clientId: info.clientId,
    tokenRef,
    scopes: info.scopes,
    createdAt: ts,
    lastSeenAt: ts,
    expiresAt: info.expiresAt,
  };
  await storage.upsertUser(user);
  await storage.recordSession(session);
}

/** Options for {@link buildProxyProvider}. */
export interface ProxyProviderOptions {
  upstream: UpstreamIdpConfig;
  /** Token verifier used by the AS to validate tokens (the recording verifier). */
  verifier: OAuthTokenVerifier;
  /**
   * The upstream client secret (SECRET, env-only `auth.clientSecret`). Held in
   * memory only; surfaced to the upstream token exchange via the synthesized
   * client record. Never persisted/returned/logged.
   */
  clientSecret?: string;
  /**
   * Redirect URIs the host (OAuth client) is allowed to use. The SDK validates
   * the inbound `redirect_uri` against this list. Pass the host callback URLs
   * (e.g. ChatGPT/Claude connector callbacks); loopback ports are relaxed.
   */
  redirectUris: string[];
}

/**
 * Build a {@link ProxyOAuthServerProvider} that proxies to the upstream IdP.
 *
 * The single registered client is synthesized from the configured upstream
 * `clientId` (+ the env-only secret) and accepts the host's redirect URIs. The
 * provider's `verifyAccessToken` is the recording verifier, so a session is
 * recorded whenever the host calls a protected resource with the token.
 */
export function buildProxyProvider(
  opts: ProxyProviderOptions,
): ProxyOAuthServerProvider {
  const { upstream, verifier, clientSecret, redirectUris } = opts;
  const client: OAuthClientInformationFull = {
    client_id: upstream.clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    redirect_uris: redirectUris,
  };
  return new ProxyOAuthServerProvider({
    endpoints: {
      authorizationUrl: upstream.authorizationUrl,
      tokenUrl: upstream.tokenUrl,
      ...(upstream.revocationUrl
        ? { revocationUrl: upstream.revocationUrl }
        : {}),
    },
    verifyAccessToken: (token) => verifier.verifyAccessToken(token),
    // Any client_id the host presents resolves to our single upstream client.
    // (The host's dynamic client id from discovery is mapped onto our upstream
    // app; the upstream provider does the real client check.)
    getClient: async (clientId) => ({ ...client, client_id: clientId }),
  });
}

/** Options for {@link buildAuthServerRouter}. */
export interface AuthServerRouterOptions {
  /** AS/RS issuer URL (this origin). */
  issuerUrl: string;
  /** The real per-request `/mcp` resource URL advertised in PRM. */
  resourceServerUrl: string;
  provider: ProxyOAuthServerProvider;
  scopesSupported?: string[];
  /** The display name shown on the branded login page. */
  appName?: string;
}

/**
 * Build the Express router that co-hosts the Authorization Server: the branded
 * login interstitial in front of `/authorize`, plus the SDK's `mcpAuthRouter`
 * (which serves `/.well-known/oauth-authorization-server`, `/authorize`,
 * `/token`, and `/register`). Mount at the app root.
 */
export function buildAuthServerRouter(opts: AuthServerRouterOptions): Router {
  const router = express.Router();
  // The branded interstitial runs BEFORE the SDK authorize handler. A GET to
  // `/authorize` without `enpilink_continue=1` returns our branded page; the
  // page's "Continue" button re-issues the same request with the flag set,
  // which falls through to the SDK handler → upstream redirect.
  router.get("/authorize", brandedLoginPage(opts.appName));
  router.use(
    mcpAuthRouter({
      provider: opts.provider,
      issuerUrl: new URL(opts.issuerUrl),
      resourceServerUrl: new URL(opts.resourceServerUrl),
      scopesSupported: opts.scopesSupported,
    }),
  );
  return router;
}

/**
 * Branded login interstitial. Server-rendered, out-of-band (the browser tab the
 * host opens on the 401 challenge) — not the chat iframe. Shows a clean,
 * enpilink-teal "continue to sign in" page that forwards to the upstream
 * provider while preserving every original OAuth query param. Non-interactive
 * clients can skip it with `enpilink_continue=1`.
 */
export function brandedLoginPage(appName = "this app"): RequestHandler {
  return (req, res, next) => {
    if (req.query.enpilink_continue === "1") {
      next();
      return;
    }
    // Preserve all original OAuth params + add the continue flag.
    const params = new URLSearchParams(req.query as Record<string, string>);
    params.set("enpilink_continue", "1");
    const continueUrl = `${req.baseUrl}/authorize?${params.toString()}`;
    res
      .status(200)
      .set("Content-Type", "text/html; charset=utf-8")
      .set("Cache-Control", "no-store")
      .send(renderLoginHtml(continueUrl, appName));
  };
}

/** Render the branded login HTML. No inline secrets; escapes interpolations. */
function renderLoginHtml(continueUrl: string, appName: string): string {
  const safeUrl = escapeHtml(continueUrl);
  const safeApp = escapeHtml(appName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Sign in</title>
<style>
  :root { --teal: #3fb6a8; --teal-hover: #2f9e91; --ink: #1e1645; --muted: #6b7280; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; font-family: -apple-system, BlinkMacSystemFont,
    "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink);
    background: #f8fafc;
  }
  .card {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 12px;
    box-shadow: 0 1px 3px rgba(16,24,40,0.06); padding: 40px 36px;
    max-width: 400px; width: calc(100% - 32px); text-align: center;
  }
  .mark {
    width: 48px; height: 48px; border-radius: 12px; margin: 0 auto 20px;
    background: linear-gradient(135deg, var(--teal), var(--teal-hover));
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 22px;
  }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: var(--muted); font-size: 14px; line-height: 1.5; margin: 0 0 28px; }
  .btn {
    display: block; width: 100%; padding: 12px 16px; border: none;
    border-radius: 8px; background: var(--teal); color: #fff; font-size: 15px;
    font-weight: 600; text-decoration: none; cursor: pointer;
    transition: background 0.15s ease;
  }
  .btn:hover { background: var(--teal-hover); }
  .footer { margin-top: 20px; font-size: 12px; color: #9ca3af; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">e</div>
    <h1>Sign in to continue</h1>
    <p>${safeApp} uses enpilink to keep your sign-in secure. Continue to your identity provider to authorize access.</p>
    <a class="btn" href="${safeUrl}">Continue to sign in</a>
    <div class="footer">Powered by enpilink</div>
  </main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
