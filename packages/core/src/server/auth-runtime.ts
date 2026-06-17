import type { Router } from "express";
import {
  type AuthConfig,
  createJwtVerifier,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  type OAuthTokenVerifier,
} from "./auth.js";
import { resolveConfig } from "./config/index.js";

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
  config: AuthConfig;
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
  };
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
  const verifier =
    config.verifier ??
    createJwtVerifier({
      issuer: config.issuer,
      audience: config.audience,
      jwksUrl: config.jwksUrl,
    });

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

  return { verifier, metadataRouter, resourceMetadataUrl, config };
}
