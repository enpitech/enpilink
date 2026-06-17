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
 * identical and the auth wrapping lives in one place. The console static UI is
 * imported through a non-literal specifier so core type-checks WITHOUT
 * `@enpilink/console` being built first (the core↔console workspace cycle).
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

/** Path prefixes for the admin DATA APIs (guarded). The shell is everything else. */
const DATA_API_PREFIXES = [
  "/__enpilink/observability",
  "/__enpilink/config",
  "/__enpilink/auth",
] as const;

/** The observability SSE stream route — the one endpoint that needs `?token=`. */
const STREAM_PATH = "/__enpilink/observability/stream";

/** Whether `path` belongs to a guarded data API. */
function isDataApiPath(path: string): boolean {
  return DATA_API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * Remove the `token` query param from a URL (path + querystring), leaving the
 * rest intact. Used to scrub the SSE bearer from `req.url`/`req.originalUrl`
 * after promoting it to the Authorization header, so it never reaches logs or
 * the route handler.
 */
function stripTokenParam(url: string): string {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) {
    return url;
  }
  const pathPart = url.slice(0, qIdx);
  const params = new URLSearchParams(url.slice(qIdx + 1));
  params.delete("token");
  const rest = params.toString();
  return rest.length > 0 ? `${pathPart}?${rest}` : pathPart;
}

/**
 * Build the bearer-auth middleware that guards the admin **data APIs** in prod
 * (`/__enpilink/observability/*` + `/__enpilink/config*`).
 *
 * M6.5: this guard is mounted at the app root but enforces auth ONLY on the
 * data-API paths — the devtools static SPA shell (and everything else,
 * including `/mcp`) passes straight through unauthenticated, so a browser can
 * always load the app and render its own token-login screen. The app then
 * authenticates its own fetch/SSE calls; no data leaks without the token.
 *
 * **SSE auth (`?token=`):** browsers' `EventSource` cannot set an
 * `Authorization` header, so for the observability `/stream` route ONLY we also
 * accept the bearer via a `?token=` query param. We copy it into the
 * `Authorization` header (so the SAME constant-time verifier enforces it — no
 * separate compare path) and then delete the query param so it never reaches
 * the route handler, logs, or any persisted request line. The header path stays
 * the primary mechanism for every other route.
 */
export function adminAuthMiddleware(token: string): RequestHandler {
  const required = requireBearerAuth({ verifier: adminTokenVerifier(token) });
  return (req, res, next) => {
    // `req.path` is the full path (guard mounted at root). Only the data APIs
    // are guarded; the SPA shell, static assets, and `/mcp` pass through.
    if (!isDataApiPath(req.path)) {
      next();
      return;
    }

    // SSE-only: promote `?token=` to the Authorization header so EventSource
    // can authenticate, then strip it from the URL so the secret never lands in
    // the request log line, `req.query`, or the route handler. Only here, only
    // where the header path is also enforced (prod admin).
    if (req.path === STREAM_PATH && !req.headers.authorization) {
      const queryToken = req.query.token;
      if (typeof queryToken === "string" && queryToken.length > 0) {
        req.headers.authorization = `Bearer ${queryToken}`;
      }
      // Rewrite req.url / req.originalUrl to drop the `token` param. Express's
      // `req.query` is derived from `req.url`, so this removes it everywhere
      // (query object + any downstream logging of the URL).
      req.url = stripTokenParam(req.url);
      if (typeof req.originalUrl === "string") {
        req.originalUrl = stripTokenParam(req.originalUrl);
      }
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
const DEVTOOLS_SPECIFIER = "@enpilink/console";

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
 * **Shell vs data auth (M6.5).** The plane has two halves:
 *
 * 1. The **devtools static SPA shell** (HTML/JS/CSS — non-sensitive app code).
 *    Served WITHOUT auth so an unauthenticated browser can always load the app
 *    and render its own token-login screen.
 * 2. The **data APIs** (`/__enpilink/observability/*` + `/__enpilink/config*`),
 *    which expose real analytics/config data. In prod these are guarded by
 *    `opts.auth` (a single bearer token); the guard is applied ONLY in front of
 *    these two routers, never the shell.
 *
 * In DEV (`auth` omitted) nothing is guarded — today's localhost behavior. The
 * net result in prod: a browser with no token gets the app shell + a login
 * screen, but no data leaks until the token is presented.
 */
export async function mountAdmin(
  app: Express,
  opts: { auth?: RequestHandler } = {},
): Promise<void> {
  const { createObservabilityRouter } = await import("./observability.js");
  const { createConfigRouter } = await import("./config/index.js");
  const { createAuthDataRouter } = await import("./auth-data-router.js");

  const staticUi = await loadDevtoolsStaticServer();
  const observability = createObservabilityRouter();
  const config = createConfigRouter();
  const authData = createAuthDataRouter();

  // 1) Static SPA shell — ALWAYS unauthenticated so the browser can load the
  //    app and show the login screen. It serves only non-sensitive app assets.
  app.use(staticUi);

  // 2) Data-API guard (prod only). Mounted at root, but `adminAuthMiddleware`
  //    enforces auth ONLY on the `/__enpilink/observability|config` paths — the
  //    shell above and `/mcp` pass through. It also accepts the SSE `?token=`
  //    query param for the stream route. In dev (`opts.auth` omitted) there is
  //    no guard at all.
  if (opts.auth) {
    app.use(opts.auth);
  }
  app.use(observability);
  app.use(config);
  app.use(authData);
}
