import crypto from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError, type OAuthTokenVerifier } from "./auth.js";

/**
 * In-memory access-token revocation denylist (A5).
 *
 * enpilink's access tokens are stateless JWTs — once issued (≤1h TTL in
 * federating mode) the signature alone makes them valid until `exp`. To make the
 * Auth tab's "revoke" action a TRUE revocation (not just an informational
 * row-delete), the verifier consults this denylist on every validation: a
 * revoked token's reference is rejected with `InvalidTokenError` (→ 401) even
 * though its signature/expiry still check out.
 *
 * Keyed by {@link tokenRef} = `sha256(accessToken)` — the SAME opaque reference
 * a session row already stores (`AuthSession.tokenRef`), so revoking a session
 * means denylisting exactly that reference. We never hold the raw token.
 *
 * **Caveat (multi-instance):** the denylist is per-process and in-memory (like
 * the federating provider's PKCE / refresh state). A horizontally-scaled deploy
 * needs a shared denylist (or sticky sessions) for cross-instance revocation —
 * documented as a known limitation. Each entry is auto-evicted at its `exp`
 * (the token would have lapsed anyway), so the set never grows unbounded.
 */

/** SHA-256 hex of a token — the one-way reference stored on a session. */
export function tokenRef(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Map of revoked tokenRef → expiry (epoch seconds) for auto-eviction. */
const revoked = new Map<string, number>();

/**
 * Revoke an access token by its opaque reference (`sha256(token)`). `expiresAt`
 * (epoch seconds, optional) lets the entry auto-evict once the token would have
 * lapsed anyway — defaults to a 1-day horizon when unknown.
 */
export function revokeTokenRef(ref: string, expiresAt?: number): void {
  const horizon = expiresAt ?? Math.floor(Date.now() / 1000) + 60 * 60 * 24;
  revoked.set(ref, horizon);
}

/** Whether a tokenRef is currently revoked (and not yet auto-evicted). */
export function isTokenRefRevoked(ref: string, nowSec?: number): boolean {
  const exp = revoked.get(ref);
  if (exp === undefined) {
    return false;
  }
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (exp <= now) {
    // Lapsed — evict and treat as not revoked (it's invalid on its own now).
    revoked.delete(ref);
    return false;
  }
  return true;
}

/** Clear the entire denylist. Test-only helper for determinism. */
export function clearRevocations(): void {
  revoked.clear();
}

/** Number of live denylist entries (test/diagnostic helper). */
export function revocationCount(): number {
  return revoked.size;
}

/**
 * Wrap a token verifier so a revoked token fails verification. After the
 * underlying verifier succeeds, the wrapper checks the access token's reference
 * against the denylist and throws {@link InvalidTokenError} (→ 401) when
 * revoked. Applied AFTER the recording verifier so a revoked token is not
 * re-recorded as an active session.
 */
export function revocableVerifier(
  verifier: OAuthTokenVerifier,
  now: () => number = Date.now,
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (isTokenRefRevoked(tokenRef(token), Math.floor(now() / 1000))) {
        throw new InvalidTokenError("Token has been revoked");
      }
      return verifier.verifyAccessToken(token);
    },
  };
}
