import { InsufficientScopeError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { SecurityScheme } from "./server.js";

/**
 * Per-tool `securitySchemes` enforcement (A1).
 *
 * When server-level auth is enabled, each tool's declared `securitySchemes`
 * become enforceable (today they are declarative `_meta` only). The bearer
 * guard on `/mcp` validates the token itself (401 on a bad/absent token where
 * required); this function performs the per-tool authorization check against
 * the already-validated principal in `extra.authInfo`:
 *
 * - A tool with `{ type: "noauth" }` listed runs with NO token (the guest seam
 *   A3 builds on) — it is always allowed.
 * - A tool declaring `{ type: "oauth2", scopes: [...] }` requires a token whose
 *   scopes are a superset of the declared scopes; otherwise → `403
 *   insufficient_scope`.
 * - A tool with no `securitySchemes` (and no `noauth`) requires a valid token
 *   when auth is enabled.
 *
 * Throws {@link InsufficientScopeError} (→ 403) or a generic auth error (→ 401
 * via the transport) — it never returns a soft failure. Callers wrap this so an
 * UNEXPECTED error (a bug in here) is swallowed and never 500s the transport.
 */
export class AuthRequiredError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/** Whether a scheme list opts the tool into anonymous (guest) access. */
function allowsNoAuth(schemes: SecurityScheme[]): boolean {
  return schemes.some((s) => s.type === "noauth");
}

/** Collect the union of scopes required by all `oauth2` schemes. */
function requiredScopes(schemes: SecurityScheme[]): string[] {
  const out = new Set<string>();
  for (const s of schemes) {
    if (s.type === "oauth2" && s.scopes) {
      for (const scope of s.scopes) {
        out.add(scope);
      }
    }
  }
  return [...out];
}

/**
 * Enforce a tool's security schemes against the request principal.
 *
 * @param schemes  the tool's declared `securitySchemes` (may be undefined)
 * @param authInfo the validated principal from `extra.authInfo` (or undefined)
 */
export function enforceSecuritySchemes(
  schemes: SecurityScheme[] | undefined,
  authInfo: AuthInfo | undefined,
): void {
  const declared = schemes ?? [];

  // `noauth` tools always run, with or without a token — the guest seam.
  if (allowsNoAuth(declared)) {
    return;
  }

  // No token but auth is required for this tool.
  if (!authInfo) {
    throw new AuthRequiredError(
      "This tool requires authentication. Sign in and retry.",
    );
  }

  // Scope step-up: the token must carry every declared oauth2 scope.
  const needed = requiredScopes(declared);
  if (needed.length > 0) {
    const granted = new Set(authInfo.scopes ?? []);
    const missing = needed.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      throw new InsufficientScopeError(
        `Missing required scope(s): ${missing.join(", ")}`,
      );
    }
  }
}
