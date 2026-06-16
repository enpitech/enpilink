import { create } from "zustand";

/**
 * Admin-token store (M6.5).
 *
 * In PROD admin mode the data APIs (`/__enpilink/observability/*`,
 * `/__enpilink/config*`) sit behind a bearer guard. The browser must present
 * `Authorization: Bearer <token>` on every data fetch and append `?token=` to
 * the SSE `EventSource` URL.
 *
 * Security hygiene:
 * - The token lives in **sessionStorage only** (cleared when the tab closes) —
 *   never localStorage, never a cookie.
 * - It is NEVER logged (no `console.*` of the token anywhere).
 * - It is only sent as the `Authorization` header (fetch) or the `?token=`
 *   query param for the SSE stream (EventSource can't set headers).
 *
 * In DEV the server doesn't 401, so the token stays empty and nothing changes —
 * the login screen only appears when a data API actually returns 401.
 */

const STORAGE_KEY = "enpilink.adminToken";

function readStoredToken(): string | null {
  try {
    const v = sessionStorage.getItem(STORAGE_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    // sessionStorage may be unavailable (e.g. SSR/strict sandbox) — treat as
    // "no token" rather than throwing.
    return null;
  }
}

function persistToken(token: string | null): void {
  try {
    if (token && token.length > 0) {
      sessionStorage.setItem(STORAGE_KEY, token);
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Best-effort only; the in-memory token still works for this session.
  }
}

type AdminTokenStore = {
  /** The current admin token, or `null` when not set. NEVER logged. */
  token: string | null;
  /**
   * Whether a data API has returned 401 this session (so the UI knows the
   * server is enforcing auth and should show the login screen).
   */
  authRequired: boolean;
  /** Store a token (persists to sessionStorage) and clear the auth-required flag. */
  setToken: (token: string) => void;
  /** Clear the token (sign out) and persisted copy. */
  clearToken: () => void;
  /** Mark that the server is enforcing auth (a data API returned 401). */
  markAuthRequired: () => void;
};

export const useAdminTokenStore = create<AdminTokenStore>()((set) => ({
  token: readStoredToken(),
  authRequired: false,
  setToken: (token) => {
    persistToken(token);
    set({ token, authRequired: false });
  },
  clearToken: () => {
    persistToken(null);
    set({ token: null });
  },
  markAuthRequired: () => set({ authRequired: true }),
}));

/**
 * Non-reactive read of the current admin token (for use inside fetch wrappers /
 * query functions that aren't React components). Reads the live zustand state.
 */
export function getAdminToken(): string | null {
  return useAdminTokenStore.getState().token;
}

/**
 * Build request headers for a data-API fetch, attaching the bearer token when
 * one is set. Returns a plain object you can spread into `fetch` options.
 */
export function authHeaders(
  base: Record<string, string> = {},
): Record<string, string> {
  const token = getAdminToken();
  if (token) {
    return { ...base, Authorization: `Bearer ${token}` };
  }
  return { ...base };
}

/**
 * Wrapper around `fetch` for data-API calls. Attaches the bearer header and, on
 * a 401, records that auth is required (so the app can show the login screen)
 * before returning the response to the caller.
 */
export async function authedFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = authHeaders(
    (init.headers as Record<string, string> | undefined) ?? {},
  );
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    useAdminTokenStore.getState().markAuthRequired();
  }
  return res;
}

/**
 * Append the admin token to a SSE URL as `?token=` when set (EventSource cannot
 * send an Authorization header). No-op when there is no token (dev).
 */
export function withStreamToken(url: string): string {
  const token = getAdminToken();
  if (!token) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}
