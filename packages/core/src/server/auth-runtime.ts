import type { Router } from "express";
import {
  type AuthConfig,
  createJwtVerifier,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  type OAuthTokenVerifier,
  type UpstreamIdpConfig,
} from "./auth.js";
import {
  buildClientsStore,
  FederatingOAuthProvider,
  type SigningKeys,
  verifyEnpilinkToken,
} from "./auth-federation.js";
import {
  buildFederationRouter,
  type LoginBranding,
} from "./auth-federation-router.js";
import { revocableVerifier } from "./auth-revocation.js";
import {
  buildAuthServerRouter,
  buildProxyProvider,
  recordingVerifier,
} from "./auth-server.js";
import { resolveConfig } from "./config/index.js";
import type { StorageAdapter } from "./storage/types.js";

/**
 * Resolved, runtime-ready end-user auth for a server (A1).
 *
 * Built once during `run()`/`connect()` from either the programmatic
 * {@link AuthConfig} (constructor) or, when absent, the `auth.*` config keys.
 * Holds the verifier, the PRM router to mount, and the `resource_metadata` URL
 * that goes into 401/403 `WWW-Authenticate` challenges.
 *
 * `null` when auth is disabled — the default. The caller then leaves `/mcp`
 * completely open, exactly as before (no guard, no metadata).
 */
export interface AuthRuntime {
  verifier: OAuthTokenVerifier;
  /** RFC 9728 Protected Resource Metadata router (well-known endpoint). */
  metadataRouter: Router;
  /** The `resource_metadata=` URL advertised in `WWW-Authenticate`. */
  resourceMetadataUrl: string;
  /**
   * The co-hosted Authorization Server router (A2): branded login page +
   * `mcpAuthRouter` (`/.well-known/oauth-authorization-server`, `/authorize`,
   * `/token`, `/register`). `null` when no upstream IdP is configured (A1-only
   * resource-server mode — token validation but no co-hosted AS).
   */
  authServerRouter: Router | null;
  config: AuthConfig;
}

/** Secret/dynamic inputs that A2's co-hosted AS needs but A1 didn't. */
export interface AuthRuntimeSecrets {
  /** Resolves the active storage adapter (for session recording). */
  getStorage?: () => StorageAdapter | null;
  /** The env-only upstream client secret (`auth.clientSecret`). */
  clientSecret?: string;
  /** Redirect URIs the host (OAuth client) may use. */
  redirectUris?: string[];
  /** Display name for the branded login page. */
  appName?: string;
  /** Login-page branding (A6, presentational only — logo/accent/tagline). */
  branding?: LoginBranding;
  /**
   * The env-only token signing keypair (A3), derived from `auth.signingKey`.
   * When present, enpilink runs as a FEDERATING AS that mints + signs its own
   * tokens (guest + lazy/step-up). When absent (A2 path), the co-hosted AS is a
   * transparent proxy to the upstream IdP. Derived in `getAuthRuntime` (async)
   * and passed here so `buildAuthRuntime` stays synchronous.
   */
  signingKeys?: SigningKeys;
  /** Injectable clock for deterministic session-recording tests. */
  now?: () => number;
  /** Injectable id generator for the federating provider (deterministic tests). */
  randomId?: () => string;
}

/**
 * Merge the programmatic {@link AuthConfig} with the resolved `auth.*` config
 * keys (env/file). The programmatic config wins when provided; otherwise auth
 * is driven entirely by config/env. Returns a normalized {@link AuthConfig}
 * (always with a concrete `enabled`).
 */
export async function resolveAuthConfig(
  programmatic: AuthConfig | undefined,
  storage: StorageAdapter | null = null,
): Promise<AuthConfig> {
  // Programmatic config is authoritative when present.
  if (programmatic) {
    return programmatic;
  }
  // Otherwise derive from config (env > file > db). The non-secret auth keys
  // (enabled/issuer/audience/jwks/upstream/redirects) are restart-tier and may
  // be persisted in the DB via the console Setup screen, so read them through
  // the active storage. Secrets are never read here (read env-only later).
  let values: Record<string, unknown> = {};
  try {
    const resolved = await resolveConfig(storage);
    values = resolved.values as Record<string, unknown>;
  } catch {
    values = {};
  }
  const enabled = values["auth.enabled"] === true;
  return {
    enabled,
    issuer: asString(values["auth.issuer"]),
    audience: asString(values["auth.audience"]),
    jwksUrl: asString(values["auth.jwksUrl"]),
    upstream: resolveUpstreamConfig(values),
  };
}

/**
 * Build the {@link UpstreamIdpConfig} from resolved config values, or
 * `undefined` when not enough is configured to co-host the AS. Requires the
 * client id + both upstream endpoints; the client SECRET is read separately
 * (env-only) at build time.
 */
function resolveUpstreamConfig(
  values: Record<string, unknown>,
): UpstreamIdpConfig | undefined {
  const clientId = asString(values["auth.upstream.clientId"]);
  const authorizationUrl = asString(values["auth.upstream.authorizationUrl"]);
  const tokenUrl = asString(values["auth.upstream.tokenUrl"]);
  if (!clientId || !authorizationUrl || !tokenUrl) {
    return undefined;
  }
  return {
    clientId,
    authorizationUrl,
    tokenUrl,
    revocationUrl: asString(values["auth.upstream.revocationUrl"]),
    scopes: parseList(asString(values["auth.upstream.scopes"])),
  };
}

/** Split a space/comma-delimited list, tolerating absence. */
export function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const out = raw.split(/[\s,]+/).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Build the {@link AuthRuntime} from a resolved {@link AuthConfig}, or return
 * `null` when auth is disabled. Throws a clear error when auth is enabled but
 * misconfigured (no verifier and not enough to build one) — surfaced at boot,
 * never silently leaving `/mcp` open while claiming to be protected.
 *
 * @param resourceUrl the public resource-server URL (defaults to the `/mcp`
 *   endpoint), used for the PRM `resource` identifier + the
 *   `resource_metadata` challenge URL.
 */
export function buildAuthRuntime(
  config: AuthConfig,
  resourceUrl: string,
  secrets: AuthRuntimeSecrets = {},
): AuthRuntime | null {
  if (!config.enabled) {
    return null;
  }

  if (!config.issuer) {
    throw new Error(
      "enpilink auth is enabled but `auth.issuer` is not set. Configure ENPILINK_AUTH_ISSUER (or pass `auth.issuer`).",
    );
  }

  const rsUrl = new URL(config.resourceServerUrl ?? resourceUrl);
  // Anchor the PRM at the well-known root (no path suffix) so the document is
  // served at exactly `/.well-known/oauth-protected-resource`.
  const rootUrl = new URL(rsUrl.href);
  rootUrl.pathname = "/";
  rootUrl.search = "";

  // Verifier precedence:
  // 1. An explicitly injected verifier (A2 / tests) always wins.
  // 2. A3 FEDERATING mode (signing keys present + upstream): validate OUR minted
  //    tokens against the LOCAL JWKS derived from the signing key — no network,
  //    and `auth.jwksUrl` is irrelevant (it points at us anyway).
  // 3. A1/A2 mode: the JWKS-backed JWT verifier against the configured issuer.
  const federating = !!secrets.signingKeys && !!config.upstream;
  const baseVerifier =
    config.verifier ??
    (federating && secrets.signingKeys
      ? {
          verifyAccessToken: (token: string) =>
            verifyEnpilinkToken(token, {
              issuer: config.issuer as string,
              audience: config.audience ?? rsUrl.href,
              keys: secrets.signingKeys as SigningKeys,
              now: secrets.now,
            }),
        }
      : createJwtVerifier({
          issuer: config.issuer,
          audience: config.audience,
          jwksUrl: config.jwksUrl,
        }));

  // Wrap the verifier so every successful auth records a session (A2). When no
  // storage getter is supplied (e.g. some unit tests), this is a passthrough.
  const recording = secrets.getStorage
    ? recordingVerifier(baseVerifier, secrets.getStorage, secrets.now)
    : baseVerifier;
  // Revocation check OUTERMOST (A5): a revoked access token is rejected (→ 401)
  // BEFORE it is recorded as an active session. Cheap in-memory denylist keyed
  // on `sha256(token)` (= the session's `tokenRef`); see auth-revocation.ts.
  const verifier = revocableVerifier(recording, secrets.now);

  const metadataRouter = mcpAuthMetadataRouter({
    // The PRM only needs the issuer to populate `authorization_servers[]`; the
    // rest of the AS metadata is a minimal stub (the AS router co-hosts the real
    // AS). In federating mode we additionally advertise our JWKS URI so clients
    // can validate OUR tokens.
    oauthMetadata: {
      issuer: config.issuer,
      authorization_endpoint: new URL("/authorize", config.issuer).href,
      token_endpoint: new URL("/token", config.issuer).href,
      response_types_supported: ["code"],
      ...(federating
        ? { jwks_uri: new URL("/.well-known/jwks.json", config.issuer).href }
        : {}),
    },
    resourceServerUrl: rootUrl,
    scopesSupported: undefined,
  });

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(rootUrl);

  // Co-host the Authorization Server when an upstream IdP is configured.
  // Without it we stay in A1-only resource-server mode (validate tokens, but no
  // `/authorize` / `/token` / branded login of our own).
  let authServerRouter: Router | null = null;
  if (config.upstream && federating && secrets.signingKeys) {
    // A3 FEDERATING mode: WE mint + sign tokens, federate the login upstream,
    // and offer "Continue as guest". The verifier above validates our tokens.
    const provider = new FederatingOAuthProvider(
      {
        issuer: config.issuer,
        audience: config.audience ?? rsUrl.href,
        keys: secrets.signingKeys,
        defaultScopes: config.upstream.scopes,
        now: secrets.now,
        randomId: secrets.randomId,
      },
      buildClientsStore(secrets.redirectUris ?? []),
    );
    authServerRouter = buildFederationRouter({
      issuerUrl: config.issuer,
      resourceServerUrl: rsUrl.href,
      provider,
      publicJwk: secrets.signingKeys.publicJwk,
      upstream: config.upstream,
      scopesSupported: config.upstream.scopes,
      upstreamClientSecret: secrets.clientSecret,
      appName: secrets.appName,
      branding: secrets.branding,
      // Validate every host `redirect_uri` against the registered allowlist
      // before redirecting to it (open-redirect / code-exfil prevention).
      redirectUris: secrets.redirectUris ?? [],
    });
  } else if (config.upstream) {
    // A2 TRANSPARENT-PROXY mode (no signing key): tokens are upstream-issued.
    const provider = buildProxyProvider({
      upstream: config.upstream,
      verifier,
      clientSecret: secrets.clientSecret,
      redirectUris: secrets.redirectUris ?? [],
    });
    authServerRouter = buildAuthServerRouter({
      issuerUrl: config.issuer,
      resourceServerUrl: rsUrl.href,
      provider,
      scopesSupported: config.upstream.scopes,
      appName: secrets.appName,
    });
  }

  return {
    verifier,
    metadataRouter,
    resourceMetadataUrl,
    authServerRouter,
    config,
  };
}
