import fs from "node:fs";
import path from "node:path";
import type { StorageAdapter } from "../storage/types.js";
import {
  type Config,
  type ConfigKey,
  coerceBool,
  coerceNumber,
  configSchema,
  defaultForKey,
  type Editable,
  ENV_VARS,
  isRestartKey,
  isRuntimeKey,
  isSecretKey,
  keyMeta,
  RESTART_KEYS,
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
   * Whether this key is pinned by env/file (the DB value is shadowed). The UI
   * renders these read-only with a "set via ENV_VAR" hint. NOTE: a `restart`
   * key that is NOT env/file-pinned is editable here even though
   * `editable === "restart"`.
   */
  envLocked: boolean;
  /** The env var that drives / can pin this key. */
  env: string;
  /** Human-friendly label. */
  label: string;
  /** Plain-language one-liner describing the setting. */
  description: string;
  /** Functional group for UI sectioning (e.g. "Analytics", "Server"). */
  group: string;
  /** Optional unit hint (e.g. "ms", "events", "0–1 ratio"). */
  unit?: string;
  /** The schema default value. */
  default: unknown;
  /** Editability classification: `runtime` | `restart` | `readonly`. */
  editable: Editable;
  /**
   * True for startup/env-only keys (`port`/`storage`/`dbPath`) the DB-config can
   * never honour. The dashboard MUST NOT render these as settings — they are
   * documented as deploy/env concerns. Still returned here so they remain
   * introspectable via the API.
   */
  hidden: boolean;
  /**
   * True when the effective value comes from a DB override that differs from
   * the schema default (i.e. the operator has changed it).
   */
  modified: boolean;
  /**
   * Restart-tier only: true when a persisted DB value differs from the value
   * this process actually booted with — a pending change awaiting restart.
   * Always `false` for non-restart keys.
   */
  restartRequired: boolean;
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

/**
 * The value each restart-tier key BOOTED with, computed once at module load
 * from env > file > default (NEVER the DB — the running process never reads
 * restart keys from the DB). A later persisted DB value that differs from this
 * snapshot is a pending change awaiting restart (`restartRequired`).
 *
 * Memoized: captured lazily on first read so tests that set env/cwd before the
 * first `resolveConfig` call observe the right boot values, and it stays stable
 * for the lifetime of the process thereafter.
 */
let bootSnapshot: Record<string, unknown> | null = null;
function getBootSnapshot(cwd: string): Record<string, unknown> {
  if (bootSnapshot) {
    return bootSnapshot;
  }
  const file = loadConfigFile(cwd);
  const snap: Record<string, unknown> = {};
  for (const key of RESTART_KEYS) {
    const env = envValue(key);
    if (env !== undefined) {
      snap[key] = coerceForKey(key, env);
    } else if (key in file.values) {
      snap[key] = file.values[key];
    } else {
      snap[key] = defaultForKey(key);
    }
  }
  bootSnapshot = snap;
  return snap;
}

/** TEST-ONLY: reset the memoized boot snapshot so each test recomputes it. */
export function resetBootSnapshotForTests(): void {
  bootSnapshot = null;
}

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

  // DB values for runtime + restart-tier keys (secrets are never persisted/read).
  let db: Record<string, unknown> = {};
  if (storage) {
    try {
      const all = await storage.allConfig();
      for (const key of [...RUNTIME_KEYS, ...RESTART_KEYS]) {
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
    // Runtime + restart-tier keys may be sourced from the DB. Secrets never are.
    if (
      (isRuntimeKey(key) || isRestartKey(key)) &&
      !isSecretKey(key) &&
      key in db
    ) {
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

  const boot = getBootSnapshot(cwd);

  const settings: ResolvedSetting[] = keys.map((key) => {
    const meta = keyMeta(key);
    const source = sources.get(key) ?? "default";
    const secret = meta.secret;
    // Env-locked (read-only in the UI) when:
    // - the key is `readonly` (admin gate + the secret), OR
    // - the key is pinned via env or file (a DB write would be shadowed).
    // A `restart` key NOT pinned by env/file is editable (just needs a restart).
    const envLocked =
      meta.editable === "readonly" || source === "env" || source === "file";
    const value = secret
      ? values[key] !== undefined && values[key] !== ""
        ? MASKED
        : null
      : (values[key] as unknown);
    // `modified` — the effective value is a DB override that differs from the
    // schema default.
    const modified =
      !secret && source === "db" && !valuesEqual(values[key], meta.default);
    // `restartRequired` — restart-tier key whose persisted DB value differs
    // from the value this process booted with.
    const restartRequired =
      isRestartKey(key) && key in db && !valuesEqual(db[key], boot[key]);
    return {
      key,
      tier: meta.tier,
      value,
      source,
      secret,
      envLocked,
      env: meta.env,
      label: meta.label,
      description: meta.description,
      group: meta.group,
      unit: meta.unit,
      default: meta.default,
      editable: meta.editable,
      hidden: meta.hidden,
      modified,
      restartRequired,
    };
  });

  return { values, settings };
}

/** Structural value-equality for JSON-ish config values (primitives only here). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  // Treat numerically-equal values across number/string coercion as equal.
  if (typeof a === "number" && typeof b === "number") {
    return a === b;
  }
  return JSON.stringify(a) === JSON.stringify(b);
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
  return validateAgainstSchema(key, rawValue);
}

/**
 * Validate + coerce a single WRITABLE value (runtime OR restart tier) before
 * persisting. Rejects secret keys and any key that is not writable from the
 * admin UI (`readonly`/unknown). Used by the router's PUT + preset/reset paths.
 */
export function validateConfigWrite(
  key: string,
  rawValue: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!isRuntimeKey(key) && !isRestartKey(key)) {
    return { ok: false, error: `"${key}" is not editable` };
  }
  return validateAgainstSchema(key, rawValue);
}

function validateAgainstSchema(
  key: string,
  rawValue: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
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
