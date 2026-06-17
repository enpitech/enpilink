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

  // --- End-user auth (A1, resource-server foundation) ---
  /**
   * Master switch for end-user OAuth on `/mcp`. Off by default so existing
   * no-auth apps are completely unaffected. When on, a bearer-auth guard is
   * installed in front of `/mcp` and RFC 9728 Protected Resource Metadata is
   * served. Bootstrap (env/file only) so it can't be toggled at runtime.
   */
  "auth.enabled": z.boolean().default(false),
  /**
   * The OAuth Authorization Server issuer URL. Listed in the PRM
   * `authorization_servers[]` and used as the expected `iss` of inbound JWTs.
   * In A2 enpilink co-hosts the AS; for A1 this points at whatever AS issues
   * tokens (configurable).
   */
  "auth.issuer": z.string().optional(),
  /**
   * The RFC 8707 audience this resource server accepts (the `aud` claim
   * inbound tokens must carry). Usually the public `/mcp` URL. Prevents
   * confused-deputy token reuse across resources.
   */
  "auth.audience": z.string().optional(),
  /**
   * The JWKS URL used to fetch the AS's public signing keys for JWT signature
   * verification. Required for the built-in JWT verifier (A1). A2's proxy AS
   * may inject its own verifier instead.
   */
  "auth.jwksUrl": z.string().optional(),
  /**
   * SECRET — the token signing key (A3). When set (alongside an upstream IdP),
   * enpilink becomes a FEDERATING Authorization Server that mints + signs its
   * own tokens (Ed25519 keypair derived from this key) and enables guest mode +
   * lazy/step-up auth. When unset, enpilink stays in A2 transparent-proxy mode
   * (upstream-issued tokens). Env-only, never persisted to the DB nor returned
   * in plaintext.
   */
  "auth.signingKey": z.string().optional(),
  /**
   * SECRET — the OAuth client secret for the upstream IdP (used in A2's proxy
   * AS). Env-only, never persisted to the DB nor returned in plaintext.
   */
  "auth.clientSecret": z.string().optional(),

  // --- Upstream IdP for the co-hosted proxy Authorization Server (A2) ---
  /**
   * The OAuth client id registered with the upstream IdP (NON-secret). Required
   * to co-host the AS; when set (with the authorize/token URLs) enpilink mounts
   * `mcpAuthRouter` + a branded login page and proxies the flow upstream.
   */
  "auth.upstream.clientId": z.string().optional(),
  /** Upstream provider's authorization endpoint URL. */
  "auth.upstream.authorizationUrl": z.string().optional(),
  /** Upstream provider's token endpoint URL. */
  "auth.upstream.tokenUrl": z.string().optional(),
  /** Optional upstream provider token revocation endpoint URL. */
  "auth.upstream.revocationUrl": z.string().optional(),
  /** Space-delimited scopes requested from the upstream provider. */
  "auth.upstream.scopes": z.string().optional(),
  /**
   * Comma/space-delimited redirect URIs the host (OAuth client) may use — e.g.
   * the ChatGPT/Claude connector callback URLs. Validated by the AS against the
   * inbound `redirect_uri`.
   */
  "auth.redirectUris": z.string().optional(),
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

/**
 * Editability classification, surfaced to the admin UI:
 * - `runtime`  — editable live; takes effect immediately.
 * - `restart`  — DB-editable but only takes effect after a process restart
 *   (the non-secret bootstrap keys `port`/`storage`/`dbPath`).
 * - `readonly` — env-only; never web-editable (the `admin` gate + the
 *   `adminAuthToken` secret).
 */
export type Editable = "runtime" | "restart" | "readonly";

/** Per-key metadata describing tier / secret / env-lock + UI presentation. */
export interface KeyMeta {
  key: ConfigKey;
  /** `bootstrap` (env/file only) or `runtime` (DB-editable). */
  tier: "bootstrap" | "runtime";
  /** Secret keys are env-only and NEVER persisted/returned in plaintext. */
  secret: boolean;
  /** The env var that drives this key (for the "set via env" hint). */
  env: string;
  /** Human-friendly label (primary heading in the UI). */
  label: string;
  /** One-line plain-language description of what the setting does. */
  description: string;
  /** Functional category used to group settings in the UI. */
  group: string;
  /** Optional unit hint (e.g. `"ms"`, `"events"`, `"0–1 ratio"`). */
  unit?: string;
  /** The schema default value for this key. */
  default: unknown;
  /** How this key may be edited from the admin UI. */
  editable: Editable;
}

/**
 * Per-key UI/editability descriptors. `label`/`description`/`group`/`unit` are
 * user-facing — kept clear and non-jargon. `editable` drives the three-tier
 * editability story (runtime live · restart-required · env-only read-only).
 */
interface KeyDescriptor {
  label: string;
  description: string;
  group: string;
  unit?: string;
  editable: Editable;
}

const KEY_DESCRIPTORS: Record<ConfigKey, KeyDescriptor> = {
  // --- Server (restart-tier bootstrap) ---
  port: {
    label: "Server port",
    description:
      "The network port the server listens on. Changing this needs a restart to take effect.",
    group: "Server",
    editable: "restart",
  },
  storage: {
    label: "Storage engine",
    description:
      "Where analytics, logs, and settings are persisted: in-memory (resets on restart), sqlite (a local file), or postgres. Takes effect after a restart.",
    group: "Storage",
    editable: "restart",
  },
  dbPath: {
    label: "SQLite database file",
    description:
      "Path to the SQLite database file (only used when the storage engine is sqlite). Takes effect after a restart.",
    group: "Storage",
    editable: "restart",
  },
  // --- Security (read-only, env-only) ---
  admin: {
    label: "Production admin plane",
    description:
      "Enables the admin dashboard in production. For safety this can only be turned on via environment variable, never from the web UI.",
    group: "Security",
    editable: "readonly",
  },
  adminAuthToken: {
    label: "Admin auth token",
    description:
      "Secret bearer token guarding the production admin plane. Set via environment only; never stored or shown in plaintext.",
    group: "Security",
    editable: "readonly",
  },
  "auth.enabled": {
    label: "End-user auth",
    description:
      "Require end users to sign in via OAuth before calling protected tools on /mcp. Off by default; enable only via environment/file. When off, /mcp stays open exactly as before.",
    group: "Security",
    editable: "readonly",
  },
  "auth.issuer": {
    label: "OAuth issuer",
    description:
      "The authorization server issuer URL advertised in the protected-resource metadata and required as the token issuer (iss).",
    group: "Security",
    editable: "readonly",
  },
  "auth.audience": {
    label: "OAuth audience",
    description:
      "The audience (aud) inbound access tokens must be bound to — typically this server's public /mcp URL. Prevents tokens minted for another resource from being replayed here.",
    group: "Security",
    editable: "readonly",
  },
  "auth.jwksUrl": {
    label: "JWKS URL",
    description:
      "URL of the authorization server's JSON Web Key Set, used to verify token signatures.",
    group: "Security",
    editable: "readonly",
  },
  "auth.signingKey": {
    label: "Token signing key",
    description:
      "Secret key that signs the tokens enpilink mints when it acts as a federating Authorization Server (enables guest mode + lazy/step-up). Set via environment only; never stored or shown in plaintext.",
    group: "Security",
    editable: "readonly",
  },
  "auth.clientSecret": {
    label: "Upstream client secret",
    description:
      "Secret OAuth client secret for the upstream identity provider. Set via environment only; never stored or shown in plaintext.",
    group: "Security",
    editable: "readonly",
  },
  "auth.upstream.clientId": {
    label: "Upstream client id",
    description:
      "The OAuth client id registered with the upstream identity provider. Enables the co-hosted authorization server when set with the authorize/token URLs.",
    group: "Security",
    editable: "readonly",
  },
  "auth.upstream.authorizationUrl": {
    label: "Upstream authorize URL",
    description:
      "The upstream identity provider's OAuth authorization endpoint the login flow redirects to.",
    group: "Security",
    editable: "readonly",
  },
  "auth.upstream.tokenUrl": {
    label: "Upstream token URL",
    description:
      "The upstream identity provider's OAuth token endpoint used to exchange the authorization code.",
    group: "Security",
    editable: "readonly",
  },
  "auth.upstream.revocationUrl": {
    label: "Upstream revoke URL",
    description:
      "Optional upstream identity provider token revocation endpoint.",
    group: "Security",
    editable: "readonly",
  },
  "auth.upstream.scopes": {
    label: "Upstream scopes",
    description:
      "Space-delimited scopes requested from the upstream identity provider during login.",
    group: "Security",
    editable: "readonly",
  },
  "auth.redirectUris": {
    label: "Allowed redirect URIs",
    description:
      "Comma- or space-delimited redirect URIs the OAuth client (host connector) is allowed to use, e.g. the ChatGPT/Claude callback URLs.",
    group: "Security",
    editable: "readonly",
  },
  // --- Analytics (runtime) ---
  "analytics.enabled": {
    label: "Analytics enabled",
    description:
      "Record tool-call events and server logs so the dashboard can show usage and latency.",
    group: "Analytics",
    editable: "runtime",
  },
  "analytics.sampleRate": {
    label: "Sampling rate",
    description:
      "Fraction of requests to record. 1 records everything; lower values reduce overhead and storage on busy servers.",
    group: "Analytics",
    unit: "0–1 ratio",
    editable: "runtime",
  },
  // --- Retention (runtime) ---
  "retention.events": {
    label: "Event retention",
    description:
      "Maximum number of tool-call events kept. Oldest events are dropped once the cap is reached.",
    group: "Retention",
    unit: "events",
    editable: "runtime",
  },
  "retention.logs": {
    label: "Log retention",
    description:
      "Maximum number of captured log lines kept. Oldest logs are dropped once the cap is reached.",
    group: "Retention",
    unit: "logs",
    editable: "runtime",
  },
  // --- Features (runtime) ---
  "flags.liveLogs": {
    label: "Live log stream",
    description:
      "Show the real-time server log stream in the dashboard's live-logs panel.",
    group: "Features",
    editable: "runtime",
  },
  // --- Display (runtime) ---
  "display.bucketMs": {
    label: "Chart time bucket",
    description:
      "Default width of each time bucket in the dashboard's volume/latency charts.",
    group: "Display",
    unit: "ms",
    editable: "runtime",
  },
};

/** Bootstrap keys (env/file only). */
export const BOOTSTRAP_KEYS = [
  "storage",
  "dbPath",
  "port",
  "admin",
  "adminAuthToken",
  "auth.enabled",
  "auth.issuer",
  "auth.audience",
  "auth.jwksUrl",
  "auth.signingKey",
  "auth.clientSecret",
  "auth.upstream.clientId",
  "auth.upstream.authorizationUrl",
  "auth.upstream.tokenUrl",
  "auth.upstream.revocationUrl",
  "auth.upstream.scopes",
  "auth.redirectUris",
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
  "auth.signingKey",
  "auth.clientSecret",
] as const satisfies readonly ConfigKey[];

/**
 * Restart-tier keys: non-secret bootstrap keys that ARE DB-editable but only
 * take effect after a process restart. Resolution still honours env>file>db so
 * an env/file pin locks them (read-only).
 */
export const RESTART_KEYS = [
  "port",
  "storage",
  "dbPath",
] as const satisfies readonly BootstrapKey[];

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
  "auth.enabled": "ENPILINK_AUTH",
  "auth.issuer": "ENPILINK_AUTH_ISSUER",
  "auth.audience": "ENPILINK_AUTH_AUDIENCE",
  "auth.jwksUrl": "ENPILINK_AUTH_JWKS_URL",
  "auth.signingKey": "ENPILINK_AUTH_SIGNING_KEY",
  "auth.clientSecret": "ENPILINK_AUTH_CLIENT_SECRET",
  "auth.upstream.clientId": "ENPILINK_AUTH_UPSTREAM_CLIENT_ID",
  "auth.upstream.authorizationUrl": "ENPILINK_AUTH_UPSTREAM_AUTHORIZATION_URL",
  "auth.upstream.tokenUrl": "ENPILINK_AUTH_UPSTREAM_TOKEN_URL",
  "auth.upstream.revocationUrl": "ENPILINK_AUTH_UPSTREAM_REVOCATION_URL",
  "auth.upstream.scopes": "ENPILINK_AUTH_UPSTREAM_SCOPES",
  "auth.redirectUris": "ENPILINK_AUTH_REDIRECT_URIS",
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
const RESTART_SET = new Set<string>(RESTART_KEYS);

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
/** A restart-tier key: DB-editable but only effective after a restart. */
export function isRestartKey(key: string): key is BootstrapKey {
  return RESTART_SET.has(key);
}

/**
 * The editability classification for a key:
 * - secret/admin → `readonly` (env-only, never web-editable)
 * - other bootstrap keys (port/storage/dbPath) → `restart`
 * - runtime keys → `runtime`
 */
export function editableOf(key: ConfigKey): Editable {
  if (isRestartKey(key)) {
    return "restart";
  }
  if (isBootstrapKey(key)) {
    return "readonly";
  }
  return "runtime";
}

/** Default-typed sample used to read each key's schema default. */
const DEFAULTS = configSchema.parse({}) as Record<string, unknown>;

/** The schema default value for a key (undefined for optional secrets). */
export function defaultForKey(key: ConfigKey): unknown {
  return DEFAULTS[key];
}

/** Metadata for every known key. */
export function keyMeta(key: ConfigKey): KeyMeta {
  const d = KEY_DESCRIPTORS[key];
  return {
    key,
    tier: isBootstrapKey(key) ? "bootstrap" : "runtime",
    secret: isSecretKey(key),
    env: ENV_VARS[key],
    label: d.label,
    description: d.description,
    group: d.group,
    unit: d.unit,
    default: defaultForKey(key),
    editable: d.editable,
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
