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
  /** Injectable clock for deterministic session-recording tests. */
  now?: () => number;
}

/**
 * Merge the programmatic {@link AuthConfig} with the resolved `auth.*` config
 * keys (env/file). The programmatic config wins when provided; otherwise auth
 * is driven entirely by config/env. Returns a normalized {@link AuthConfig}
 * (always with a concrete `enabled`).
 */
export async function resolveAuthConfig(
  programmatic: AuthConfig | undefined,
): Promise<AuthConfig> {
  // Programmatic config is authoritative when present.
  if (programmatic) {
    return programmatic;
  }
  // Otherwise derive from config (env > file). Secrets are not needed here —
  // A1 only reads the non-secret discovery fields.
  let values: Record<string, unknown> = {};
  try {
    const resolved = await resolveConfig(null);
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

  // A2's proxy AS (or a test) can inject its own verifier; otherwise build the
  // built-in JWKS-backed JWT verifier.
  const baseVerifier =
    config.verifier ??
    createJwtVerifier({
      issuer: config.issuer,
      audience: config.audience,
      jwksUrl: config.jwksUrl,
    });

  // Wrap the verifier so every successful auth records a session (A2). When no
  // storage getter is supplied (e.g. some unit tests), this is a passthrough.
  const verifier = secrets.getStorage
    ? recordingVerifier(baseVerifier, secrets.getStorage, secrets.now)
    : baseVerifier;

  const rsUrl = new URL(config.resourceServerUrl ?? resourceUrl);
  // Anchor the PRM at the well-known root (no path suffix) so the document is
  // served at exactly `/.well-known/oauth-protected-resource`.
  const rootUrl = new URL(rsUrl.href);
  rootUrl.pathname = "/";
  rootUrl.search = "";

  const metadataRouter = mcpAuthMetadataRouter({
    // The PRM only needs the issuer to populate `authorization_servers[]`; the
    // rest of the AS metadata is a minimal stub (A2 co-hosts the real AS).
    oauthMetadata: {
      issuer: config.issuer,
      authorization_endpoint: new URL("/authorize", config.issuer).href,
      token_endpoint: new URL("/token", config.issuer).href,
      response_types_supported: ["code"],
    },
    resourceServerUrl: rootUrl,
    scopesSupported: undefined,
  });

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(rootUrl);

  // Co-host the Authorization Server (A2) when an upstream IdP is configured.
  // Without it we stay in A1-only resource-server mode (validate tokens, but no
  // `/authorize` / `/token` / branded login of our own).
  let authServerRouter: Router | null = null;
  if (config.upstream) {
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
