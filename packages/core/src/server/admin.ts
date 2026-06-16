import crypto from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Express, RequestHandler } from "express";
import { InvalidTokenError, requireBearerAuth } from "./auth.js";
import { resolveConfig } from "./config/index.js";
import { getActiveStorage, setActiveStorage } from "./log-sink.js";
import { resolveStorageAdapter } from "./storage/index.js";
import type { StorageAdapter } from "./storage/types.js";

/**
 * Admin / control-plane mounting (M5).
 *
 * The admin plane is the devtools static UI + the observability read API + the
 * config admin API. In DEV (`NODE_ENV !== "production"`) these are mounted
 * unauthenticated on localhost (today's behavior). In PROD they are OFF by
 * default and opt-in via `--admin` / `ENPILINK_ADMIN=1`, guarded by
 * `requireBearerAuth` using `ENPILINK_ADMIN_TOKEN`.
 *
 * This module centralizes BOTH the dev and prod mounts so the route surface is
 * identical and the auth wrapping lives in one place. The devtools static UI is
 * imported through a non-literal specifier so core type-checks WITHOUT
 * `@enpilink/devtools` being built first (the core↔devtools workspace cycle).
 */

/** Truthy env values that enable the admin plane. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Whether the prod admin plane is enabled. OFF by default; enable with
 * `ENPILINK_ADMIN=1` (also accepts `true`/`yes`/`on`, case-insensitive) — or via
 * the `enpilink start --admin` flag, which sets the same env var.
 */
export function adminEnabled(): boolean {
  const raw = process.env.ENPILINK_ADMIN;
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * The raw admin bearer token, read in-process from the env (NOT the masked
 * config API). Empty / unset → `undefined`. Read via `resolveConfig(null)`'s
 * raw `values.adminAuthToken` so the single source of truth is the config
 * schema's env mapping. Never logged, never returned by any HTTP route.
 */
export async function readAdminToken(): Promise<string | undefined> {
  const { values } = await resolveConfig(null);
  const token = values.adminAuthToken;
  if (typeof token !== "string") {
    return undefined;
  }
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Error thrown when admin is enabled in prod but no token is configured. The
 * prod entry should let this propagate so the process exits non-zero with a
 * clear message — never default-open.
 */
export class AdminTokenMissingError extends Error {
  constructor() {
    super(
      "Admin mode is enabled (ENPILINK_ADMIN) but no admin token is set. " +
        "Set ENPILINK_ADMIN_TOKEN to a non-empty secret, or disable admin. " +
        "Refusing to start an unauthenticated admin plane.",
    );
    this.name = "AdminTokenMissingError";
  }
}

/**
 * A minimal OAuth-token verifier that accepts exactly one static bearer token
 * (the configured admin token) and rejects everything else. On match it returns
 * a synthetic {@link AuthInfo} with a far-future expiry so `requireBearerAuth`
 * is satisfied; on mismatch it throws {@link InvalidTokenError} → 401.
 *
 * The comparison is constant-time to avoid leaking the token via timing.
 */
function adminTokenVerifier(token: string): {
  verifyAccessToken: (presented: string) => Promise<AuthInfo>;
} {
  const expected = Buffer.from(token);
  return {
    async verifyAccessToken(presented: string): Promise<AuthInfo> {
      const got = Buffer.from(presented);
      const ok =
        got.length === expected.length && crypto.timingSafeEqual(got, expected);
      if (!ok) {
        throw new InvalidTokenError("Invalid admin token");
      }
      return {
        token: "admin",
        clientId: "enpilink-admin",
        scopes: [],
        // Far-future expiry (epoch seconds): the token is a static shared
        // secret, not an OAuth access token, so it does not expire on its own.
        expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
      };
    },
  };
}

/**
 * Build the bearer-auth middleware that guards the admin plane in prod.
 *
 * The admin mounts are registered at the app root (the devtools SPA serves `/`),
 * so the guard must NOT intercept the public `/mcp` endpoint — it stays
 * unauthenticated regardless of admin. The returned middleware therefore passes
 * `/mcp` (and its subpaths) straight through; everything else requires the
 * bearer token.
 */
export function adminAuthMiddleware(token: string): RequestHandler {
  const required = requireBearerAuth({ verifier: adminTokenVerifier(token) });
  return (req, res, next) => {
    // `req.path` is relative to the mount; since these are mounted at root it is
    // the full path. Never guard `/mcp` — it's the public MCP transport.
    if (req.path === "/mcp" || req.path.startsWith("/mcp/")) {
      next();
      return;
    }
    return required(req, res, next);
  };
}

/**
 * Ensure there is an active {@link StorageAdapter} backing the admin plane, even
 * when analytics RECORDING is off (`ENPILINK_ANALYTICS` unset). Analytics gates
 * whether events are *recorded*; the admin still needs a store to READ/write
 * config + observability data.
 *
 * If analytics already installed a store ({@link getActiveStorage}), reuse it.
 * Otherwise resolve a fresh adapter (prod default = sqlite via
 * `resolveStorageAdapter()` / `ENPILINK_DB_PATH`), `init()` it, register it as
 * the active store, and return it so the caller can close it on shutdown.
 *
 * @returns the storage adapter the caller now OWNS (must close on shutdown), or
 * `null` when an existing analytics store was reused (the server already owns
 * that one) or when initialization failed.
 */
export async function ensureAdminStorage(): Promise<StorageAdapter | null> {
  const existing = getActiveStorage();
  if (existing) {
    // Analytics already set up a store; reuse it. The server owns its lifecycle.
    return null;
  }
  let storage: StorageAdapter;
  try {
    storage = resolveStorageAdapter();
    await storage.init();
  } catch (err) {
    console.error(
      "[enpilink] admin storage init failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  setActiveStorage(storage);
  return storage;
}

/** The non-literal specifier keeps the core↔devtools clean-build cycle intact. */
const DEVTOOLS_SPECIFIER = "@enpilink/devtools";

async function loadDevtoolsStaticServer(): Promise<RequestHandler> {
  const { devtoolsStaticServer } = (await import(DEVTOOLS_SPECIFIER)) as {
    devtoolsStaticServer: () => Promise<RequestHandler>;
  };
  return devtoolsStaticServer();
}

/**
 * Mount the admin plane (devtools static UI + observability API + config API)
 * onto `app`.
 *
 * - `auth`: when provided, every admin handler is guarded by this middleware
 *   (prod). When omitted, the handlers are mounted unauthenticated (dev on
 *   localhost — today's behavior).
 * - `includeStaticUi`: mount the devtools static UI. Always true; the dev path
 *   also mounts the views dev server separately (handled by the caller).
 *
 * The three mounts share the `/__enpilink/` route prefix (observability +
 * config) plus the devtools static UI; the auth guard, when present, is applied
 * uniformly so a single bearer token protects all of them.
 */
export async function mountAdmin(
  app: Express,
  opts: { auth?: RequestHandler } = {},
): Promise<void> {
  const { createObservabilityRouter } = await import("./observability.js");
  const { createConfigRouter } = await import("./config/index.js");

  const staticUi = await loadDevtoolsStaticServer();
  const observability = createObservabilityRouter();
  const config = createConfigRouter();

  // Apply the auth guard ONCE in front of all three mounts (prod). In dev
  // there is no guard. The guard itself lets `/mcp` through (see
  // `adminAuthMiddleware`) so the public MCP transport stays unauthenticated.
  if (opts.auth) {
    app.use(opts.auth);
  }
  app.use(staticUi);
  app.use(observability);
  app.use(config);
}
