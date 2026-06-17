import {
  type BearerAuthMiddlewareOptions,
  requireBearerAuth,
} from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandler } from "express";
import {
  createRemoteJWKSet,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
  jwtVerify,
} from "jose";

export {
  InsufficientScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
export {
  type BearerAuthMiddlewareOptions,
  requireBearerAuth,
} from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
export type {
  OAuthServerProvider,
  OAuthTokenVerifier,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
export { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
export {
  type AuthMetadataOptions,
  type AuthRouterOptions,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
export type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
export type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Like `requireBearerAuth`, but lets requests through when no
 * `Authorization` header is present. Used for mixed-auth servers where some
 * tools are public and others require sign-in: each tool enforces its own
 * `securitySchemes` against `extra.authInfo`.
 *
 * Behavior:
 * - No `Authorization` header → `next()` without `req.auth`.
 * - Valid Bearer token → `req.auth` set, same as `requireBearerAuth`.
 * - Invalid / malformed / expired / insufficient-scope → same error response
 *   as `requireBearerAuth` (401/403). Sending a bad token is still a client
 *   error.
 */
export function optionalBearerAuth(
  options: BearerAuthMiddlewareOptions,
): RequestHandler {
  const required = requireBearerAuth(options);
  return (req, res, next) => {
    if (!req.headers.authorization) {
      next();
      return;
    }
    return required(req, res, next);
  };
}

/**
 * Server-level end-user auth configuration (A1, resource-server foundation).
 *
 * Pass this to {@link McpServer}'s constructor (`enpilinkOptions.auth`) or let
 * it be resolved from config (`auth.*` keys / `ENPILINK_AUTH*` env). Auth is
 * **opt-in**: when absent / `{ enabled: false }`, `/mcp` stays open exactly as
 * before and no metadata is required.
 *
 * @see https://docs.enpitech.dev/guides/auth
 */
export interface AuthConfig {
  /** Master switch. When false (default) auth is completely off. */
  enabled: boolean;
  /**
   * The Authorization Server issuer URL. Advertised in the PRM
   * `authorization_servers[]` and required as the inbound token `iss`.
   */
  issuer?: string;
  /**
   * The RFC 8707 audience (`aud`) inbound tokens must be bound to — typically
   * the public `/mcp` URL. Prevents confused-deputy token replay.
   */
  audience?: string;
  /** JWKS URL for the built-in JWT verifier (signature verification). */
  jwksUrl?: string;
  /**
   * An explicit token verifier. When set it OVERRIDES the built-in JWT
   * verifier — this is the seam A2's proxy AS (and tests) plug into. When
   * omitted, a JWKS-backed JWT verifier is built from `issuer`/`audience`/
   * `jwksUrl`.
   */
  verifier?: OAuthTokenVerifier;
  /**
   * The public base URL of this resource server (used to compute the PRM
   * `resource` identifier + the `resource_metadata` URL in challenges). When
   * omitted, falls back to the public `/mcp` URL derived per request.
   */
  resourceServerUrl?: string;
  /**
   * Upstream IdP configuration (A2). When present, enpilink co-hosts an OAuth
   * Authorization Server (the SDK's `mcpAuthRouter` + `ProxyOAuthServerProvider`)
   * that proxies the OAuth flow to this upstream provider and serves a branded
   * login page. When omitted, only the A1 resource-server behavior is active
   * (validate tokens against the configured issuer/JWKS).
   */
  upstream?: UpstreamIdpConfig;
  /**
   * Redirect URIs the host (OAuth client) is allowed to use — the AS validates
   * the inbound `redirect_uri` against this list. Typically the ChatGPT/Claude
   * connector callback URLs. When omitted, falls back to the env-only
   * `auth.redirectUris`. Loopback ports are relaxed per RFC 8252.
   */
  redirectUris?: string[];
}

/**
 * Configuration for the upstream identity provider the co-hosted Authorization
 * Server proxies to (A2). The OAuth flow runs: host → OUR `/authorize` (branded
 * page) → upstream `authorize` → upstream login → callback to OUR `/token`
 * proxy → token. We validate the issued token via {@link AuthConfig.jwksUrl}.
 *
 * The `clientSecret` is NEVER part of this object — it is read from the
 * env-only `auth.clientSecret` secret at build time and never persisted,
 * returned, or logged.
 */
export interface UpstreamIdpConfig {
  /** Upstream authorization endpoint URL. */
  authorizationUrl: string;
  /** Upstream token endpoint URL. */
  tokenUrl: string;
  /** Optional upstream token revocation endpoint. */
  revocationUrl?: string;
  /**
   * The OAuth client id registered with the upstream provider (NON-secret —
   * may come from config). The matching client secret is read from the
   * env-only `auth.clientSecret`.
   */
  clientId: string;
  /** Default scopes requested from the upstream provider. */
  scopes?: string[];
}

/** Options for {@link createJwtVerifier}. Injectable for deterministic tests. */
export interface JwtVerifierOptions {
  /** Expected token issuer (`iss`). */
  issuer?: string;
  /** Expected audience (`aud`) — the RFC 8707 resource binding. */
  audience?: string;
  /** JWKS URL used to fetch the AS signing keys. */
  jwksUrl?: string;
  /**
   * Key resolver. Defaults to a remote JWKS set built from `jwksUrl`. Tests
   * inject a local key set (no network) here.
   */
  getKey?: JWTVerifyGetKey;
  /** Injectable clock (ms epoch) for deterministic expiry tests. */
  now?: () => number;
}

/**
 * Build a pluggable {@link OAuthTokenVerifier} that validates a real OAuth 2.1
 * access token (a JWT) against a configured issuer: signature via JWKS, plus
 * `iss` / `aud` / `exp` checks (RFC 8707 audience binding). This is what A2's
 * proxy AS issues tokens for; A2 can also supply its own verifier via
 * {@link AuthConfig.verifier} instead.
 *
 * The returned `verifyAccessToken` throws on any failure so the SDK's
 * `requireBearerAuth` maps it to a 401 — it NEVER returns a partially-valid
 * principal. Network/JWKS failures surface as a thrown error (→ 401), never a
 * crash.
 */
export function createJwtVerifier(
  options: JwtVerifierOptions,
): OAuthTokenVerifier {
  const { issuer, audience, jwksUrl, now } = options;
  // Resolve the key source once: an injected resolver (tests) wins; otherwise
  // build a cached remote JWKS set. `createRemoteJWKSet` lazily fetches + caches
  // keys, so construction does no network I/O.
  let getKey = options.getKey;
  if (!getKey) {
    if (!jwksUrl) {
      throw new Error(
        "createJwtVerifier requires a `jwksUrl` (or an injected `getKey`).",
      );
    }
    getKey = createRemoteJWKSet(new URL(jwksUrl));
  }
  const resolveKey = getKey;

  const verifyOptions: JWTVerifyOptions = {};
  if (issuer) {
    verifyOptions.issuer = issuer;
  }
  if (audience) {
    verifyOptions.audience = audience;
  }
  // jose checks `exp`/`nbf` against its own clock; allow an injected clock for
  // determinism (it accepts a `currentDate`).
  if (now) {
    verifyOptions.currentDate = new Date(now());
  }

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const { payload } = await jwtVerify(token, resolveKey, verifyOptions);

      // Scopes: OAuth `scope` is a space-delimited string; some ASes use a
      // `scopes` array. Accept both, tolerate absence.
      const scopes = parseScopes(payload.scope ?? payload.scopes);

      const expiresAt =
        typeof payload.exp === "number" ? payload.exp : undefined;
      const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;

      return {
        token,
        // `client_id` is optional on a JWT; fall back to the subject so a
        // principal always has a stable id.
        clientId:
          typeof payload.client_id === "string"
            ? payload.client_id
            : (payload.sub ?? "unknown"),
        scopes,
        expiresAt,
        resource:
          typeof aud === "string" && isUrl(aud) ? new URL(aud) : undefined,
        // `sub` is the stable per-user tracking key; surface the full claim set
        // under `extra` so handlers can read identity via `getAuthInfo`.
        extra: { ...payload, sub: payload.sub },
      };
    },
  };
}

function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string");
  }
  if (typeof raw === "string") {
    return raw.split(/\s+/).filter(Boolean);
  }
  return [];
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
 * The authenticated principal, as read from a tool handler's `extra.authInfo`.
 * Thin typed view over the SDK's {@link AuthInfo} with the `sub` claim
 * surfaced for convenience (the stable per-user tracking key).
 */
export interface Identity {
  /** Stable per-user id (the JWT `sub` claim), if present. */
  sub?: string;
  /** Granted scopes. */
  scopes: string[];
  /** The OAuth client id (or `sub` fallback). */
  clientId: string;
  /** Raw claims / token extras. */
  claims: Record<string, unknown>;
}

/**
 * Read the authenticated principal from a tool handler's `extra`. Returns
 * `undefined` for unauthenticated (guest) calls — e.g. a `{ type: "noauth" }`
 * tool with no token, or when auth is disabled.
 *
 * @example
 * ```ts
 * server.registerTool({ name: "me", securitySchemes: [{ type: "oauth2" }] },
 *   async (_args, extra) => {
 *     const id = getAuthInfo(extra);
 *     return { content: `Hello ${id?.sub ?? "guest"}` };
 *   });
 * ```
 */
export function getAuthInfo(extra: {
  authInfo?: AuthInfo;
}): Identity | undefined {
  const info = extra.authInfo;
  if (!info) {
    return undefined;
  }
  const claims = (info.extra ?? {}) as Record<string, unknown>;
  const sub = typeof claims.sub === "string" ? claims.sub : undefined;
  return {
    sub,
    scopes: info.scopes ?? [],
    clientId: info.clientId,
    claims,
  };
}
