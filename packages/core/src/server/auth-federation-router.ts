import crypto from "node:crypto";
import type { Request, Router } from "express";
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
  /** Display name for the branded login page. */
  appName?: string;
  /**
   * Login-page branding (A6). All fields optional + presentational only; the
   * login page falls back to enpilink defaults. NEVER affects the OAuth security
   * model (redirect allowlist, cookie/state binding, PKCE are untouched).
   */
  branding?: LoginBranding;
  /**
   * The redirect URIs the host (OAuth client) is registered to use. The
   * effective `redirectUri` is validated against this allowlist BEFORE we ever
   * redirect to it (open-redirect / code-exfiltration prevention). When empty,
   * no host redirect is accepted (fail closed).
   */
  redirectUris?: string[];
  /** Injectable fetch for the upstream token exchange (tests stub it). */
  fetchImpl?: typeof fetch;
  /**
   * Server-side pending-auth store. Defaults to a fresh in-memory TTL store.
   * Injectable so tests can control the id generator + clock.
   */
  pendingStore?: PendingAuthStore;
}

/**
 * Login-page branding (A6). Customizes the server-rendered branded login page
 * (Auth0-style). Every field is OPTIONAL and PRESENTATIONAL ONLY — the login
 * page falls back to enpilink defaults, and branding never changes the OAuth
 * security model (redirect allowlist, the HttpOnly state-binding cookie, PKCE).
 */
export interface LoginBranding {
  /** App name in the heading ("Sign in to continue to <appName>"). */
  appName?: string;
  /** URL of a logo image rendered above the heading. */
  logoUrl?: string;
  /** Accent color (CSS hex, e.g. `#3fb6a8`) for the button + monogram. */
  accentColor?: string;
  /** Tagline shown under the heading. */
  tagline?: string;
}

/** enpilink default login-page branding (the baseline teal look). */
export const DEFAULT_LOGIN_BRANDING = {
  accentColor: "#3fb6a8",
  accentHover: "#2f9e91",
} as const;

/**
 * The host's authorization request (the bits we must carry across the upstream
 * round-trip). This is kept SERVER-SIDE only — it is NEVER serialized into the
 * upstream `state` or any URL/cookie the browser can read or tamper with. The
 * browser only ever sees an opaque random id (see {@link PendingAuthStore}).
 */
export interface PendingAuth {
  redirectUri: string;
  codeChallenge: string;
  scope?: string;
  state?: string;
}

/**
 * The cookie that binds the federation flow to the user's browser session. Its
 * value MUST equal the `state`/`id` query param at the callback / guest step,
 * which blocks cross-session replay and CSRF (an attacker cannot set a
 * `HttpOnly` cookie in the victim's browser).
 */
const FLOW_COOKIE = "enpilink_auth_flow";

/** How long a pending-auth entry (and the binding cookie) lives. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Server-side store for {@link PendingAuth} entries, keyed by an opaque random
 * id. Single-use (`take` deletes) + short TTL. In-memory only — consistent with
 * A3's in-memory code/refresh state for the single-instance model; a
 * multi-instance deploy needs a shared store (see specs/AUTH.md).
 */
export class PendingAuthStore {
  private readonly entries = new Map<
    string,
    { pending: PendingAuth; expiresAt: number }
  >();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly ttl: number;

  constructor(
    opts: {
      now?: () => number;
      newId?: () => string;
      ttlMs?: number;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.newId =
      opts.newId ?? (() => crypto.randomBytes(32).toString("base64url"));
    this.ttl = opts.ttlMs ?? PENDING_TTL_MS;
  }

  /** Store a pending auth, returning the opaque id to bind it to. */
  create(pending: PendingAuth): string {
    this.sweep();
    const id = this.newId();
    this.entries.set(id, { pending, expiresAt: this.now() + this.ttl });
    return id;
  }

  /** Read WITHOUT consuming (the upstream-redirect step still needs it). */
  peek(id: string): PendingAuth | undefined {
    const rec = this.entries.get(id);
    if (!rec) {
      return undefined;
    }
    if (this.now() > rec.expiresAt) {
      this.entries.delete(id);
      return undefined;
    }
    return rec.pending;
  }

  /** Read AND consume (single-use) — for the terminal callback/guest steps. */
  take(id: string): PendingAuth | undefined {
    const pending = this.peek(id);
    if (pending) {
      this.entries.delete(id);
    }
    return pending;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, rec] of this.entries) {
      if (t > rec.expiresAt) {
        this.entries.delete(id);
      }
    }
  }
}

/** Parse a single cookie value from the raw `Cookie` header (no deps). */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Validate an effective `redirectUri` against the registered allowlist. Exact
 * string match (the host always uses its registered connector callback). Fails
 * closed: an empty allowlist accepts nothing.
 */
function isRegisteredRedirect(
  redirectUri: string,
  registered: string[] | undefined,
): boolean {
  if (!redirectUri || !registered || registered.length === 0) {
    return false;
  }
  return registered.includes(redirectUri);
}

export function buildFederationRouter(opts: FederationRouterOptions): Router {
  const router = express.Router();
  const provider = opts.provider;
  const pendingStore = opts.pendingStore ?? new PendingAuthStore();
  const registeredRedirectUris = opts.redirectUris ?? [];
  // The cookie is `Secure` whenever this AS is served over HTTPS (the public
  // issuer URL is authoritative — works behind a tunnel where `req.protocol`
  // may be http). Locally over http, `Secure` is omitted so the cookie still
  // sets/sends. Always `HttpOnly` + `SameSite=Lax` (the host redirect is a
  // top-level GET navigation, so Lax still sends the cookie on the callback).
  const cookieSecure = (() => {
    try {
      return new URL(opts.issuerUrl).protocol === "https:";
    } catch {
      return false;
    }
  })();
  const flowCookie = (id: string): string => {
    const attrs = [
      `${FLOW_COOKIE}=${encodeURIComponent(id)}`,
      "HttpOnly",
      "SameSite=Lax",
      "Path=/authorize",
      `Max-Age=${Math.floor(PENDING_TTL_MS / 1000)}`,
    ];
    if (cookieSecure) {
      attrs.push("Secure");
    }
    return attrs.join("; ");
  };
  const clearFlowCookie = (): string => {
    const attrs = [
      `${FLOW_COOKIE}=`,
      "HttpOnly",
      "SameSite=Lax",
      "Path=/authorize",
      "Max-Age=0",
    ];
    if (cookieSecure) {
      attrs.push("Secure");
    }
    return attrs.join("; ");
  };

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
  //
  // SECURITY: we do NOT serialize the auth params into any URL/`state` the
  // browser carries. Instead we store them SERVER-SIDE keyed by a random opaque
  // id, set that id as an HttpOnly binding cookie, and pass only the id forward.
  router.get("/authorize/branded", (req, res) => {
    const q = req.query as Record<string, string>;
    const redirectUri = String(q.redirect_uri ?? "");
    // Validate the host redirect_uri against the registered allowlist BEFORE
    // showing any continuation that would later redirect to it.
    if (!isRegisteredRedirect(redirectUri, registeredRedirectUris)) {
      res.status(400).send("Invalid or unregistered redirect_uri");
      return;
    }
    const pending: PendingAuth = {
      redirectUri,
      codeChallenge: String(q.code_challenge ?? ""),
      scope: q.scope ? String(q.scope) : undefined,
      state: q.state ? String(q.state) : undefined,
    };
    const id = pendingStore.create(pending);
    const signInUrl = `${req.baseUrl}/authorize/upstream?id=${encodeURIComponent(id)}`;
    const guestUrl = `${req.baseUrl}/authorize/guest?id=${encodeURIComponent(id)}`;
    res
      .status(200)
      .set("Content-Type", "text/html; charset=utf-8")
      .set("Cache-Control", "no-store")
      .set("Set-Cookie", flowCookie(id))
      .send(
        renderEntryHtml(signInUrl, guestUrl, {
          appName: opts.branding?.appName ?? opts.appName,
          logoUrl: opts.branding?.logoUrl,
          accentColor: opts.branding?.accentColor,
          tagline: opts.branding?.tagline,
        }),
      );
  });

  // "Sign in" → federate to the upstream IdP. The upstream returns to OUR
  // callback (not the host directly), so we can mint our own token.
  router.get("/authorize/upstream", (req, res) => {
    const id = String(req.query.id ?? "");
    const pending = pendingStore.peek(id);
    if (
      !pending ||
      !isRegisteredRedirect(pending.redirectUri, registeredRedirectUris)
    ) {
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
    // The upstream `state` is ONLY the opaque id — the auth params stay
    // server-side. The callback re-reads them by this id (+ the binding cookie).
    url.searchParams.set("state", id);
    res.redirect(302, url.href);
  });

  // Upstream returns here with a `code` + our opaque `state` (the id). We
  // require the binding cookie to ALSO carry that id (CSRF / cross-session
  // replay defense), look up the server-side pending auth (single-use), then
  // exchange the upstream code, mint OUR auth code, and bounce to the host.
  router.get("/authorize/callback", async (req, res) => {
    const id = String(req.query.state ?? "");
    const cookieId = readCookie(req, FLOW_COOKIE);
    const upstreamCode = String(req.query.code ?? "");
    if (!id || !cookieId || cookieId !== id) {
      res
        .status(400)
        .set("Set-Cookie", clearFlowCookie())
        .send("Invalid or missing session binding");
      return;
    }
    // Single-use: consume the pending entry so a replayed callback fails.
    const pending = pendingStore.take(id);
    if (
      !pending ||
      !upstreamCode ||
      !isRegisteredRedirect(pending.redirectUri, registeredRedirectUris)
    ) {
      res
        .status(400)
        .set("Set-Cookie", clearFlowCookie())
        .send("Invalid upstream callback");
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
      // The flow is complete — clear the binding cookie.
      res.set("Set-Cookie", clearFlowCookie()).redirect(302, redirect);
    } catch (err) {
      serverLog("error", "upstream callback exchange failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(502).send("Upstream sign-in failed");
    }
  });

  // "Continue as guest" → mint a guest subject + code, no upstream round-trip.
  // Same binding as the callback: require the HttpOnly cookie to equal the `id`
  // query param, then consume the single-use server-side pending auth.
  router.get("/authorize/guest", (req, res) => {
    const id = String(req.query.id ?? "");
    const cookieId = readCookie(req, FLOW_COOKIE);
    if (!id || !cookieId || cookieId !== id) {
      res
        .status(400)
        .set("Set-Cookie", clearFlowCookie())
        .send("Invalid or missing session binding");
      return;
    }
    const pending = pendingStore.take(id);
    if (
      !pending ||
      !isRegisteredRedirect(pending.redirectUri, registeredRedirectUris)
    ) {
      res
        .status(400)
        .set("Set-Cookie", clearFlowCookie())
        .send("Invalid authorization request");
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
    res.set("Set-Cookie", clearFlowCookie()).redirect(302, redirect);
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

/**
 * Validate + normalize a user-supplied accent color. Only accepts a 3/6/8-digit
 * CSS hex so a branding value can NEVER inject arbitrary CSS into the inline
 * style block. Returns `undefined` for anything else (→ falls back to teal).
 */
function safeHexColor(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw.trim())
    ? raw.trim()
    : undefined;
}

/** Darken a #rrggbb hex by a factor (for the button hover state). */
function darkenHex(hex: string, factor = 0.85): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m?.[1]) {
    return hex;
  }
  const n = Number.parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 0xff) * factor);
  const g = Math.round(((n >> 8) & 0xff) * factor);
  const b = Math.round((n & 0xff) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/**
 * Branded entry page with BOTH Sign in and Continue as guest. Honors A6 login
 * branding (app name / logo / accent / tagline) with enpilink defaults. All
 * branding inputs are escaped (text) or hex-validated (color) — branding is
 * presentational and can never inject markup/CSS or change the flow.
 */
function renderEntryHtml(
  signInUrl: string,
  guestUrl: string,
  branding: LoginBranding = {},
): string {
  const s = escapeHtml(signInUrl);
  const g = escapeHtml(guestUrl);
  const app = escapeHtml(branding.appName ?? "this app");
  const accent =
    safeHexColor(branding.accentColor) ?? DEFAULT_LOGIN_BRANDING.accentColor;
  const accentHover =
    safeHexColor(branding.accentColor) && /^#[0-9a-fA-F]{6}$/.test(accent)
      ? darkenHex(accent)
      : DEFAULT_LOGIN_BRANDING.accentHover;
  const tagline = escapeHtml(
    branding.tagline ??
      `${branding.appName ?? "This app"} uses enpilink to keep your sign-in secure. Sign in with your identity provider, or continue as a guest with limited access.`,
  );
  const logoUrl = safeUrl(branding.logoUrl);
  const mark = logoUrl
    ? `<img class="mark" src="${escapeHtml(logoUrl)}" alt="" />`
    : `<div class="mark">${app.charAt(0).toUpperCase() || "e"}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Sign in</title>
<style>
  :root { --accent: ${accent}; --accent-hover: ${accentHover}; --ink: #1e1645; --muted: #6b7280; }
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
    background: linear-gradient(135deg, var(--accent), var(--accent-hover));
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 22px; object-fit: contain;
  }
  img.mark { background: #fff; border: 1px solid #e5e7eb; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: var(--muted); font-size: 14px; line-height: 1.5; margin: 0 0 28px; }
  .btn {
    display: block; width: 100%; padding: 12px 16px; border: none;
    border-radius: 8px; background: var(--accent); color: #fff; font-size: 15px;
    font-weight: 600; text-decoration: none; cursor: pointer;
    transition: background 0.15s ease;
  }
  .btn:hover { background: var(--accent-hover); }
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
    ${mark}
    <h1>Sign in to continue${branding.appName ? ` to ${app}` : ""}</h1>
    <p>${tagline}</p>
    <a class="btn" href="${s}">Sign in</a>
    <a class="btn secondary" href="${g}">Continue as guest</a>
    <div class="footer">Powered by enpilink</div>
  </main>
</body>
</html>`;
}

/** Allow only http(s) logo URLs (no `javascript:`/`data:` schemes). */
function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:"
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
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
