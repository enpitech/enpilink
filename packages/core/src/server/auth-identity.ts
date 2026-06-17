import { type AuthInfo, getAuthInfo } from "./auth.js";
import { isGuestSub } from "./storage/types.js";

/**
 * The name of the built-in identity tool the framework auto-registers when
 * end-user auth is enabled (A4). Namespaced to avoid colliding with an app's
 * own tools. The React view round-trips this `noauth` tool (via `useAuth`) to
 * discover "who am I" — the host passes NO identity into the view's iframe.
 *
 * It is `{ type: "noauth" }` on purpose: anonymous and guest callers MUST be
 * able to call it (that is exactly how the view learns it is NOT signed in).
 */
export const IDENTITY_TOOL_NAME = "enpilink_whoami";

/**
 * The three identity states a caller can be in:
 * - `anonymous` — no token at all (no `sub`).
 * - `guest` — a minted guest token (`sub` carries the `guest:` prefix, or the
 *   `guest:true` claim).
 * - `authed` — a real upstream-backed identity (a non-guest `sub`).
 */
export type AuthState = "anonymous" | "guest" | "authed";

/**
 * The identity payload returned by the built-in identity tool and surfaced by
 * the `useAuth` web hook. Carries ONLY identity/claims — NEVER a token.
 */
export interface AuthIdentity {
  state: AuthState;
  /** Stable per-user id (the JWT `sub`), or `undefined` when anonymous. */
  sub?: string;
  /** Convenience flag, true when `state === "guest"`. */
  isGuest: boolean;
  /** Granted scopes (empty when anonymous). */
  scopes: string[];
  /** The user's email, when the upstream login supplied it as a claim. */
  email?: string;
  /** The user's display name, when supplied as a claim. */
  name?: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Derive the {@link AuthIdentity} from a tool handler's `extra`.
 *
 * - No `authInfo` → `anonymous`.
 * - `sub` has the `guest:` prefix (or a `guest: true` claim) → `guest`.
 * - Otherwise a real `sub` → `authed`.
 *
 * NEVER returns a token — only the `sub`, scopes, and the email/name claims.
 */
export function buildIdentity(extra: { authInfo?: AuthInfo }): AuthIdentity {
  const info = getAuthInfo(extra);
  if (!info?.sub) {
    return { state: "anonymous", isGuest: false, scopes: info?.scopes ?? [] };
  }
  const claims = info.claims;
  const isGuest = isGuestSub(info.sub) || claims.guest === true;
  return {
    state: isGuest ? "guest" : "authed",
    sub: info.sub,
    isGuest,
    scopes: info.scopes,
    email: asString(claims.email),
    name: asString(claims.name),
  };
}

/** The structured shape the identity tool returns to the view. */
export type IdentityToolOutput = AuthIdentity;
