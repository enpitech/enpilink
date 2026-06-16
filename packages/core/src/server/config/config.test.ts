import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../storage/memory.js";
import type { StorageAdapter } from "../storage/types.js";
import { MASKED, resolveConfig, validateRuntimeWrite } from "./resolve.js";
import { createConfigRouter } from "./router.js";

/** A throwaway dir with no enpilink.config.* so file source never interferes. */
let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "enpi-cfg-"));
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  // Clean any env we set.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("ENPILINK_CFG_") || k === "ENPILINK_ANALYTICS") {
      delete process.env[k];
    }
  }
});

describe("resolveConfig precedence", () => {
  it("defaults when no source supplies a value", async () => {
    const { settings } = await resolveConfig(null, cwd);
    const s = settings.find((x) => x.key === "analytics.sampleRate");
    expect(s?.value).toBe(1);
    expect(s?.source).toBe("default");
    expect(s?.envLocked).toBe(false);
  });

  it("db beats default for runtime keys", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setConfig("analytics.sampleRate", 0.25, "tester");
    const { settings, values } = await resolveConfig(storage, cwd);
    const s = settings.find((x) => x.key === "analytics.sampleRate");
    expect(s?.source).toBe("db");
    expect(s?.value).toBe(0.25);
    expect(values["analytics.sampleRate"]).toBe(0.25);
  });

  it("file beats db", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setConfig("analytics.sampleRate", 0.25);
    fs.writeFileSync(
      path.join(cwd, "enpilink.config.json"),
      JSON.stringify({ "analytics.sampleRate": 0.5 }),
    );
    const { settings } = await resolveConfig(storage, cwd);
    const s = settings.find((x) => x.key === "analytics.sampleRate");
    expect(s?.source).toBe("file");
    expect(s?.value).toBe(0.5);
    expect(s?.envLocked).toBe(true); // file pins it → read-only in UI
  });

  it("env beats file and db", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setConfig("analytics.sampleRate", 0.25);
    fs.writeFileSync(
      path.join(cwd, "enpilink.config.json"),
      JSON.stringify({ "analytics.sampleRate": 0.5 }),
    );
    process.env.ENPILINK_CFG_ANALYTICS_SAMPLE_RATE = "0.75";
    const { settings } = await resolveConfig(storage, cwd);
    const s = settings.find((x) => x.key === "analytics.sampleRate");
    expect(s?.source).toBe("env");
    expect(s?.value).toBe(0.75);
    expect(s?.envLocked).toBe(true);
  });

  it("coerces env booleans/numbers to typed values", async () => {
    process.env.ENPILINK_CFG_FLAGS_LIVE_LOGS = "false";
    process.env.ENPILINK_CFG_RETENTION_EVENTS = "1234";
    const { values } = await resolveConfig(null, cwd);
    expect(values["flags.liveLogs"]).toBe(false);
    expect(values["retention.events"]).toBe(1234);
  });
});

describe("secret masking", () => {
  it("never returns a secret value in plaintext", async () => {
    process.env.ENPILINK_ADMIN_TOKEN = "super-secret-xyz";
    const { settings } = await resolveConfig(null, cwd);
    const s = settings.find((x) => x.key === "adminAuthToken");
    expect(s?.secret).toBe(true);
    expect(s?.envLocked).toBe(true);
    expect(s?.value).toBe(MASKED);
    expect(JSON.stringify(settings)).not.toContain("super-secret-xyz");
    delete process.env.ENPILINK_ADMIN_TOKEN;
  });

  it("unset secret reports null, not masked", async () => {
    const { settings } = await resolveConfig(null, cwd);
    const s = settings.find((x) => x.key === "adminAuthToken");
    expect(s?.value).toBeNull();
  });

  it("bootstrap keys are always env-locked", async () => {
    const { settings } = await resolveConfig(null, cwd);
    for (const key of ["storage", "dbPath", "port", "admin"]) {
      const s = settings.find((x) => x.key === key);
      expect(s?.tier).toBe("bootstrap");
      expect(s?.envLocked).toBe(true);
    }
  });
});

describe("validateRuntimeWrite", () => {
  it("accepts a valid runtime value", () => {
    const r = validateRuntimeWrite("analytics.sampleRate", 0.3);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(0.3);
    }
  });
  it("coerces a stringy boolean for a flag", () => {
    const r = validateRuntimeWrite("flags.liveLogs", "true");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(true);
    }
  });
  it("rejects out-of-range", () => {
    const r = validateRuntimeWrite("analytics.sampleRate", 5);
    expect(r.ok).toBe(false);
  });
  it("rejects bootstrap key", () => {
    expect(validateRuntimeWrite("port", 8080).ok).toBe(false);
  });
  it("rejects secret key", () => {
    expect(validateRuntimeWrite("adminAuthToken", "x").ok).toBe(false);
  });
});

// --- Router integration tests ---

async function request(
  app: express.Express,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function appWith(storage: StorageAdapter | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createConfigRouter(() => storage));
  return app;
}

describe("config router", () => {
  it("GET /config returns settings; never 500 with no storage", async () => {
    const app = appWith(null);
    const { status, json } = await request(app, "GET", "/__enpilink/config");
    expect(status).toBe(200);
    const settings = (json as { settings: unknown[] }).settings;
    expect(Array.isArray(settings)).toBe(true);
    expect(settings.length).toBeGreaterThan(0);
  });

  it("PUT a runtime key persists + writes an audit row", async () => {
    const storage = new MemoryStorageAdapter();
    const app = appWith(storage);
    const { status, json } = await request(
      app,
      "PUT",
      "/__enpilink/config/analytics.sampleRate",
      { value: 0.4 },
    );
    expect(status).toBe(200);
    expect((json as { ok: boolean }).ok).toBe(true);
    expect(await storage.getConfig("analytics.sampleRate")).toBe(0.4);
    const audit = await storage.getConfigAudit();
    expect(audit[0]).toMatchObject({
      key: "analytics.sampleRate",
      newValue: 0.4,
    });
  });

  it("PUT rejects a bootstrap key (403)", async () => {
    const storage = new MemoryStorageAdapter();
    const app = appWith(storage);
    const { status } = await request(app, "PUT", "/__enpilink/config/port", {
      value: 9999,
    });
    expect(status).toBe(403);
  });

  it("PUT rejects a secret key (403)", async () => {
    const storage = new MemoryStorageAdapter();
    const app = appWith(storage);
    const { status } = await request(
      app,
      "PUT",
      "/__enpilink/config/adminAuthToken",
      { value: "x" },
    );
    expect(status).toBe(403);
  });

  it("PUT rejects an unknown key (404)", async () => {
    const app = appWith(new MemoryStorageAdapter());
    const { status } = await request(app, "PUT", "/__enpilink/config/nope", {
      value: 1,
    });
    expect(status).toBe(404);
  });

  it("PUT rejects an out-of-range runtime value (400)", async () => {
    const app = appWith(new MemoryStorageAdapter());
    const { status } = await request(
      app,
      "PUT",
      "/__enpilink/config/analytics.sampleRate",
      { value: 99 },
    );
    expect(status).toBe(400);
  });

  it("PUT with no storage → 409 (nowhere to persist)", async () => {
    const app = appWith(null);
    const { status } = await request(
      app,
      "PUT",
      "/__enpilink/config/flags.liveLogs",
      { value: false },
    );
    expect(status).toBe(409);
  });

  it("GET /config/audit surfaces entries", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setConfig("flags.liveLogs", false, "tester");
    const app = appWith(storage);
    const { status, json } = await request(
      app,
      "GET",
      "/__enpilink/config/audit",
    );
    expect(status).toBe(200);
    const audit = (json as { audit: Array<{ key: string }> }).audit;
    expect(audit[0]?.key).toBe("flags.liveLogs");
  });

  it("GET /config/audit with no storage → empty, never 500", async () => {
    const app = appWith(null);
    const { status, json } = await request(
      app,
      "GET",
      "/__enpilink/config/audit",
    );
    expect(status).toBe(200);
    expect((json as { audit: unknown[] }).audit).toEqual([]);
  });
});
