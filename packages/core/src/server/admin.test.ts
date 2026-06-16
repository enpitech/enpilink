import http from "node:http";
import type { RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminTokenMissingError,
  adminAuthMiddleware,
  adminEnabled,
  readAdminToken,
} from "./admin.js";
import { mockEnabled } from "./analytics.js";
import { setActiveStorage } from "./log-sink.js";
import { McpServer } from "./server.js";

// The admin static UI imports @enpilink/devtools via a non-literal specifier;
// stub it so these tests don't require the devtools dist (clean-build cycle).
vi.mock("@enpilink/devtools", () => ({
  devtoolsStaticServer: () =>
    ((_req: unknown, _res: unknown, next: () => void) =>
      next()) as RequestHandler,
}));
vi.mock("./viewsDevServer.js", () => ({
  viewsDevServer: (_httpServer: unknown) =>
    ((_req: unknown, _res: unknown, next: () => void) =>
      next()) as RequestHandler,
}));

async function listen(app: Parameters<typeof http.createServer>[1]) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return { port, server };
}

let openServer: http.Server | undefined;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Ensure no leftover active storage from another test influences these.
  setActiveStorage(null);
});

afterEach(() => {
  openServer?.close();
  openServer = undefined;
  setActiveStorage(null);
  process.env = { ...ORIGINAL_ENV };
});

const OBS = "/__enpilink/observability/summary";

describe("adminEnabled", () => {
  it("is off by default and on for truthy env values", () => {
    process.env.ENPILINK_ADMIN = undefined;
    delete process.env.ENPILINK_ADMIN;
    expect(adminEnabled()).toBe(false);
    for (const v of ["1", "true", "YES", "On"]) {
      process.env.ENPILINK_ADMIN = v;
      expect(adminEnabled()).toBe(true);
    }
    process.env.ENPILINK_ADMIN = "0";
    expect(adminEnabled()).toBe(false);
  });
});

describe("readAdminToken", () => {
  it("reads the raw token from env, trims, and treats empty as unset", async () => {
    delete process.env.ENPILINK_ADMIN_TOKEN;
    expect(await readAdminToken()).toBeUndefined();
    process.env.ENPILINK_ADMIN_TOKEN = "   ";
    expect(await readAdminToken()).toBeUndefined();
    process.env.ENPILINK_ADMIN_TOKEN = "s3cret";
    expect(await readAdminToken()).toBe("s3cret");
  });
});

describe("mockEnabled is dev-only", () => {
  it("ignores ENPILINK_MOCK in production", () => {
    process.env.ENPILINK_MOCK = "1";
    process.env.NODE_ENV = "production";
    expect(mockEnabled()).toBe(false);
    process.env.NODE_ENV = "development";
    expect(mockEnabled()).toBe(true);
  });
});

describe("adminAuthMiddleware", () => {
  it("401s without a token and passes with the valid bearer token", async () => {
    const app = (await import("express")).default();
    app.use(adminAuthMiddleware("topsecret"));
    app.get("/probe", (_req, res) => res.json({ ok: true }));
    const { port, server } = await listen(app);
    openServer = server;

    const noAuth = await fetch(`http://localhost:${port}/probe`);
    expect(noAuth.status).toBe(401);

    const badAuth = await fetch(`http://localhost:${port}/probe`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(badAuth.status).toBe(401);

    const ok = await fetch(`http://localhost:${port}/probe`, {
      headers: { Authorization: "Bearer topsecret" },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });
});

describe("createApp — prod admin mode", () => {
  it("does NOT mount the admin plane when admin is disabled", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ENPILINK_ADMIN;
    const { createApp } = await import("./express.js");
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const httpServer = http.createServer();
    await createApp({ mcpServer: server, httpServer });
    const { port, server: listening } = await listen(server.express);
    openServer = listening;

    const obs = await fetch(`http://localhost:${port}${OBS}`);
    expect(obs.status).toBe(404);

    // /mcp still works regardless of admin.
    const mcp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(mcp.status).not.toBe(404);
  });

  it("refuses to start when admin is enabled but no token is set", async () => {
    process.env.NODE_ENV = "production";
    process.env.ENPILINK_ADMIN = "1";
    delete process.env.ENPILINK_ADMIN_TOKEN;
    const { createApp } = await import("./express.js");
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const httpServer = http.createServer();
    await expect(
      createApp({ mcpServer: server, httpServer }),
    ).rejects.toBeInstanceOf(AdminTokenMissingError);
  });

  it("mounts the admin plane behind bearer auth when enabled with a token", async () => {
    process.env.NODE_ENV = "production";
    process.env.ENPILINK_ADMIN = "1";
    process.env.ENPILINK_ADMIN_TOKEN = "letmein";
    process.env.ENPILINK_STORAGE = "memory"; // never touch disk in tests
    const { createApp } = await import("./express.js");
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const httpServer = http.createServer();
    await createApp({ mcpServer: server, httpServer });
    const { port, server: listening } = await listen(server.express);
    openServer = listening;

    // Unauthenticated → 401.
    const unauth = await fetch(`http://localhost:${port}${OBS}`);
    expect(unauth.status).toBe(401);

    // Valid bearer → 200.
    const authed = await fetch(`http://localhost:${port}${OBS}`, {
      headers: { Authorization: "Bearer letmein" },
    });
    expect(authed.status).toBe(200);

    // Admin storage was initialized independent of analytics (analytics OFF).
    expect(server.storage).not.toBeNull();

    // /mcp still works and is NOT guarded by the admin auth (no 401/404).
    const mcp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "c", version: "1" },
        },
      }),
    });
    expect(mcp.status).toBe(200);

    await server.storage?.close();
  });
});

describe("createApp — dev mode unchanged", () => {
  it("mounts the admin plane on localhost with NO auth", async () => {
    delete process.env.NODE_ENV; // dev
    const { createApp } = await import("./express.js");
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const httpServer = http.createServer();
    await createApp({ mcpServer: server, httpServer });
    const { port, server: listening } = await listen(server.express);
    openServer = listening;

    // No Authorization header, yet the observability route answers (200).
    const obs = await fetch(`http://localhost:${port}${OBS}`);
    expect(obs.status).toBe(200);
  });
});
