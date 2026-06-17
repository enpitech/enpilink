import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { authedFetch } from "./admin-token-store.js";

/**
 * Auth data client (A5): TanStack Query hooks for the auth read/revoke API
 * (`/__enpilink/auth/*`). The Auth tab's sessions/users dashboard consumes
 * these.
 *
 * Fetched relative to `window.location.origin`. When end-user auth is OFF (or
 * storage is absent) the API returns `{ enabled: false }` payloads (never
 * errors) and the UI shows a friendly "auth is off" hint instead of breaking.
 *
 * SECURITY: the API never returns a raw token or signing key. `tokenRef` is an
 * opaque one-way hash (safe to display for correlation), NOT a credential.
 */

const BASE = "/__enpilink/auth";

// --- Schemas (tolerant: unknown fields ignored so the API may evolve) ---

const authSessionSchema = z.object({
  id: z.string(),
  sub: z.string(),
  issuer: z.string().optional(),
  clientId: z.string().optional(),
  tokenRef: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  expiresAt: z.number().optional(),
  isGuest: z.boolean().optional(),
});

export type AuthSession = z.infer<typeof authSessionSchema>;

const authUserSchema = z.object({
  sub: z.string(),
  issuer: z.string().optional(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  email: z.string().optional(),
  name: z.string().optional(),
  isGuest: z.boolean().optional(),
});

export type AuthUser = z.infer<typeof authUserSchema>;

const sessionsResponseSchema = z.object({
  enabled: z.boolean(),
  sessions: z.array(authSessionSchema),
});

const usersResponseSchema = z.object({
  enabled: z.boolean(),
  users: z.array(authUserSchema),
});

/** Sessions + whether end-user auth/storage is enabled. */
export interface AuthSessions {
  enabled: boolean;
  sessions: AuthSession[];
}

/** Users + whether end-user auth/storage is enabled. */
export interface AuthUsers {
  enabled: boolean;
  users: AuthUser[];
}

/** Recorded auth sessions (guests + authed), most recent first. */
export function useAuthSessions() {
  return useQuery({
    queryKey: ["auth", "sessions"],
    queryFn: async (): Promise<AuthSessions> => {
      const res = await authedFetch(`${BASE}/sessions`);
      if (!res.ok) {
        throw new Error(`auth sessions failed (${res.status})`);
      }
      return sessionsResponseSchema.parse(await res.json());
    },
    refetchInterval: 5000,
  });
}

/** Tracked users, most recently seen first. */
export function useAuthUsers() {
  return useQuery({
    queryKey: ["auth", "users"],
    queryFn: async (): Promise<AuthUsers> => {
      const res = await authedFetch(`${BASE}/users`);
      if (!res.ok) {
        throw new Error(`auth users failed (${res.status})`);
      }
      return usersResponseSchema.parse(await res.json());
    },
    refetchInterval: 5000,
  });
}

/** Revoke a session by id (deletes the row + denylists its token). */
export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const res = await authedFetch(
        `${BASE}/sessions/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(json?.error ?? `revoke failed (${res.status})`);
      }
      return json;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["auth"] });
    },
  });
}

/** Delete a user + cascade-revoke all their sessions. */
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sub }: { sub: string }) => {
      const res = await authedFetch(
        `${BASE}/users/${encodeURIComponent(sub)}`,
        { method: "DELETE" },
      );
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(json?.error ?? `delete failed (${res.status})`);
      }
      return json;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["auth"] });
    },
  });
}
