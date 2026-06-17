import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../storage/memory.js";
import type { StorageAdapter } from "../storage/types.js";
import {
  MASKED,
  resetBootSnapshotForTests,
  resolveConfig,
  validateConfigWrite,
  validateRuntimeWrite,
} from "./resolve.js";
import { createConfigRouter } from "./router.js";

/** A throwaway dir with no enpilink.config.* so file source never interferes. */
let cwd: string;

const RESTART_ENV = ["ENPILINK_STORAGE", "ENPILINK_DB_PATH", "PORT"];

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "enpi-cfg-"));
  resetBootSnapshotForTests();
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  // Clean any env we set.
  for (const k of Object.keys(process.env)) {
    if (
      k.startsWith("ENPILINK_CFG_") ||
      k === "ENPILINK_ANALYTICS" ||
      k === "ENPILINK_ADMIN_TOKEN" ||
      k === "ENPILINK_ADMIN" ||
      RESTART_ENV.includes(k)
    ) {
      delete process.env[k];
    }
  }
  resetBootSnapshotForTests();
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

  it("readonly bootstrap key (admin) is always env-locked", async () => {
    const { settings } = await resolveConfig(null, cwd);
    const s = settings.find((x) => x.key === "admin");
    expect(s?.tier).toBe("bootstrap");
    expect(s?.editable).toBe("readonly");
    expect(s?.envLocked).toBe(true);
  });

  it("restart-tier bootstrap keys are editable when not env/file-pinned", async () => {
    const { settings } = await resolveConfig(null, cwd);
    for (const key of ["storage", "dbPath", "port"]) {
      const s = settings.find((x) => x.key === key);
      expect(s?.tier).toBe("bootstrap");
      expect(s?.editable).toBe("restart");
      expect(s?.envLocked).toBe(false);
    }
  });

  it("auth secrets (signing key / client secret) are env-only + masked (A1)", async () => {
    process.env.ENPILINK_AUTH_SIGNING_KEY = "signing-secret-abc";
    process.env.ENPILINK_AUTH_CLIENT_SECRET = "client-secret-def";
    const { settings, values } = await resolveConfig(null, cwd);
    for (const key of ["auth.signingKey", "auth.clientSecret"]) {
      const s = settings.find((x) => x.key === key);
      expect(s?.secret).toBe(true);
      expect(s?.editable).toBe("readonly");
      expect(s?.envLocked).toBe(true);
      expect(s?.value).toBe(MASKED);
    }
    // Never leak in the serialized settings the API returns.
    expect(JSON.stringify(settings)).not.toContain("signing-secret-abc");
    expect(JSON.stringify(settings)).not.toContain("client-secret-def");
    // But the in-process raw values ARE available (for A2's signer).
    expect(values["auth.signingKey"]).toBe("signing-secret-abc");
    delete process.env.ENPILINK_AUTH_SIGNING_KEY;
    delete process.env.ENPILINK_AUTH_CLIENT_SECRET;
  });

  it("auth.enabled defaults to false (auth is opt-in) (A1)", async () => {
    const { values } = await resolveConfig(null, cwd);
    expect(values["auth.enabled"]).toBe(false);
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

  it("PUT rejects a readonly bootstrap key like `admin` (403)", async () => {
    const storage = new MemoryStorageAdapter();
    const app = appWith(storage);
    const { status } = await request(app, "PUT", "/__enpilink/config/admin", {
      value: true,
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

// --- Per-key metadata (richer ResolvedSetting) ---

describe("resolved setting metadata", () => {
  it("exposes label/description/group/unit/default/editable per key", async () => {
    const { settings } = await resolveConfig(null, cwd);
    const sample = settings.find((s) => s.key === "analytics.sampleRate");
    expect(sample?.label).toBe("Sampling rate");
    expect(typeof sample?.description).toBe("string");
    expect(sample?.group).toBe("Analytics");
    expect(sample?.unit).toBe("0–1 ratio");
    expect(sample?.default).toBe(1);
    expect(sample?.editable).toBe("runtime");
  });

  it("classifies restart vs readonly editability", async () => {
    const { settings } = await resolveConfig(null, cwd);
    const byKey = new Map(settings.map((s) => [s.key, s]));
    expect(byKey.get("port")?.editable).toBe("restart");
    expect(byKey.get("storage")?.editable).toBe("restart");
    expect(byKey.get("dbPath")?.editable).toBe("restart");
    expect(byKey.get("admin")?.editable).toBe("readonly");
    expect(byKey.get("adminAuthToken")?.editable).toBe("readonly");
  });

  it("restart-tier keys NOT pinned by env/file are not env-locked", async () => {
    const { settings } = await resolveConfig(null, cwd);
    const port = settings.find((s) => s.key === "port");
    expect(port?.envLocked).toBe(false);
    const admin = settings.find((s) => s.key === "admin");
    // readonly key stays env-locked (read-only) even without an env pin.
    expect(admin?.envLocked).toBe(true);
  });

  it("modified=true only when a DB override differs from the default", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setConfig("retention.events", 9999);
    const { settings } = await resolveConfig(storage, cwd);
    const s = settings.find((x) => x.key === "retention.events");
    expect(s?.modified).toBe(true);
    // an untouched key is not modified
    const other = settings.find((x) => x.key === "analytics.sampleRate");
    expect(other?.modified).toBe(false);
  });
});

// --- Restart-tier writes + restartRequired ---

describe("restart-tier editability", () => {
  it("validateConfigWrite accepts a restart key, rejects secret", () => {
    expect(validateConfigWrite("port", 8080).ok).toBe(true);
    expect(validateConfigWrite("storage", "sqlite").ok).toBe(true);
    expect(validateConfigWrite("adminAuthToken", "x").ok).toBe(false);
    expect(validateConfigWrite("admin", true).ok).toBe(false);
  });

  it("PUT a restart key persists + flags restartRequired", async () => {
    const storage = new MemoryStorageAdapter();
    const app = appWith(storage);
    const { status, json } = await request(
      app,
      "PUT",
      "/__enpilink/config/port",
      {
        value: 8080,
      },
    );
    expect(status).toBe(200);
    expect((json as { restartRequired: boolean }).restartRequired).toBe(true);
    expect(await storage.getConfig("port")).toBe(8080);

    // The boot snapshot is the default 3000; the persisted 8080 differs → pending.
    const { settings } = await resolveConfig(storage, cwd);
    const port = settings.find((s) => s.key === "port");
    expect(port?.source).toBe("db");
    expect(port?.value).toBe(8080);
    expect(port?.restartRequired).toBe(true);
  });

  it("restartRequired is false when the DB value equals the booted value", async () => {
    const storage = new MemoryStorageAdapter();
    // booted with default 3000; persist the same value
    await storage.setConfig("port", 3000);
    const { settings } = await resolveConfig(storage, cwd);
    const port = settings.find((s) => s.key === "port");
    expect(port?.restartRequired).toBe(false);
  });

  it("PUT a restart key 409s when env-pinned (envLocked)", async () => {
    process.env.PORT = "4000";
    resetBootSnapshotForTests();
    const storage = new MemoryStorageAdapter();
    const app = appWith(storage);
    const { status } = await request(app, "PUT", "/__enpilink/config/port", {
      value: 8080,
    });
    expect(status).toBe(409);
  });
});

// --- A6: auth setup keys + login-page branding ---

describe("A6 — auth setup config (editable upstream + branding, secrets stay env-only)", () => {
  it("non-secret auth keys are restart-tier editable (not env-locked by default)", async () => {
    const { settings } = await resolveConfig(null, cwd);
    for (const key of [
      "auth.enabled",
      "auth.issuer",
      "auth.audience",
      "auth.jwksUrl",
      "auth.upstream.clientId",
      "auth.upstream.authorizationUrl",
      "auth.upstream.tokenUrl",
      "auth.redirectUris",
      "auth.branding.appName",
      "auth.branding.logoUrl",
      "auth.branding.accentColor",
      "auth.branding.tagline",
    ]) {
      const s = settings.find((x) => x.key === key);
      expect(s?.editable, key).toBe("restart");
      expect(s?.secret, key).toBe(false);
      expect(s?.envLocked, key).toBe(false);
    }
  });

  it("the two auth SECRETS stay env-only / read-only (never web-editable)", async () => {
    const { settings } = await resolveConfig(null, cwd);
    for (const key of ["auth.signingKey", "auth.clientSecret"]) {
      const s = settings.find((x) => x.key === key);
      expect(s?.editable, key).toBe("readonly");
      expect(s?.secret, key).toBe(true);
    }
  });

  it("validates a branding key (valid persists, garbage rejected)", () => {
    expect(validateConfigWrite("auth.branding.appName", "Acme").ok).toBe(true);
    expect(validateConfigWrite("auth.branding.accentColor", "#3fb6a8").ok).toBe(
      true,
    );
    // A non-string is rejected by the schema.
    expect(validateConfigWrite("auth.branding.appName", 123).ok).toBe(false);
  });

  it("PUT persists an editable upstream/branding key (auth Setup screen)", async () => {
    const storage = new MemoryStorageAdapter();
    const app = appWith(storage);
    const clientId = await request(
      app,
      "PUT",
      "/__enpilink/config/auth.upstream.clientId",
      { value: "acme-client" },
    );
    expect(clientId.status).toBe(200);
    expect(await storage.getConfig("auth.upstream.clientId")).toBe(
      "acme-client",
    );

    const brand = await request(
      app,
      "PUT",
      "/__enpilink/config/auth.branding.appName",
      { value: "Acme" },
    );
    expect(brand.status).toBe(200);
    expect(await storage.getConfig("auth.branding.appName")).toBe("Acme");
  });

  it("PUT rejects the auth SECRETS with 403 (the central guardrail)", async () => {
    const app = appWith(new MemoryStorageAdapter());
    for (const key of ["auth.signingKey", "auth.clientSecret"]) {
      const { status } = await request(
        app,
        "PUT",
        `/__enpilink/config/${key}`,
        { value: "leak-me" },
      );
      expect(status, key).toBe(403);
    }
  });

  it("DELETE rejects the auth SECRETS with 403", async () => {
    const app = appWith(new MemoryStorageAdapter());
    for (const key of ["auth.signingKey", "auth.clientSecret"]) {
      const { status } = await request(
        app,
        "DELETE",
        `/__enpilink/config/${key}`,
      );
      expect(status, key).toBe(403);
    }
  });
});

// --- Security guardrails ---

describe("write guardrails (PUT + DELETE)", () => {
  it("PUT rejects `admin` (403) — never web-editable", async () => {
    const app = appWith(new MemoryStorageAdapter());
    const { status } = await request(app, "PUT", "/__enpilink/config/admin", {
      value: true,
    });
    expect(status).toBe(403);
  });

  it("PUT rejects `adminAuthToken` (403) — secret", async () => {
    const app = appWith(new MemoryStorageAdapter());
    const { status } = await request(
      app,
      "PUT",
      "/__enpilink/config/adminAuthToken",
      { value: "leak" },
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

  it("PUT rejects an env-locked runtime key (409)", async () => {
    process.env.ENPILINK_CFG_FLAGS_LIVE_LOGS = "false";
    const app = appWith(new MemoryStorageAdapter());
    const { status } = await request(
      app,
      "PUT",
      "/__enpilink/config/flags.liveLogs",
      { value: true },
    );
    expect(status).toBe(409);
  });

  it("DELETE rejects `admin`/`adminAuthToken`/unknown the same way", async () => {
    const app = appWith(new MemoryStorageAdapter());
    expect(
      (await request(app, "DELETE", "/__enpilink/config/admin")).status,
    ).toBe(403);
    expect(
      (await request(app, "DELETE", "/__enpilink/config/adminAuthToken"))
        .status,
    ).toBe(403);
    expect(
      (await request(app, "DELETE", "/__enpilink/config/nope")).status,
    ).toBe(404);
  });
});

// --- Reset to default ---

describe("reset to default (DELETE)", () => {
  it("clears a DB override and falls back to default + audits", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setConfig("retention.events", 9999, "tester");
    const app = appWith(storage);
    const { status, json } = await request(
      app,
      "DELETE",
      "/__enpilink/config/retention.events",
    );
    expect(status).toBe(200);
    expect((json as { reset: boolean }).reset).toBe(true);
    // Override gone → resolution falls back to the default.
    const { settings } = await resolveConfig(storage, cwd);
    const s = settings.find((x) => x.key === "retention.events");
    expect(s?.source).toBe("default");
    expect(s?.value).toBe(5000);
    expect(s?.modified).toBe(false);
    // Audit recorded the reset (most recent first; router actor = "dev").
    const audit = await storage.getConfigAudit();
    expect(audit[0]).toMatchObject({ key: "retention.events", actor: "dev" });
  });

  it("DELETE with no storage → 409", async () => {
    const app = appWith(null);
    const { status } = await request(
      app,
      "DELETE",
      "/__enpilink/config/flags.liveLogs",
    );
    expect(status).toBe(409);
  });
});

// --- Presets ---

describe("presets", () => {
  it("GET /config/presets lists Dev + Prod with values", async () => {
    const app = appWith(new MemoryStorageAdapter());
    const { status, json } = await request(
      app,
      "GET",
      "/__enpilink/config/presets",
    );
    expect(status).toBe(200);
    const presets = (json as { presets: Array<{ name: string }> }).presets;
    expect(presets.map((p) => p.name).sort()).toEqual(["dev", "prod"]);
  });

  it("POST applies a preset to runtime keys + audits", async () => {
    const storage = new MemoryStorageAdapter();
    const app = appWith(storage);
    const { status, json } = await request(
      app,
      "POST",
      "/__enpilink/config/preset/prod",
    );
    expect(status).toBe(200);
    const body = json as {
      applied: { key: string }[];
      skipped: { key: string }[];
    };
    expect(body.applied.length).toBeGreaterThan(0);
    expect(await storage.getConfig("analytics.sampleRate")).toBe(0.25);
    expect(await storage.getConfig("flags.liveLogs")).toBe(false);
  });

  it("POST skips env-locked keys, reporting them", async () => {
    process.env.ENPILINK_CFG_ANALYTICS_SAMPLE_RATE = "1";
    const storage = new MemoryStorageAdapter();
    const app = appWith(storage);
    const { json } = await request(
      app,
      "POST",
      "/__enpilink/config/preset/prod",
    );
    const body = json as {
      applied: { key: string }[];
      skipped: { key: string; reason: string }[];
    };
    expect(body.skipped.some((s) => s.key === "analytics.sampleRate")).toBe(
      true,
    );
    // env-pinned key was NOT persisted
    expect(await storage.getConfig("analytics.sampleRate")).toBeUndefined();
  });

  it("POST unknown preset → 404", async () => {
    const app = appWith(new MemoryStorageAdapter());
    const { status } = await request(
      app,
      "POST",
      "/__enpilink/config/preset/nope",
    );
    expect(status).toBe(404);
  });
});
