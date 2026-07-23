import type http from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import {
  AdminTokenMissingError,
  adminAuthMiddleware,
  adminEnabled,
  ensureAdminStorage,
  mountAdmin,
  readAdminToken,
} from "./admin.js";
import { refreshAgentCaptureGate } from "./agent/capture-gate.js";
import { bootstrapRulesetClient } from "./agent/ruleset/bootstrap.js";
import {
  InsufficientScopeError,
  InvalidTokenError,
  optionalBearerAuth,
} from "./auth.js";
import { AuthRequiredError, enforceSecuritySchemes } from "./auth-enforce.js";
import type { AuthRuntime } from "./auth-runtime.js";
import { serverLog } from "./log-sink.js";
import type { McpServer } from "./server.js";

function parseControlPort(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n >= 65536) {
    return null;
  }
  return n;
}

function applyMiddlewares(
  app: express.Express,
  middlewares: Array<{
    path?: string;
    handlers: express.ErrorRequestHandler[];
  }>,
): void {
  for (const middleware of middlewares) {
    if (middleware.path) {
      app.use(middleware.path, ...middleware.handlers);
    } else {
      app.use(...middleware.handlers);
    }
  }
}

function defaultErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) {
  serverLog("error", "Error handling MCP request", {
    error: err instanceof Error ? err.message : String(err),
  });
  if (!res.headersSent) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
  }
}

export async function createApp({
  mcpServer,
  httpServer,
  errorMiddleware = [],
}: {
  mcpServer: McpServer;
  httpServer: http.Server;
  errorMiddleware?: {
    path?: string;
    handlers: express.ErrorRequestHandler[];
  }[];
}): Promise<express.Express> {
  const app = mcpServer.express;

  // The agent capture middleware is installed in the McpServer constructor (so
  // it precedes any user route). Here — after `applyMcpMiddleware` has activated
  // storage — resolve its live gate from env/file/db, then bootstrap the cached
  // ruleset client (D2) off that resolved config. Fire-and-forget + ordered: the
  // gate stays OFF (and the client dormant) until this resolves, preserving
  // off-by-default. The client warms from disk + kicks a BACKGROUND fetch only
  // when the agent surface is on; a request is never delayed by it.
  void (async () => {
    await refreshAgentCaptureGate();
    bootstrapRulesetClient();
  })();

  // Read `process.env.NODE_ENV` inline: wrangler/esbuild only substitute the literal expression,
  // so a local const would defeat dead-code elimination of the dev-only imports below.
  if (process.env.NODE_ENV !== "production") {
    // Dev-only. The admin plane (devtools UI + observability + config API) is
    // mounted UNAUTHENTICATED on localhost — today's dev behavior. The mounts
    // live in `mountAdmin`, which holds @enpilink/console behind a non-literal
    // specifier so core type-checks WITHOUT the console being built first (the
    // core↔console workspace cycle; a clean checkout has no console `dist`).
    // This whole block is dead-code-eliminated in production by the literal
    // `process.env.NODE_ENV` guard above (esbuild/wrangler substitution).
    await mountAdmin(app);

    const { viewsDevServer } = await import("./viewsDevServer.js");
    app.use(await viewsDevServer(httpServer));

    const controlPort = parseControlPort(process.env.__TUNNEL_CONTROL_PORT);
    if (controlPort !== null) {
      const { createTunnelProxyRouter } = await import(
        "./tunnel-proxy-router.js"
      );
      app.use(createTunnelProxyRouter(controlPort));
    } else if (process.env.__TUNNEL_CONTROL_PORT !== undefined) {
      console.warn(
        `Ignoring invalid __TUNNEL_CONTROL_PORT=${process.env.__TUNNEL_CONTROL_PORT}`,
      );
    }
  } else {
    const assetsPath = path.join(process.cwd(), "dist", "assets");

    app.use("/assets", cors());
    app.use("/assets", express.static(assetsPath));

    // Prod admin plane (M5). OFF by default; opt-in via `--admin` /
    // `ENPILINK_ADMIN=1`. When enabled, REFUSE to start without a token (never
    // default-open). The same mounts as dev, but wrapped in `requireBearerAuth`
    // using the in-process `ENPILINK_ADMIN_TOKEN` (read raw, never the masked
    // config API). A storage adapter is initialized independent of analytics so
    // the config + observability routers have a backing store to read/write.
    if (adminEnabled()) {
      const token = await readAdminToken();
      if (!token) {
        throw new AdminTokenMissingError();
      }
      const adminStorage = await ensureAdminStorage();
      if (adminStorage) {
        mcpServer.adoptStorage(adminStorage);
      }
      await mountAdmin(app, { auth: adminAuthMiddleware(token) });
      serverLog(
        "info",
        "[enpilink] admin plane enabled at /__enpilink/* (behind bearer auth)",
      );
    }
  }

  // End-user auth (A1). OFF by default — `getAuthRuntime()` returns null and
  // `/mcp` stays open exactly as before. When enabled, serve RFC 9728 Protected
  // Resource Metadata at `/.well-known/oauth-protected-resource` and install a
  // bearer-auth guard in front of `/mcp` (lazy/optional so `noauth` tools still
  // run tokenless; each tool's `securitySchemes` are then enforced per-call).
  const authRuntime = await mcpServer.getAuthRuntime();
  if (authRuntime) {
    // Co-hosted Authorization Server (A2): branded login + `/authorize` /
    // `/token` / `/.well-known/oauth-authorization-server` / `/register`.
    // Mounted at the app root, before the `/mcp` guard. `null` in A1-only mode.
    if (authRuntime.authServerRouter) {
      app.use(authRuntime.authServerRouter);
    }
    // RFC 9728 Protected Resource Metadata + AS metadata (also served by the
    // AS router; the PRM router additionally covers the A1-only mode).
    app.use(authRuntime.metadataRouter);
    app.use(
      "/mcp",
      optionalBearerAuth({
        verifier: authRuntime.verifier,
        resourceMetadataUrl: authRuntime.resourceMetadataUrl,
      }),
    );
  }

  app.use("/mcp", mcpMiddleware(mcpServer, authRuntime));

  // Agent representation router (M3/M3.5) — installed HERE, as a TRAILING
  // 404-rescue fallback, after every user route and the `/mcp` mount. It runs
  // only when nothing matched (a would-be-404): an eligible AI chat fetcher is
  // then served the self-sufficient representation and the dead-end is recorded
  // honestly; a real 2xx route already responded and passes through untouched;
  // crawlers/humans always get the real 404. OFF by default (`agent.serve`).
  mcpServer.installAgentRoutingFallback();

  applyMiddlewares(app, errorMiddleware);

  app.use("/mcp", defaultErrorHandler);

  return app;
}

/**
 * Build a `WWW-Authenticate: Bearer` header value, optionally carrying the
 * `resource_metadata` URL (per RFC 9728) and a required `scope` list (for
 * 403 insufficient_scope step-up challenges).
 */
function wwwAuthenticate(
  errorCode: string,
  message: string,
  resourceMetadataUrl?: string,
  scope?: string[],
): string {
  let header = `Bearer error="${errorCode}", error_description="${message}"`;
  if (scope && scope.length > 0) {
    header += `, scope="${scope.join(" ")}"`;
  }
  if (resourceMetadataUrl) {
    header += `, resource_metadata="${resourceMetadataUrl}"`;
  }
  return header;
}

/**
 * Enforce a `tools/call`'s `securitySchemes` at the HTTP layer, before the call
 * reaches the transport, so we can return a proper RFC-shaped 401/403 with a
 * `WWW-Authenticate` header. Returns `true` when it has already responded (the
 * caller must stop); `false` to continue.
 *
 * Errors are mapped to HTTP status:
 * - missing/required token → 401 + `WWW-Authenticate: Bearer ... resource_metadata=`
 * - insufficient scope → 403 + `WWW-Authenticate: Bearer ... scope=`
 *
 * Any UNEXPECTED error is swallowed (logged) and the call is allowed to proceed
 * to the handler rather than 500ing the transport — a verifier/enforcement bug
 * must never break a tool call beyond the intended 401/403.
 */
function enforceToolAuth(
  req: express.Request,
  res: express.Response,
  server: McpServer,
  authRuntime: AuthRuntime,
): boolean {
  try {
    const body = req.body as
      | { method?: unknown; params?: { name?: unknown } }
      | undefined;
    if (body?.method !== "tools/call") {
      return false;
    }
    const toolName =
      typeof body.params?.name === "string" ? body.params.name : undefined;
    if (!toolName) {
      return false;
    }
    const schemes = server.getToolSecuritySchemes(toolName);
    enforceSecuritySchemes(schemes, req.auth);
    return false;
  } catch (err) {
    if (err instanceof AuthRequiredError || err instanceof InvalidTokenError) {
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          wwwAuthenticate(
            "invalid_token",
            err.message,
            authRuntime.resourceMetadataUrl,
          ),
        )
        .json({
          jsonrpc: "2.0",
          error: { code: -32001, message: err.message },
          id: null,
        });
      return true;
    }
    if (err instanceof InsufficientScopeError) {
      // Recompute the declared scopes for the challenge's `scope=`.
      const body = req.body as { params?: { name?: unknown } };
      const toolName =
        typeof body?.params?.name === "string" ? body.params.name : undefined;
      const scopes = collectOauth2Scopes(
        toolName ? server.getToolSecuritySchemes(toolName) : undefined,
      );
      res
        .status(403)
        .set(
          "WWW-Authenticate",
          wwwAuthenticate(
            "insufficient_scope",
            err.message,
            authRuntime.resourceMetadataUrl,
            scopes,
          ),
        )
        .json({
          jsonrpc: "2.0",
          error: { code: -32002, message: err.message },
          id: null,
        });
      return true;
    }
    // Unexpected — never break the tool call beyond the intended 401/403.
    serverLog("error", "Unexpected error during tool auth enforcement", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Union of scopes declared by a tool's `oauth2` security schemes. */
function collectOauth2Scopes(
  schemes:
    | Array<{ type: string; scopes?: string[] }>
    | undefined
    | readonly { type: string; scopes?: string[] }[],
): string[] {
  if (!schemes) {
    return [];
  }
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

const mcpMiddleware = (
  server: McpServer,
  authRuntime: AuthRuntime | null,
): express.RequestHandler => {
  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.method !== "POST") {
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed.",
          },
          id: null,
        }),
      );
      return;
    }

    // Per-tool `securitySchemes` enforcement (A1). Only when auth is enabled;
    // `noauth` tools still run tokenless. Returns true once it has responded.
    if (authRuntime && enforceToolAuth(req, res, server, authRuntime)) {
      return;
    }

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // Respond with a single JSON body instead of SSE. enpilink's stateless
        // transport never streams server-initiated messages, so SSE adds no
        // capability — and on workerd specifically, `cloudflare:node`'s http
        // bridge silently drops chunked writes that happen after the request
        // handler awaits, which manifests as a 200 with empty body for any
        // async tools/call.
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
      });

      await server.connectStatelessTransport(transport);
      // Express strips the mount path from req.url (e.g. "/mcp" becomes "/").
      // Restore it so the SDK builds the correct requestInfo.url.
      req.url = req.originalUrl;
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    }
  };
};
