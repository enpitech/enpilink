import { z } from "zod";

/**
 * Config schema for enpilink's admin / control plane (M4).
 *
 * Settings are split into two tiers:
 *
 * - **Bootstrap** keys are env/file ONLY — they configure how the process
 *   starts (storage engine, port, whether the prod admin is enabled, the admin
 *   auth secret). They are NOT editable from the DB / admin UI. Some are
 *   **secret** (`adminAuthToken`) and are never persisted to the DB nor
 *   returned in plaintext by any API.
 * - **Runtime** keys live in the DB and are editable from the Configuration
 *   admin page (analytics on/off + sample rate, retention, feature flags,
 *   display prefs). They still honour the env > file > db precedence so an
 *   operator can pin a value via env/file and lock it in the UI.
 *
 * Resolution precedence is **env > file > db > default** (see `resolve.ts`).
 */

/** A boolean parsed from an env string: `1`/`true`/`yes`/`on` (ci) → true. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/** Coerce an env string (or already-typed value) into a boolean. */
export function coerceBool(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (TRUTHY.has(v)) {
      return true;
    }
    if (FALSY.has(v)) {
      return false;
    }
  }
  return undefined;
}

/** Coerce an env string (or number) into a finite number. */
export function coerceNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

/**
 * Bootstrap (env/file-only) settings. Not DB-editable. Defaults keep the
 * framework off-by-default and secure-by-default.
 */
export const bootstrapSchema = z.object({
  /** Storage engine name (`memory` | `sqlite` | custom). */
  storage: z.string().default("memory"),
  /** SQLite database path (only meaningful for the sqlite engine). */
  dbPath: z.string().default("./enpilink.db"),
  /** HTTP port the server listens on. */
  port: z.number().int().positive().default(3000),
  /** Whether the production admin plane is enabled (M5). Off by default. */
  admin: z.boolean().default(false),
  /**
   * Bearer token guarding the prod admin plane (M5). SECRET — env-only, never
   * persisted to the DB nor returned in plaintext.
   */
  adminAuthToken: z.string().optional(),
});

/** Runtime (DB-editable) settings. */
export const runtimeSchema = z.object({
  /** Whether analytics/event capture is enabled. */
  "analytics.enabled": z.boolean().default(false),
  /** Fraction of requests sampled `[0, 1]`. */
  "analytics.sampleRate": z.number().min(0).max(1).default(1),
  /** Max events retained (retention cap). */
  "retention.events": z.number().int().nonnegative().default(5000),
  /** Max logs retained (retention cap). */
  "retention.logs": z.number().int().nonnegative().default(5000),
  /** Feature flag: expose the live log stream in the dashboard. */
  "flags.liveLogs": z.boolean().default(true),
  /** Display preference: dashboard time-bucket width (ms). */
  "display.bucketMs": z.number().int().positive().default(60_000),
});

export const configSchema = bootstrapSchema.merge(runtimeSchema);

export type BootstrapConfig = z.infer<typeof bootstrapSchema>;
export type RuntimeConfig = z.infer<typeof runtimeSchema>;
export type Config = z.infer<typeof configSchema>;

/** All known config keys. */
export type ConfigKey = keyof Config;
export type BootstrapKey = keyof BootstrapConfig;
export type RuntimeKey = keyof RuntimeConfig;

/** Per-key metadata describing tier / secret / env-lock semantics. */
export interface KeyMeta {
  key: ConfigKey;
  /** `bootstrap` (env/file only) or `runtime` (DB-editable). */
  tier: "bootstrap" | "runtime";
  /** Secret keys are env-only and NEVER persisted/returned in plaintext. */
  secret: boolean;
  /** The env var that drives this key (for the "set via env" hint). */
  env: string;
}

/** Bootstrap keys (env/file only). */
export const BOOTSTRAP_KEYS = [
  "storage",
  "dbPath",
  "port",
  "admin",
  "adminAuthToken",
] as const satisfies readonly BootstrapKey[];

/** Runtime keys (DB-editable). */
export const RUNTIME_KEYS = [
  "analytics.enabled",
  "analytics.sampleRate",
  "retention.events",
  "retention.logs",
  "flags.liveLogs",
  "display.bucketMs",
] as const satisfies readonly RuntimeKey[];

/** Secret keys: env-only, masked + never persisted/returned in plaintext. */
export const SECRET_KEYS = [
  "adminAuthToken",
] as const satisfies readonly ConfigKey[];

/**
 * Env var mapping per key. Bootstrap keys map to dedicated env vars that match
 * the framework's existing env surface; runtime keys use an
 * `ENPILINK_CFG_<KEY>` convention so an operator can pin (env-lock) any runtime
 * value without colliding with the bootstrap vars.
 */
export const ENV_VARS: Record<ConfigKey, string> = {
  storage: "ENPILINK_STORAGE",
  dbPath: "ENPILINK_DB_PATH",
  port: "PORT",
  admin: "ENPILINK_ADMIN",
  adminAuthToken: "ENPILINK_ADMIN_TOKEN",
  "analytics.enabled": "ENPILINK_ANALYTICS",
  "analytics.sampleRate": "ENPILINK_CFG_ANALYTICS_SAMPLE_RATE",
  "retention.events": "ENPILINK_CFG_RETENTION_EVENTS",
  "retention.logs": "ENPILINK_CFG_RETENTION_LOGS",
  "flags.liveLogs": "ENPILINK_CFG_FLAGS_LIVE_LOGS",
  "display.bucketMs": "ENPILINK_CFG_DISPLAY_BUCKET_MS",
};

const SECRET_SET = new Set<string>(SECRET_KEYS);
const RUNTIME_SET = new Set<string>(RUNTIME_KEYS);
const BOOTSTRAP_SET = new Set<string>(BOOTSTRAP_KEYS);

export function isSecretKey(key: string): boolean {
  return SECRET_SET.has(key);
}
export function isRuntimeKey(key: string): key is RuntimeKey {
  return RUNTIME_SET.has(key);
}
export function isBootstrapKey(key: string): key is BootstrapKey {
  return BOOTSTRAP_SET.has(key);
}
export function isKnownKey(key: string): key is ConfigKey {
  return RUNTIME_SET.has(key) || BOOTSTRAP_SET.has(key);
}

/** Metadata for every known key. */
export function keyMeta(key: ConfigKey): KeyMeta {
  return {
    key,
    tier: isBootstrapKey(key) ? "bootstrap" : "runtime",
    secret: isSecretKey(key),
    env: ENV_VARS[key],
  };
}

/** All keys with metadata. */
export function allKeyMeta(): KeyMeta[] {
  return [...BOOTSTRAP_KEYS, ...RUNTIME_KEYS].map((k) => keyMeta(k));
}

/** The per-key zod schema (for validating a single runtime write). */
export function schemaForKey(key: ConfigKey): z.ZodTypeAny {
  return (
    (configSchema.shape as Record<string, z.ZodTypeAny>)[key] ?? z.unknown()
  );
}
