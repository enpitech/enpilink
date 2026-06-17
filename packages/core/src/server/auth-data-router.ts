import express, { type Router } from "express";
import { revokeTokenRef } from "./auth-revocation.js";
import { getActiveStorage } from "./log-sink.js";
import type { AuthSession, AuthUser, StorageAdapter } from "./storage/types.js";

/**
 * Auth data API (A5). Pure core — reads the SAME active {@link StorageAdapter}
 * the session-recording verifier writes to, via {@link getActiveStorage}. It
 * does NOT depend on `@enpilink/console`.
 *
 * Mounts at `/__enpilink/auth`. Follows the EXACT same dev-open / prod-admin
 * pattern as the config + observability routers: in DEV it is mounted
 * unauthenticated on localhost; in PROD it is behind the admin bearer guard (the
 * `/__enpilink/auth` prefix is added to `admin.ts`'s `DATA_API_PREFIXES`).
 *
 * Routes:
 * - `GET    /__enpilink/auth/sessions`      — recorded auth sessions (guests +
 *   authed), most recent first.
 * - `GET    /__enpilink/auth/users`         — tracked users, most recent first.
 * - `DELETE /__enpilink/auth/sessions/:id`  — revoke a session: delete the row
 *   and denylist its access token (true revocation, ≤ token TTL).
 * - `DELETE /__enpilink/auth/users/:sub`    — delete a user + all their
 *   sessions, denylisting each session's token.
 *
 * Disabled-safe: when there is no active storage (auth off, or storage absent)
 * every route returns a 200 with `{ enabled: false }` + empty data — NEVER a
 * 500. When storage exists but predates the A2/A5 methods, the same disabled
 * payload is returned (feature-detected), and revoke reports `unsupported`.
 *
 * SECURITY: NEVER returns a raw token or signing key. `tokenRef` is an opaque
 * one-way SHA-256 hash (safe to expose for correlation); it is NOT a credential.
 */
export function createAuthDataRouter(
  getStorage: () => StorageAdapter | null = getActiveStorage,
): Router {
  const router = express.Router();
  const base = "/__enpilink/auth";

  // GET /auth/sessions — list recorded sessions (guests + authed). Never 500.
  router.get(`${base}/sessions`, async (_req, res) => {
    const storage = getStorage();
    if (!storage?.listSessions) {
      res.json({ enabled: false, sessions: [] as AuthSession[] });
      return;
    }
    try {
      const sessions = await storage.listSessions({ limit: 500 });
      res.json({ enabled: true, sessions });
    } catch {
      res.json({ enabled: false, sessions: [] as AuthSession[] });
    }
  });

  // GET /auth/users — list tracked users. Never 500.
  router.get(`${base}/users`, async (_req, res) => {
    const storage = getStorage();
    if (!storage?.listUsers) {
      res.json({ enabled: false, users: [] as AuthUser[] });
      return;
    }
    try {
      const users = await storage.listUsers({ limit: 500 });
      res.json({ enabled: true, users });
    } catch {
      res.json({ enabled: false, users: [] as AuthUser[] });
    }
  });

  // DELETE /auth/sessions/:id — revoke a single session.
  router.delete(`${base}/sessions/:id`, async (req, res) => {
    const storage = getStorage();
    if (!storage?.getSession || !storage.deleteSession) {
      res.status(501).json({
        ok: false,
        error: "Active storage does not support session revocation",
      });
      return;
    }
    try {
      // Look the session up first so we can denylist its token reference.
      const session = await storage.getSession(req.params.id);
      await storage.deleteSession(req.params.id);
      if (session?.tokenRef) {
        // True revocation: the stateless access token would otherwise stay
        // valid until `exp`. Denylist its reference so the verifier rejects it.
        revokeTokenRef(session.tokenRef, session.expiresAt);
      }
      res.json({ ok: true, id: req.params.id, revoked: true });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to revoke session",
      });
    }
  });

  // DELETE /auth/users/:sub — delete a user + cascade-revoke their sessions.
  router.delete(`${base}/users/:sub`, async (req, res) => {
    const storage = getStorage();
    if (!storage?.deleteUser || !storage.listSessions) {
      res.status(501).json({
        ok: false,
        error: "Active storage does not support user deletion",
      });
      return;
    }
    try {
      // Denylist every session's token before the cascade delete drops them.
      const sessions = await storage.listSessions({ sub: req.params.sub });
      for (const s of sessions) {
        if (s.tokenRef) {
          revokeTokenRef(s.tokenRef, s.expiresAt);
        }
      }
      await storage.deleteUser(req.params.sub);
      res.json({ ok: true, sub: req.params.sub, revoked: sessions.length });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to delete user",
      });
    }
  });

  return router;
}
