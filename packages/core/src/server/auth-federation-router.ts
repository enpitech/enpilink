import type { Router } from "express";
import express from "express";
import type { JWK } from "jose";
import {
  createOAuthMetadata,
  mcpAuthRouter,
  type UpstreamIdpConfig,
} from "./auth.js";
import type { FederatingOAuthProvider } from "./auth-federation.js";
import { GUEST_SCOPES } from "./auth-federation.js";
import { serverLog } from "./log-sink.js";

/**
 * HTTP routes for the federating Authorization Server (A3).
 *
 * Mounts:
 * - the SDK `mcpAuthRouter` (serves `/.well-known/oauth-authorization-server`,
 *   `/authorize`, `/token`, `/register`) wired to our
 *   {@link FederatingOAuthProvider} (so WE mint the tokens),
 * - `/.well-known/jwks.json` — our PUBLIC signing key (so the A1 verifier /
 *   any client validates OUR tokens),
 * - the branded entry page `/authorize/branded` (Sign in OR Continue as guest),
 * - `/authorize/upstream` (federate the login to the upstream IdP),
 * - `/authorize/callback` (upstream returns here; we resolve the `sub`, mint our
 *   code, and redirect back to the host),
 * - `/authorize/guest` (mint a guest subject + code, no upstream round-trip).
 */

/** Options for {@link buildFederationRouter}. */
export interface FederationRouterOptions {
  issuerUrl: string;
  resourceServerUrl: string;
  provider: FederatingOAuthProvider;
  /** The public signing JWK to advertise at the JWKS endpoint. */
  publicJwk: JWK;
  /** Upstream IdP for real (non-guest) logins. */
  upstream: UpstreamIdpConfig;
  /** Default scopes a real login is granted. */
  scopesSupported?: string[];
  /** The env-only upstream client secret (used for the upstream token exchange). */
  upstreamClientSecret?: string;
  /** The redirect URIs the host may use (for upstream `redirect_uri` = our callback). */
  appName?: string;
  /** Injectable fetch for the upstream token exchange (tests stub it). */
  fetchImpl?: typeof fetch;
}

/**
 * Encode the host's authorization request (the bits we must carry across the
 * upstream round-trip) into an opaque `state` we hand to the upstream, so the
 * callback can rebuild the host redirect. Base64url JSON — no secrets.
 */
interface PendingAuth {
  redirectUri: string;
  codeChallenge: string;
  scope?: string;
  state?: string;
}

function encodePending(p: PendingAuth): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decodePending(raw: string): PendingAuth | undefined {
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function buildFederationRouter(opts: FederationRouterOptions): Router {
  const router = express.Router();
  const provider = opts.provider;

  // Our JWKS — the public half of the signing key. The A1 verifier (or any
  // client) fetches this to validate OUR tokens.
  router.get("/.well-known/jwks.json", (_req, res) => {
    res
      .status(200)
      .set("Cache-Control", "no-store")
      .json({ keys: [opts.publicJwk] });
  });

  // AS metadata with our `jwks_uri` added (the SDK's `mcpAuthRouter` would
  // otherwise omit it). Served BEFORE the SDK router so this wins for the path.
  const jwksUri = new URL("/.well-known/jwks.json", opts.issuerUrl).href;
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    const metadata = createOAuthMetadata({
      provider,
      issuerUrl: new URL(opts.issuerUrl),
      scopesSupported: opts.scopesSupported,
    });
    res
      .status(200)
      .set("Cache-Control", "no-store")
      .json({ ...metadata, jwks_uri: jwksUri });
  });

  // Branded entry page: the SDK `/authorize` handler redirected here (via the
  // provider's `authorize()`). Offers Sign in (upstream) or Continue as guest.
  router.get("/authorize/branded", (req, res) => {
    const q = req.query as Record<string, string>;
    const pending: PendingAuth = {
      redirectUri: String(q.redirect_uri ?? ""),
      codeChallenge: String(q.code_challenge ?? ""),
      scope: q.scope ? String(q.scope) : undefined,
      state: q.state ? String(q.state) : undefined,
    };
    const token = encodePending(pending);
    const signInUrl = `${req.baseUrl}/authorize/upstream?p=${encodeURIComponent(token)}`;
    const guestUrl = `${req.baseUrl}/authorize/guest?p=${encodeURIComponent(token)}`;
    res
      .status(200)
      .set("Content-Type", "text/html; charset=utf-8")
      .set("Cache-Control", "no-store")
      .send(renderEntryHtml(signInUrl, guestUrl, opts.appName ?? "this app"));
  });

  // "Sign in" → federate to the upstream IdP. The upstream returns to OUR
  // callback (not the host directly), so we can mint our own token.
  router.get("/authorize/upstream", (req, res) => {
    const pending = decodePending(String(req.query.p ?? ""));
    if (!pending) {
      res.status(400).send("Invalid authorization request");
      return;
    }
    const callbackUrl = new URL("/authorize/callback", opts.issuerUrl).href;
    const url = new URL(opts.upstream.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", opts.upstream.clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set(
      "scope",
      (opts.upstream.scopes ?? opts.scopesSupported ?? []).join(" "),
    );
    // We carry the host's request in `state` so the callback can rebuild it.
    url.searchParams.set("state", encodePending(pending));
    res.redirect(302, url.href);
  });

  // Upstream returns here with a `code`. We exchange it server-side, resolve the
  // real `sub`, mint OUR auth code, and bounce back to the host's redirect_uri.
  router.get("/authorize/callback", async (req, res) => {
    const pending = decodePending(String(req.query.state ?? ""));
    const upstreamCode = String(req.query.code ?? "");
    if (!pending || !upstreamCode) {
      res.status(400).send("Invalid upstream callback");
      return;
    }
    try {
      const profile = await exchangeUpstreamCode(upstreamCode, opts);
      if (!profile?.sub) {
        res.status(502).send("Could not resolve identity from upstream");
        return;
      }
      const scopes = pending.scope
        ? pending.scope.split(/\s+/).filter(Boolean)
        : (opts.scopesSupported ?? []);
      const redirect = provider.issueCode({
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scopes,
        sub: profile.sub,
        isGuest: false,
        state: pending.state,
        email: profile.email,
        name: profile.name,
      });
      res.redirect(302, redirect);
    } catch (err) {
      serverLog("error", "upstream callback exchange failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(502).send("Upstream sign-in failed");
    }
  });

  // "Continue as guest" → mint a guest subject + code, no upstream round-trip.
  router.get("/authorize/guest", (req, res) => {
    const pending = decodePending(String(req.query.p ?? ""));
    if (!pending) {
      res.status(400).send("Invalid authorization request");
      return;
    }
    const redirect = provider.issueCode({
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      // Guests get ONLY guest scopes — never the oauth2 tool scopes.
      scopes: [...GUEST_SCOPES],
      sub: provider.newGuestSub(),
      isGuest: true,
      state: pending.state,
    });
    res.redirect(302, redirect);
  });

  // The SDK AS endpoints (authorize/token/register/metadata), wired to OUR
  // federating provider.
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(opts.issuerUrl),
      resourceServerUrl: new URL(opts.resourceServerUrl),
      scopesSupported: opts.scopesSupported,
    }),
  );
  return router;
}

/**
 * Exchange an upstream authorization code for the user's identity. Uses the
 * provider's injected `resolveUpstream` when supplied (tests / custom resolvers);
 * otherwise performs the standard OAuth code exchange against the upstream
 * token endpoint and reads the `sub` from the returned id/access token claims.
 */
async function exchangeUpstreamCode(
  code: string,
  opts: FederationRouterOptions,
): Promise<{ sub: string; email?: string; name?: string } | undefined> {
  const resolve = opts.provider.resolveUpstream;
  if (resolve) {
    return resolve(code);
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const callbackUrl = new URL("/authorize/callback", opts.issuerUrl).href;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: opts.upstream.clientId,
    redirect_uri: callbackUrl,
  });
  if (opts.upstreamClientSecret) {
    body.set("client_secret", opts.upstreamClientSecret);
  }
  const resp = await doFetch(opts.upstream.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`upstream token exchange failed (${resp.status})`);
  }
  const json = (await resp.json()) as {
    access_token?: string;
    id_token?: string;
  };
  // Prefer the id_token (OIDC); fall back to access token. Decode the JWT
  // payload WITHOUT verifying signature — the upstream just vouched for the
  // user via the redirect; we are only lifting the `sub`/profile to track. We
  // never store or forward the upstream token (confused-deputy avoidance).
  const claims =
    decodeJwtPayload(json.id_token) ?? decodeJwtPayload(json.access_token);
  const sub = typeof claims?.sub === "string" ? claims.sub : undefined;
  if (!sub) {
    return undefined;
  }
  return {
    sub,
    email: typeof claims?.email === "string" ? claims.email : undefined,
    name: typeof claims?.name === "string" ? claims.name : undefined,
  };
}

/** Decode (NOT verify) a JWT payload. Returns undefined for non-JWTs. */
function decodeJwtPayload(jwt?: string): Record<string, unknown> | undefined {
  if (!jwt) {
    return undefined;
  }
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Branded entry page with BOTH Sign in and Continue as guest. */
function renderEntryHtml(
  signInUrl: string,
  guestUrl: string,
  appName: string,
): string {
  const s = escapeHtml(signInUrl);
  const g = escapeHtml(guestUrl);
  const app = escapeHtml(appName);
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
  .btn.secondary {
    background: #fff; color: var(--ink); border: 1px solid #e5e7eb;
    margin-top: 12px;
  }
  .btn.secondary:hover { background: #f3f4f6; }
  .footer { margin-top: 20px; font-size: 12px; color: #9ca3af; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">e</div>
    <h1>Sign in to continue</h1>
    <p>${app} uses enpilink to keep your sign-in secure. Sign in with your identity provider, or continue as a guest with limited access.</p>
    <a class="btn" href="${s}">Sign in</a>
    <a class="btn secondary" href="${g}">Continue as guest</a>
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

/** Re-exported for symmetry with the A2 branded page (used by tests). */
export const renderFederationEntryHtml = renderEntryHtml;
