import crypto from "node:crypto";
import type { Response } from "express";
import {
  createLocalJWKSet,
  exportJWK,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from "jose";
import type {
  AuthInfo,
  AuthorizationParams,
  OAuthClientInformationFull,
  OAuthRegisteredClientsStore,
  OAuthServerProvider,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "./auth.js";
import { GUEST_SUB_PREFIX } from "./storage/types.js";

/**
 * Federating Authorization Server (A3).
 *
 * In A2 enpilink ran a transparent **proxy** AS: tokens were issued by the
 * upstream IdP and we only validated them. A3 needs to MINT our own tokens
 * (so we can issue *guest* tokens and stamp our own `sub`/scopes), so we swap
 * the proxy for a **federating** {@link OAuthServerProvider}:
 *
 * - WE issue + sign the tokens the host receives (Ed25519, key derived from the
 *   env-only `auth.signingKey`), advertise our JWKS at `/.well-known/jwks.json`,
 *   and set `auth.issuer`/jwks to point at US — so the A1 verifier validates
 *   OUR tokens.
 * - We still federate the *login* to the upstream IdP for real users (our
 *   `/authorize` → branded page → upstream → our callback → we mint our token).
 * - "Continue as guest" mints a limited guest token (`sub` = `guest:<id>`) with
 *   no upstream round-trip.
 *
 * We own PKCE storage + the code→token mapping locally (the proxy delegated
 * PKCE upstream); the SDK's `/token` handler performs the S256 check against the
 * challenge we return from {@link FederatingOAuthProvider.challengeForAuthorizationCode}.
 *
 * Determinism for tests: the keypair is derived from the signing key (no RNG),
 * and the clock + id/code generators are injectable.
 */

/**
 * Thrown when the federating AS is enabled in production but no
 * `auth.signingKey` is set. Let it propagate so the process exits non-zero with
 * a clear message — never run a token issuer with a predictable/ephemeral key
 * in prod (mirrors {@link AdminTokenMissingError}).
 */
export class AuthSigningKeyMissingError extends Error {
  constructor() {
    super(
      "End-user auth is enabled but no `auth.signingKey` is set in production. " +
        "Set ENPILINK_AUTH_SIGNING_KEY to a strong, stable secret (used to sign " +
        "the tokens enpilink issues). Refusing to start a federating Authorization " +
        "Server with an unstable/predictable signing key.",
    );
    this.name = "AuthSigningKeyMissingError";
  }
}

/** A signed-token keypair derived deterministically from the signing key. */
export interface SigningKeys {
  /** Node KeyObject private key (Ed25519) used to sign tokens. */
  privateKey: crypto.KeyObject;
  /** The public JWK (with `kid`/`alg`) advertised at the JWKS endpoint. */
  publicJwk: JWK;
}

/**
 * Derive a STABLE Ed25519 keypair from the env-only signing key. Same signing
 * key → same keys (so restarts keep validating previously-issued tokens, and
 * tests are deterministic). The signing key never leaves memory; only the
 * PUBLIC key is ever exported (to the JWKS).
 */
export async function deriveSigningKeys(
  signingKey: string,
): Promise<SigningKeys> {
  // A 32-byte seed from the secret; wrap it as a PKCS#8 Ed25519 private key
  // (RFC 8410). `generateKeyPairSync` is random — we need determinism, so we
  // construct the key from the seed bytes directly.
  const seed = crypto.createHash("sha256").update(signingKey).digest();
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  const privateKey = crypto.createPrivateKey({
    key: pkcs8,
    format: "der",
    type: "pkcs8",
  });
  const publicKey = crypto.createPublicKey(privateKey);
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  // A stable, deterministic kid (thumbprint of the public key material).
  publicJwk.kid = crypto
    .createHash("sha256")
    .update(`${publicJwk.crv}:${publicJwk.x}`)
    .digest("hex")
    .slice(0, 16);
  return { privateKey, publicJwk };
}

/** Scopes a guest token is allowed to carry. Never includes `oauth2` scopes. */
export const GUEST_SCOPES = ["guest"] as const;

/** Options for {@link FederatingOAuthProvider}. */
export interface FederatingProviderOptions {
  /** This AS/RS issuer URL (our origin). Stamped as the token `iss`. */
  issuer: string;
  /** The resource the token is bound to (`aud`) — the public `/mcp` URL. */
  audience: string;
  /** The deterministic signing keypair (derived from `auth.signingKey`). */
  keys: SigningKeys;
  /** Default scopes a real (upstream) login is granted. */
  defaultScopes?: string[];
  /** Access-token lifetime in seconds (default 1h). */
  tokenTtlSeconds?: number;
  /**
   * Resolve the upstream `sub` (+ optional profile claims) for a completed
   * upstream login. A3's federation router calls this after the upstream
   * callback; here it is injectable so tests stub the upstream entirely.
   */
  resolveUpstream?: (
    upstreamCode: string,
  ) => Promise<{ sub: string; email?: string; name?: string } | undefined>;
  /** Injectable clock (ms epoch) for deterministic tests. */
  now?: () => number;
  /** Injectable id generator for codes/guest ids (deterministic tests). */
  randomId?: () => string;
}

/** Internal record of a pending authorization (a minted code). */
interface CodeRecord {
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  /** Resolved subject (real `sub` or `guest:<id>`). */
  sub: string;
  isGuest: boolean;
  email?: string;
  name?: string;
  /** When the code was issued (ms) — codes expire quickly. */
  issuedAt: number;
}

/** Authorization codes live this long (ms) before they are unusable. */
const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * A federating {@link OAuthServerProvider}: WE mint + sign the access tokens.
 *
 * The SDK's `/authorize` handler calls {@link authorize} (which redirects the
 * browser to our branded page); our federation router resolves the subject
 * (upstream login OR guest) and calls {@link issueCode} to mint an auth code
 * mapped to that subject + the original PKCE challenge; the SDK's `/token`
 * handler validates PKCE (via {@link challengeForAuthorizationCode}) and calls
 * {@link exchangeAuthorizationCode}, where we sign and return our token.
 */
export class FederatingOAuthProvider implements OAuthServerProvider {
  private readonly codes = new Map<string, CodeRecord>();
  private readonly refresh = new Map<
    string,
    {
      sub: string;
      scopes: string[];
      isGuest: boolean;
      email?: string;
      name?: string;
    }
  >();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly ttl: number;
  /** A pluggable clients store the AS reads from. */
  readonly clientsStore: OAuthRegisteredClientsStore;
  /**
   * The injected upstream resolver, exposed for the federation router's
   * callback (tests stub this; absent → the router does a real OAuth exchange).
   */
  readonly resolveUpstream?: FederatingProviderOptions["resolveUpstream"];

  constructor(
    private readonly opts: FederatingProviderOptions,
    clientsStore: OAuthRegisteredClientsStore,
  ) {
    this.now = opts.now ?? Date.now;
    this.randomId =
      opts.randomId ?? (() => crypto.randomBytes(24).toString("hex"));
    this.ttl = opts.tokenTtlSeconds ?? 3600;
    this.clientsStore = clientsStore;
    this.resolveUpstream = opts.resolveUpstream;
  }

  /**
   * We do our OWN PKCE validation (the SDK's `/token` handler calls
   * {@link challengeForAuthorizationCode} + verifies S256), so this is `false`
   * — unlike the A2 proxy which delegated PKCE upstream (`true`).
   */
  readonly skipLocalPkceValidation = false;

  /**
   * Begin the authorization flow. We redirect the browser to OUR branded login
   * page (out-of-band), preserving the host's `redirect_uri`, `state`, scopes,
   * and PKCE `code_challenge`. The page offers "Sign in" (→ upstream) or
   * "Continue as guest"; the federation router completes the loop and issues
   * the code back to the host.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const url = new URL("/authorize/branded", this.opts.issuer);
    url.searchParams.set("client_id", client.client_id);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("code_challenge", params.codeChallenge);
    if (params.state) {
      url.searchParams.set("state", params.state);
    }
    if (params.scopes && params.scopes.length > 0) {
      url.searchParams.set("scope", params.scopes.join(" "));
    }
    res.redirect(302, url.href);
  }

  /** Return the PKCE challenge stored when the code was issued (for S256). */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const rec = this.codes.get(authorizationCode);
    if (!rec) {
      throw new Error("Unknown or expired authorization code");
    }
    return rec.codeChallenge;
  }

  /** Exchange a one-time auth code for our freshly-minted, signed token. */
  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(authorizationCode);
    if (!rec) {
      throw new Error("Unknown or expired authorization code");
    }
    // One-time use + expiry.
    this.codes.delete(authorizationCode);
    if (this.now() - rec.issuedAt > CODE_TTL_MS) {
      throw new Error("Authorization code expired");
    }
    if (redirectUri && redirectUri !== rec.redirectUri) {
      throw new Error("redirect_uri mismatch");
    }
    return this.mintTokens(rec.sub, rec.scopes, rec.isGuest, {
      email: rec.email,
      name: rec.name,
    });
  }

  /** Re-mint an access token from a stored refresh token. */
  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const rec = this.refresh.get(refreshToken);
    if (!rec) {
      throw new Error("Unknown refresh token");
    }
    // Refresh may narrow scopes but never widen them.
    const next =
      scopes && scopes.length > 0
        ? scopes.filter((s) => rec.scopes.includes(s))
        : rec.scopes;
    return this.mintTokens(rec.sub, next, rec.isGuest, {
      email: rec.email,
      name: rec.name,
    });
  }

  /** Verify one of OUR tokens (this is also the A1 verifier seam). */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return verifyEnpilinkToken(token, this.opts);
  }

  // --- A3 federation entry points (called by the federation router) ---

  /**
   * Issue a one-time authorization code for a resolved subject (real or guest)
   * bound to the original PKCE challenge + redirect URI. Returns the host
   * redirect URL (the host's `redirect_uri` with our `code` + `state`).
   */
  issueCode(input: {
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    sub: string;
    isGuest: boolean;
    state?: string;
    email?: string;
    name?: string;
  }): string {
    const code = this.randomId();
    this.codes.set(code, {
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      sub: input.sub,
      isGuest: input.isGuest,
      email: input.email,
      name: input.name,
      issuedAt: this.now(),
    });
    const url = new URL(input.redirectUri);
    url.searchParams.set("code", code);
    if (input.state) {
      url.searchParams.set("state", input.state);
    }
    return url.href;
  }

  /** Mint a fresh guest subject id (`guest:<random>`). */
  newGuestSub(): string {
    return `${GUEST_SUB_PREFIX}${this.randomId()}`;
  }

  /** Sign an access token (+ a refresh token) for a subject. */
  private async mintTokens(
    sub: string,
    scopes: string[],
    isGuest: boolean,
    profile: { email?: string; name?: string } = {},
  ): Promise<OAuthTokens> {
    const nowSec = Math.floor(this.now() / 1000);
    const exp = nowSec + this.ttl;
    const payload: JWTPayload = {
      sub,
      scope: scopes.join(" "),
      // A coarse flag in the token too, for any consumer that reads claims.
      ...(isGuest ? { guest: true } : {}),
      // Non-secret profile fields, lifted from the upstream login (so the
      // session recorder + the view's `useUser` see name/email).
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.name ? { name: profile.name } : {}),
    };
    const accessToken = await new SignJWT(payload)
      .setProtectedHeader({ alg: "EdDSA", kid: this.opts.keys.publicJwk.kid })
      .setIssuer(this.opts.issuer)
      .setAudience(this.opts.audience)
      .setIssuedAt(nowSec)
      .setExpirationTime(exp)
      .sign(this.opts.keys.privateKey);

    const refreshToken = this.randomId();
    this.refresh.set(refreshToken, {
      sub,
      scopes,
      isGuest,
      email: profile.email,
      name: profile.name,
    });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.ttl,
      scope: scopes.join(" "),
      refresh_token: refreshToken,
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // Best-effort: drop a refresh token if we recognize it. Access tokens are
    // stateless (JWT) so they expire on their own.
    this.refresh.delete(request.token);
  }
}

/**
 * Build a token verifier for OUR minted tokens, backed by a LOCAL JWKS (the
 * public key derived from the signing key) — no network. This is what
 * `auth.issuer`/jwks point at; the A1 verifier path uses this instead of a
 * remote JWKS when a federating AS is active.
 */
export function verifyEnpilinkToken(
  token: string,
  opts: Pick<FederatingProviderOptions, "issuer" | "audience" | "keys" | "now">,
): Promise<AuthInfo> {
  const jwks = createLocalJWKSet({ keys: [opts.keys.publicJwk] });
  const verifyOptions: Parameters<typeof jwtVerify>[2] = {
    issuer: opts.issuer,
    audience: opts.audience,
  };
  if (opts.now) {
    verifyOptions.currentDate = new Date(opts.now());
  }
  return jwtVerify(token, jwks, verifyOptions).then(({ payload }) => {
    const scope = payload.scope;
    const scopes =
      typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [];
    const expiresAt = typeof payload.exp === "number" ? payload.exp : undefined;
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    return {
      token,
      clientId:
        typeof payload.client_id === "string"
          ? payload.client_id
          : (payload.sub ?? "unknown"),
      scopes,
      expiresAt,
      resource:
        typeof aud === "string" && isUrl(aud) ? new URL(aud) : undefined,
      extra: { ...payload, sub: payload.sub },
    } satisfies AuthInfo;
  });
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A simple in-memory clients store for the federating AS. The host (OAuth
 * client) is a PUBLIC client (no secret — it authenticates with PKCE), so the
 * synthesized client carries NO `client_secret`. Any `client_id` the host
 * presents resolves to the configured redirect URIs.
 */
export function buildClientsStore(
  redirectUris: string[],
): OAuthRegisteredClientsStore {
  return {
    async getClient(
      clientId: string,
    ): Promise<OAuthClientInformationFull | undefined> {
      return {
        client_id: clientId,
        // Public client: PKCE-only, NO secret. (Storing a secret here would
        // force the host to present one at /token.)
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
      };
    },
  };
}
