import { useCallback, useEffect, useRef, useState } from "react";
import { getAdaptor } from "../bridges/index.js";

/**
 * Name of the built-in identity tool the framework auto-registers on the server
 * when end-user auth is enabled (A4). Mirrors `IDENTITY_TOOL_NAME` in
 * `server/auth-identity.ts` — kept inline so the web bundle never pulls in the
 * server runtime. If you change it on the server, change it here too.
 */
const IDENTITY_TOOL_NAME = "enpilink_whoami";

/**
 * The three identity states a view can observe:
 * - `anonymous` — no token at all (or auth is off / the identity tool is
 *   absent — the hook degrades to this without throwing).
 * - `guest` — the user continued as a guest (a minted guest token).
 * - `authed` — a real, upstream-backed signed-in user.
 */
export type AuthState = "anonymous" | "guest" | "authed";

/**
 * Identity surfaced to the view by {@link useAuth}. Carries ONLY identity and
 * claims — NEVER a token. The view learns this via a `noauth` tool round-trip;
 * the host passes no identity into the iframe directly.
 */
export interface AuthInfo {
  /** Whether the caller is anonymous, a guest, or a signed-in user. */
  state: AuthState;
  /** Stable per-user id, or `undefined` when anonymous. */
  sub?: string;
  /** Convenience flag, true when `state === "guest"`. */
  isGuest: boolean;
  /** Granted scopes (empty when anonymous). */
  scopes: string[];
  /** The user's email, when the upstream login supplied it. */
  email?: string;
  /** The user's display name, when supplied. */
  name?: string;
  /** True while the identity round-trip is in flight (initial load + refresh). */
  isLoading: boolean;
  /** Re-run the identity round-trip (e.g. after a step-up login). */
  refresh: () => void;
}

const ANONYMOUS: Omit<AuthInfo, "isLoading" | "refresh"> = {
  state: "anonymous",
  isGuest: false,
  scopes: [],
};

type Identity = Omit<AuthInfo, "isLoading" | "refresh">;

function normalizeIdentity(raw: unknown): Identity {
  if (!raw || typeof raw !== "object") {
    return ANONYMOUS;
  }
  const r = raw as Record<string, unknown>;
  const state: AuthState =
    r.state === "guest" || r.state === "authed" ? r.state : "anonymous";
  return {
    state,
    sub: typeof r.sub === "string" ? r.sub : undefined,
    isGuest: r.isGuest === true || state === "guest",
    scopes: Array.isArray(r.scopes)
      ? r.scopes.filter((s): s is string => typeof s === "string")
      : [],
    email: typeof r.email === "string" ? r.email : undefined,
    name: typeof r.name === "string" ? r.name : undefined,
  };
}

/**
 * Read the signed-in user's identity inside a view, modelling the three auth
 * states explicitly (`anonymous` / `guest` / `authed`).
 *
 * The host renders views in an identity-blind iframe — it passes NO user
 * identity in. So this hook learns "who am I" via a **tool round-trip**: it
 * calls the framework's built-in `enpilink_whoami` `noauth` tool, which reads
 * the request's `extra.authInfo` on the server and returns the caller's
 * identity (never a token). Works under BOTH the Apps SDK and MCP Apps runtimes
 * because the call goes through the shared adaptor's `callTool`.
 *
 * Degrades gracefully: when auth is disabled (the identity tool isn't
 * registered) or the round-trip fails, it resolves to `anonymous` and never
 * throws.
 *
 * To trigger a login from a view, call an `oauth2`-scoped tool (e.g. via
 * `useCallTool`): the resulting 401/403 challenge makes the HOST open the OAuth
 * flow out-of-band. After the user signs in, call {@link AuthInfo.refresh} to
 * re-read the identity. See {@link useRequireAuth} for a small helper.
 *
 * @example
 * ```tsx
 * const { state, name, isLoading, refresh } = useAuth();
 * if (isLoading) return <Spinner />;
 * if (state === "authed") return <p>Hi {name}</p>;
 * if (state === "guest") return <p>Browsing as guest</p>;
 * return <SignInButton onSignedIn={refresh} />;
 * ```
 *
 * @see https://docs.enpitech.dev/api-reference/use-auth
 */
export function useAuth(): AuthInfo {
  const [identity, setIdentity] = useState<Identity>(ANONYMOUS);
  const [isLoading, setIsLoading] = useState(true);
  const callIdRef = useRef(0);

  const refresh = useCallback(() => {
    const callId = ++callIdRef.current;
    setIsLoading(true);
    void (async () => {
      try {
        const res = await getAdaptor().callTool(IDENTITY_TOOL_NAME, null);
        if (callId !== callIdRef.current) {
          return;
        }
        setIdentity(normalizeIdentity(res.structuredContent));
      } catch {
        // Auth off / tool absent / call failed → treat as anonymous, never throw.
        if (callId !== callIdRef.current) {
          return;
        }
        setIdentity(ANONYMOUS);
      } finally {
        if (callId === callIdRef.current) {
          setIsLoading(false);
        }
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...identity, isLoading, refresh };
}

/**
 * Helper to initiate a step-up login from a view. Calling the returned
 * `requireAuth()` invokes a designated `oauth2`-scoped tool; the 401/403
 * challenge prompts the HOST to open its OAuth flow (the branded login page
 * opens out-of-band — a view cannot force it open from inside the iframe, it
 * can only trigger the challenge). On success the call resolves normally.
 *
 * Be honest with users: there is nothing more a view can do than trigger the
 * challenge — the host owns when/whether the login window opens.
 *
 * @param toolName an `oauth2`-scoped tool to call as the login trigger.
 * @example
 * ```tsx
 * const requireAuth = useRequireAuth("save_favorite");
 * <button onClick={() => requireAuth().then(refresh)}>Sign in to save</button>
 * ```
 */
export function useRequireAuth(
  toolName: string,
): (args?: Record<string, unknown> | null) => Promise<void> {
  return useCallback(
    async (args: Record<string, unknown> | null = null) => {
      await getAdaptor().callTool(toolName, args);
    },
    [toolName],
  );
}
