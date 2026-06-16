import fs from "node:fs";
import path from "node:path";
import type { StorageAdapter } from "../storage/types.js";
import {
  type Config,
  type ConfigKey,
  coerceBool,
  coerceNumber,
  configSchema,
  ENV_VARS,
  isRuntimeKey,
  isSecretKey,
  keyMeta,
  RUNTIME_KEYS,
  schemaForKey,
} from "./schema.js";

/**
 * Config resolution (M4). Merges sources with precedence
 * **env > file (`enpilink.config.{json,ts}`) > db (runtime only) > default**
 * and reports, per key, which source supplied the value and whether the key is
 * secret / env-locked (read-only).
 *
 * Secrets (e.g. `adminAuthToken`) are NEVER read from the DB and NEVER returned
 * in plaintext — {@link resolveConfig} masks them to a placeholder and flags
 * `secret: true`. Bootstrap keys and any key pinned by env/file are
 * `envLocked: true` (the admin UI must render them read-only).
 */

export type ConfigSource = "env" | "file" | "db" | "default";

/** A masked placeholder returned in place of any secret value. */
export const MASKED = "••••••••";

/** A single resolved setting as exposed by the config API. */
export interface ResolvedSetting {
  key: ConfigKey;
  /** Tier: `bootstrap` (env/file only) or `runtime` (DB-editable). */
  tier: "bootstrap" | "runtime";
  /** The resolved value, or {@link MASKED} when secret. */
  value: unknown;
  /** Which source supplied the value. */
  source: ConfigSource;
  /** Whether this key is a secret (never returned in plaintext). */
  secret: boolean;
  /**
   * Whether this key is read-only in the admin UI. True for all bootstrap keys,
   * and for any runtime key pinned via env or file (the DB value is shadowed).
   */
  envLocked: boolean;
  /** The env var that drives / can pin this key. */
  env: string;
}

/** The full resolved config plus per-key reporting. */
export interface ResolvedConfig {
  /** Effective typed values (secrets present in-process, masked only at the API). */
  values: Config;
  /** Per-key source + secret/env-lock reporting. */
  settings: ResolvedSetting[];
}

const FILE_NAMES = ["enpilink.config.json", "enpilink.config.ts"];

/**
 * Load the optional config file (JSON only — a `.ts` file is acknowledged but
 * not executed here to avoid a runtime transpile dependency; M6 can add TS
 * loading). Returns a flat partial keyed by {@link ConfigKey}. Never throws —
 * a malformed/absent file yields `{}`.
 */
export function loadConfigFile(cwd: string = process.cwd()): {
  source: "file" | null;
  values: Partial<Record<ConfigKey, unknown>>;
} {
  for (const name of FILE_NAMES) {
    const full = path.join(cwd, name);
    if (!fs.existsSync(full)) {
      continue;
    }
    if (name.endsWith(".json")) {
      try {
        const raw = fs.readFileSync(full, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          return { source: "file", values: parsed as Record<string, unknown> };
        }
      } catch {
        // Malformed file → ignore (defaults/db/env still apply).
      }
    }
    // A `.ts` config file is recognized but not executed in M4.
  }
  return { source: null, values: {} };
}

/** Read the raw env value for a key (the mapped env var), or undefined. */
function envValue(key: ConfigKey): string | undefined {
  const raw = process.env[ENV_VARS[key]];
  return raw === undefined || raw === "" ? undefined : raw;
}

/** Default-typed sample used to learn each key's expected runtime type. */
const TYPE_SAMPLE = configSchema.parse({}) as Record<string, unknown>;

/** Coerce a raw value (e.g. an env string) to the key's expected type. */
function coerceForKey(key: ConfigKey, raw: unknown): unknown {
  const expected = typeof TYPE_SAMPLE[key];
  if (expected === "boolean") {
    return coerceBool(raw) ?? raw;
  }
  if (expected === "number") {
    return coerceNumber(raw) ?? raw;
  }
  return raw;
}

/**
 * Resolve all config. Reads the DB (runtime keys only) when a storage adapter
 * is provided; secrets are never read from the DB. Falls back to defaults when
 * there is no storage. Never throws on a storage error — it degrades to
 * file/env/default.
 *
 * @param storage active storage adapter, or `null` when analytics/admin is off.
 */
export async function resolveConfig(
  storage: StorageAdapter | null,
  cwd: string = process.cwd(),
): Promise<ResolvedConfig> {
  const file = loadConfigFile(cwd);

  // DB values for runtime keys only (secrets are never persisted/read).
  let db: Record<string, unknown> = {};
  if (storage) {
    try {
      const all = await storage.allConfig();
      for (const key of RUNTIME_KEYS) {
        if (key in all && !isSecretKey(key)) {
          db[key] = all[key];
        }
      }
    } catch {
      db = {};
    }
  }

  const rawValues: Record<string, unknown> = {};
  const sources = new Map<ConfigKey, ConfigSource>();

  const keys = Object.keys(configSchema.shape) as ConfigKey[];
  for (const key of keys) {
    const env = envValue(key);
    if (env !== undefined) {
      rawValues[key] = coerceForKey(key, env);
      sources.set(key, "env");
      continue;
    }
    if (key in file.values) {
      rawValues[key] = file.values[key];
      sources.set(key, "file");
      continue;
    }
    // Secrets are never read from the DB.
    if (isRuntimeKey(key) && !isSecretKey(key) && key in db) {
      rawValues[key] = db[key];
      sources.set(key, "db");
      continue;
    }
    sources.set(key, "default");
  }

  // Validate + fill defaults. If a supplied value is invalid, zod throws; we
  // fall back per-key to the default so a bad DB/file value can't crash reads.
  let values: Config;
  try {
    values = configSchema.parse(rawValues);
  } catch {
    // Re-resolve key-by-key, dropping any invalid override.
    const safe: Record<string, unknown> = {};
    for (const key of keys) {
      const single = schemaForKey(key).safeParse(rawValues[key]);
      if (single.success && key in rawValues) {
        safe[key] = rawValues[key];
      } else if (sources.get(key) !== "default") {
        sources.set(key, "default");
      }
    }
    values = configSchema.parse(safe);
  }

  const settings: ResolvedSetting[] = keys.map((key) => {
    const meta = keyMeta(key);
    const source = sources.get(key) ?? "default";
    const secret = meta.secret;
    // Env-locked: bootstrap keys are always read-only; runtime keys are locked
    // when pinned by env or file (the DB write would be shadowed).
    const envLocked =
      meta.tier === "bootstrap" || source === "env" || source === "file";
    const value = secret
      ? values[key] !== undefined && values[key] !== ""
        ? MASKED
        : null
      : (values[key] as unknown);
    return {
      key,
      tier: meta.tier,
      value,
      source,
      secret,
      envLocked,
      env: meta.env,
    };
  });

  return { values, settings };
}

/**
 * Validate + coerce a single RUNTIME, non-secret value before persisting.
 * Returns the coerced value or an error string. Rejects unknown/bootstrap/
 * secret keys (those are handled by the caller with a clear 4xx).
 */
export function validateRuntimeWrite(
  key: string,
  rawValue: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!isRuntimeKey(key)) {
    return { ok: false, error: `"${key}" is not a runtime key` };
  }
  if (isSecretKey(key)) {
    return { ok: false, error: `"${key}" is a secret and cannot be set here` };
  }
  const coerced = coerceForKey(key as ConfigKey, rawValue);
  const parsed = schemaForKey(key as ConfigKey).safeParse(coerced);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid value for "${key}": ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    };
  }
  return { ok: true, value: parsed.data };
}
