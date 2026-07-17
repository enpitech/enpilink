/**
 * Storage layer types for enpilink's admin / observability / config plane.
 *
 * The {@link StorageAdapter} is the single pluggable persistence surface used by
 * analytics (events), log capture (logs), and the config/admin layer (config +
 * audit). Built-in adapters: `memory` (dev default, zero deps) and `sqlite`
 * (prod default, embedded). Custom adapters register via
 * `registerStorageAdapter`.
 */

/**
 * A single analytics event. Emitted (in M2) by the analytics middleware for
 * each MCP request — most commonly a `tool_call`. `type` is open-ended so other
 * event kinds can be recorded without a schema change.
 */
export interface AnalyticsEvent {
  /** Unix epoch milliseconds when the event occurred. */
  ts: number;
  /** Event kind. `"tool_call"` is the built-in, but any string is allowed. */
  type: "tool_call" | string;
  /** Tool name (for `tools/call`), from `params.name`. */
  tool?: string;
  /** MCP method, e.g. `"tools/call"`. */
  method?: string;
  /** Duration of the call in milliseconds. */
  ms?: number;
  /** Whether the call succeeded (false when the result was an error). */
  ok?: boolean;
  /** Error message, when the call failed. */
  error?: string;
  /** Arbitrary extra structured data. */
  meta?: Record<string, unknown>;
}

/** A captured server log line. */
export interface LogEntry {
  /** Unix epoch milliseconds. */
  ts: number;
  /** Log severity. */
  level: "debug" | "info" | "warning" | "error";
  /** The log message. */
  msg: string;
  /** Optional structured payload. */
  data?: unknown;
}

/** Filter for {@link StorageAdapter.queryEvents}. */
export interface EventQuery {
  /** Only events with `ts >= since` (epoch ms). */
  since?: number;
  /** Only events whose `type` matches. */
  type?: string;
  /** Only events whose `tool` matches. */
  tool?: string;
  /** Maximum number of events returned (most recent first). */
  limit?: number;
}

/** Filter for {@link StorageAdapter.queryLogs}. */
export interface LogQuery {
  /** Only logs with `ts >= since` (epoch ms). */
  since?: number;
  /** Only logs whose `level` matches. */
  level?: string;
  /** Maximum number of logs returned (most recent first). */
  limit?: number;
}

/**
 * A single raw HTTP header, as `[name, value]` — preserving the ORIGINAL casing
 * and, across the array, the original wire ORDER. Both are load-bearing agent
 * fingerprint signals (a real Chrome sends `sec-ch-ua` lowercase; a disguised
 * library title-cases it to `Sec-Ch-Ua`), so this MUST come from Node's
 * `req.rawHeaders`, never `req.headers` (which lowercases, de-dupes and
 * re-orders). See `server/agent/`.
 */
export type HeaderPair = [name: string, value: string];

/**
 * Outcome class of a request, derived purely from its HTTP status (S3 in the
 * architecture — zero config, always available):
 * - `resolved` — 2xx/3xx (and any other non-error status);
 * - `dead_end` — 404 / 410 (the ~35% agent-404 signal);
 * - `blocked` — 401 / 403 / 429 (auth/rate-limit walls);
 * - `broken`  — 5xx (the site's own bug).
 */
export type AgentOutcome = "resolved" | "dead_end" | "blocked" | "broken";

/**
 * Recognition confidence tier for an agent-attributed request, produced by the
 * M2 detection engine and rendered honestly so a verified-IP hit and an
 * unverified UA string never carry equal weight (a dashboard that shows them
 * with the same weight is lying to the customer — CONTEXT §3). Ordered strongest
 * → weakest:
 * - `crypto`      — Web Bot Auth / RFC 9421 signature verified. RESERVED: M2
 *   ships no signature verifier, so nothing emits this yet; kept so M3+ can.
 * - `ip-verified` — the UA names a vendor AND the client IP falls inside that
 *   vendor's published IP range (the optional IP tier, `agent.verifyIpRanges`).
 * - `ua+shape`    — named by the UA AND the request SHAPE corroborates the claim
 *   (e.g. `ChatGPT-User` with no `Sec-Fetch-*` + an `X-Envoy-*` header).
 * - `shape`       — classified by request shape ALONE — the UA was absent,
 *   spoofed, or disguised (e.g. Claude's Chrome disguise, caught by title-cased
 *   client hints; or "no `Sec-Fetch-*` → not a browser").
 * - `ua-only`     — named purely by an unverified, spoofable UA string.
 * - `none`        — unclassified (the pre-detection default, or an empty request).
 */
export type AgentConfidence =
  | "crypto"
  | "ip-verified"
  | "ua+shape"
  | "shape"
  | "ua-only"
  | "none";

/**
 * Behavioural taxonomy of a detected client — the axis that predicts what the
 * client can and will do (HOW-AGENTS-READ-PAGES §1: "it is not the vendor, it is
 * the mode"). This is what M3 routing switches on. Produced by the M2 classifier
 * ({@link classify} in `server/agent/detect.ts`); stored in `agent_class`.
 * - `crawler`          — a bulk training/indexing crawler (GPTBot, ClaudeBot,
 *   PerplexityBot, Googlebot, Bytespider). NOTE: Googlebot/search indexers must
 *   ALWAYS get the normal page (the cloaking guardrail lives at the M3 boundary).
 * - `chat-fetcher`     — a one-shot on-demand fetcher answering a user's question
 *   NOW (ChatGPT-User, Gemini, Claude-User, Perplexity-User). Makes exactly one
 *   request — the first response is the entire product.
 * - `agent-mode`       — a multi-fetch vendor-hosted agent harness. RESERVED: a
 *   single request's shape can't distinguish work-mode from chat-mode, so M2's
 *   shape pass never emits this; it needs a signed/crypto signal (M3+).
 * - `browser-agent`    — an on-device browser agent, POSITIVELY identified.
 *   RESERVED: by shape alone it is indistinguishable from a human, so M2 reports
 *   `human-or-browser`; a positive id needs a signature.
 * - `cli`              — a coding-agent CLI (Claude Code, Codex, …).
 * - `tool`             — a plain HTTP client / scraper (curl, wget,
 *   python-requests, axios, …).
 * - `human-or-browser` — a real browser SHAPE: a human OR an on-device browser
 *   agent. The two are byte-for-byte indistinguishable; we say so, we do not
 *   pretend to separate them.
 * - `unknown`          — could not be attributed (surfaced for corpus growth).
 */
export type AgentClass =
  | "crawler"
  | "chat-fetcher"
  | "agent-mode"
  | "browser-agent"
  | "cli"
  | "tool"
  | "human-or-browser"
  | "unknown";

/**
 * One captured agent-attributed HTTP request — the hot row of the agent surface.
 * Written to the `agent_requests` table (NEVER the `events` table, which the MCP
 * dashboard reads unfiltered). M1 populates the request + fingerprint columns;
 * the detection/session columns (`agentFamily`/`agentClass`/`confidence`/
 * `sessionId`/`taskToken`) are present now but only filled by later milestones,
 * so no column has to be ALTERed onto an existing DB later.
 *
 * Privacy: NEVER holds a raw client IP. {@link ipHash} is `SHA-256(salt + ip)`
 * with a per-site salt — the same one-way discipline as {@link AuthSession.tokenRef}.
 */
export interface AgentRequestRecord {
  /** Unix epoch milliseconds when the request started. */
  ts: number;
  /** The site this request belongs to (per-site salt + scoping). */
  siteId: string;
  /** HTTP method (`GET`, `POST`, …), original casing. */
  method: string;
  /** Request path (pathname only — no query string). */
  path: string;
  /** Final HTTP status code. */
  status: number;
  /** Outcome class derived from {@link status}. */
  outcome: AgentOutcome;
  /** HTTP version string (`"1.1"`, `"2.0"`) — an HTTP-fingerprint signal. */
  httpVersion: string;
  /**
   * Raw header pairs, original order AND casing — the primary fingerprint. The
   * VALUES of IP-bearing headers (`x-forwarded-for`, `cf-connecting-ip`, …) are
   * redacted to `[redacted]` (name kept) so no raw client IP is ever persisted
   * here — the only IP we store is the salted {@link ipHash}. On the edge path
   * (Web `Headers`) names are lowercased and order is sorted (a documented
   * fidelity loss vs the Node path's `req.rawHeaders`).
   */
  headers: HeaderPair[];
  /** `SHA-256(site salt + client IP)`. NEVER the raw IP. Absent if unknown. */
  ipHash?: string;
  /** The `User-Agent` value (verbatim), when present. */
  ua?: string;
  /** The `Referer` value, when present. */
  referer?: string;
  /** Duration from receipt to response finish, in milliseconds. */
  ms?: number;
  /** Named vendor/client (`gptbot`, `chatgpt-user`, `claude-web`, …), or unset
   * when unnamed. Filled by M2. */
  agentFamily?: string;
  /** Behavioural taxonomy class ({@link AgentClass}) — filled by M2. */
  agentClass?: AgentClass;
  /** Recognition confidence — defaults to `none` until M2 classifies. */
  confidence?: AgentConfidence;
  /** Correlated session id — NULL for the unsessionable majority (M5). */
  sessionId?: string;
  /** Task-correlation token (C2), when present (M9). */
  taskToken?: string;
  /**
   * Whether the routing layer served the self-sufficient agent representation for
   * THIS request (instead of the normal page). Set true only when served; absent
   * otherwise. Filled from `res.locals.enpilinkAgentServed` by (a) the M3.5
   * 404-rescue (paired with `outcome = "dead_end"` — a rescued would-be-404), or
   * (b) the M6 SPA-replace of a 200 shell (paired with `outcome = "resolved"` and
   * `meta.spa = true`). Segmenting served-vs-not is the confabulation-gap headline
   * (F-1). Note: `served ∩ dead_end` (the rescued segment) is NOT the same as
   * `served ∩ resolved` (the SPA segment); a consumer must split by outcome.
   */
  served?: boolean;
  /** Which encoding M3 served, when {@link served}. From M3's decision. */
  servedEncoding?: "markdown" | "html";
  /** Arbitrary extra structured data. */
  meta?: Record<string, unknown>;
}

/** Filter for {@link StorageAdapter.queryAgentRequests}. */
export interface AgentRequestQuery {
  /** Only requests with `ts >= since` (epoch ms). */
  since?: number;
  /** Only requests with `ts < until` (epoch ms). */
  until?: number;
  /** Only requests for this site. */
  siteId?: string;
  /**
   * Only requests whose {@link AgentRequestRecord.agentClass} is in this set.
   * Session correlation (M4) queries ONLY the correlatable classes so it never
   * pulls the full (potentially huge) human/agent row set into JS.
   */
  classes?: string[];
  /** Maximum rows returned (most recent first). */
  limit?: number;
}

/**
 * A pre-grouped outcome count — the minimal aggregation unit the M4 telemetry
 * read API folds into its histograms. Produced DB-side by
 * {@link StorageAdapter.aggregateAgentOutcomes} (a `GROUP BY`, so the dashboard
 * never pulls raw rows into JS the way the MCP `/summary` does) and, identically,
 * by grouping records in JS for the pure table tests. The grouping keys are all
 * low-cardinality, so the number of groups is bounded (outcomes × families ×
 * classes × methods × served) regardless of request volume.
 */
export interface AgentOutcomeGroup {
  /** The status-derived outcome class for the group. */
  outcome: AgentOutcome;
  /** Named vendor/client, or `null` when unnamed. */
  agentFamily: string | null;
  /** Behavioural taxonomy class, or `null` when unset. */
  agentClass: AgentClass | null;
  /** HTTP method (original casing) — write-attempt is derived from this. */
  method: string;
  /** Whether M3 served the representation for the requests in this group. */
  served: boolean;
  /** Number of requests in the group. */
  count: number;
}

/**
 * A site the agent surface captures for. Holds the per-site {@link ipSalt} used
 * to one-way-hash client IPs so hashes are neither reversible nor cross-site
 * joinable.
 */
export interface AgentSiteRecord {
  /** Stable site id. */
  id: string;
  /** Human-facing origin (e.g. `https://acme.com`), when known. */
  origin?: string;
  /** Per-site salt for {@link AgentRequestRecord.ipHash}. */
  ipSalt: string;
  /** When the site row was created (epoch ms). */
  createdAt: number;
}

/** Options for {@link StorageAdapter.prune}. */
export interface PruneOptions {
  /** Delete captured agent requests with `ts < before` (epoch ms). */
  before: number;
}

/**
 * Pluggable persistence interface backing the observability + config plane.
 *
 * Implementations MUST:
 * - treat config values as opaque (no special-casing of keys/secrets);
 * - write a `config_audit` entry on every {@link setConfig} call;
 * - return query results most-recent-first.
 */
export interface StorageAdapter {
  /** Open connections / create schema. Safe to call once before use. */
  init(): Promise<void>;
  /** Record an analytics event. Must never throw into the caller's hot path. */
  recordEvent(e: AnalyticsEvent): Promise<void>;
  /** Query events, most recent first. */
  queryEvents(f: EventQuery): Promise<AnalyticsEvent[]>;
  /** Append a captured log line. */
  appendLog(l: LogEntry): Promise<void>;
  /** Query logs, most recent first. */
  queryLogs(f: LogQuery): Promise<LogEntry[]>;
  /** Read a single config value (or `undefined` if unset). */
  getConfig(key: string): Promise<unknown>;
  /** Write a config value AND append a `config_audit` row (old → new). */
  setConfig(key: string, value: unknown, actor?: string): Promise<void>;
  /**
   * Remove a config override (reset to default) AND append a `config_audit`
   * row (old → undefined). A no-op when the key was not set. After clearing,
   * config resolution falls back to file/env/default for the key.
   */
  clearConfig(key: string, actor?: string): Promise<void>;
  /** Read all config as a plain object. */
  allConfig(): Promise<Record<string, unknown>>;
  /**
   * Read the config-change audit trail, most recent first. Surfaces the
   * `config_audit` rows that {@link setConfig} writes, for the admin UI's
   * change history.
   */
  getConfigAudit(): Promise<ConfigAuditEntry[]>;

  // --- End-user auth tracking (A2). Optional so custom adapters predating A2
  // keep working; the auth path feature-detects and swallows when absent. ---

  /**
   * Insert-or-update a tracked user by `sub`. On first sight sets
   * `createdAt`; always bumps `lastSeenAt`. Implementations MUST treat the
   * write as best-effort (the auth path swallows failures, like analytics).
   */
  upsertUser?(user: AuthUser): Promise<void>;
  /**
   * Record (or refresh) an auth session. Keyed by {@link AuthSession.id}; a
   * repeat for the same id bumps `lastSeenAt` rather than duplicating.
   */
  recordSession?(session: AuthSession): Promise<void>;
  /** Read a single session by id (or `undefined`). */
  getSession?(id: string): Promise<AuthSession | undefined>;
  /** List sessions, most recent first. */
  listSessions?(q?: SessionQuery): Promise<AuthSession[]>;
  /** List tracked users, most recently seen first. */
  listUsers?(q?: SessionQuery): Promise<AuthUser[]>;
  /**
   * Delete a single session by id (A5 revoke). A no-op when the id is unknown.
   * Optional so custom adapters predating A5 keep working; the auth tab
   * feature-detects and reports "revoke unsupported" when absent.
   */
  deleteSession?(id: string): Promise<void>;
  /**
   * Delete a tracked user by `sub` AND all of their sessions (A5 revoke). A
   * no-op when the `sub` is unknown. Optional, like {@link deleteSession}.
   */
  deleteUser?(sub: string): Promise<void>;

  // --- Agent surface capture (M1). Optional so custom adapters predating the
  // agent surface keep compiling; the capture path feature-detects and swallows
  // when absent (exactly like the auth methods above). ---

  /**
   * Batch-insert captured agent requests. Called by the bounded write buffer,
   * off the request hot path. MUST never throw into the caller (best-effort,
   * like {@link recordEvent}); the buffer additionally swallows failures.
   */
  recordAgentRequests?(records: AgentRequestRecord[]): Promise<void>;
  /** Query captured agent requests, most recent first. */
  queryAgentRequests?(q?: AgentRequestQuery): Promise<AgentRequestRecord[]>;
  /**
   * Aggregate captured agent requests into {@link AgentOutcomeGroup} counts with
   * a DB-side `GROUP BY` — the scalable path the M4 telemetry summary uses for
   * its outcome / dead-end / served-segment histograms, so a high-volume site is
   * never summarised by pulling every row into JS. Optional so custom adapters
   * predating M4 keep compiling; the read API feature-detects and falls back to a
   * bounded {@link queryAgentRequests} + in-JS grouping when it is absent.
   */
  aggregateAgentOutcomes?(q?: AgentRequestQuery): Promise<AgentOutcomeGroup[]>;
  /**
   * Get-or-create a site row, returning the EFFECTIVE record. If a row for
   * `site.id` already exists its stored salt is kept (so IP hashes stay stable
   * across restarts); otherwise `site` is inserted and returned.
   */
  ensureAgentSite?(site: AgentSiteRecord): Promise<AgentSiteRecord>;
  /**
   * Delete captured agent requests past a retention boundary and return the
   * number of rows removed. This is REAL retention — unlike the decorative
   * `retention.events` / `retention.logs` config, which no adapter enforces.
   */
  prune?(opts: PruneOptions): Promise<number>;

  /** Release resources / close connections. */
  close(): Promise<void>;
}

/**
 * A tracked end-user, keyed by the stable OAuth `sub` claim (A2).
 *
 * Recorded the first time a valid token for a `sub` is seen, and refreshed on
 * every subsequent authenticated request. Holds NO secrets — never the raw
 * upstream access/refresh token (see {@link AuthSession.tokenRef}).
 */
export interface AuthUser {
  /** Stable per-user id — the OAuth `sub` claim. The primary tracking key. */
  sub: string;
  /** The Authorization Server / upstream issuer that vouched for this user. */
  issuer?: string;
  /** First time we saw this user (epoch ms). */
  createdAt: number;
  /** Most recent time we saw this user (epoch ms). */
  lastSeenAt: number;
  /** Optional display fields lifted from non-secret token claims. */
  email?: string;
  name?: string;
  /**
   * Whether this is a guest (A3): a coarsely-tracked anonymous user with a
   * limited token. Derived from the `guest:` {@link GUEST_SUB_PREFIX} on `sub`
   * (so it is computed on read — no DB migration needed). Real upstream users
   * are `false`.
   */
  isGuest?: boolean;
}

/**
 * Namespace prefix for guest subjects (A3). Guests get a `sub` of
 * `guest:<random-id>` so their tracking key can NEVER collide with a real
 * upstream `sub`, and so any consumer can distinguish a guest by prefix.
 */
export const GUEST_SUB_PREFIX = "guest:";

/** Whether a `sub` belongs to a guest (A3) — i.e. carries the guest prefix. */
export function isGuestSub(sub: string | undefined): boolean {
  return typeof sub === "string" && sub.startsWith(GUEST_SUB_PREFIX);
}

/**
 * A recorded authentication session for a user (A2).
 *
 * Written at successful auth (and refreshed on re-auth). Tokens-at-rest model:
 * we store an **opaque reference** ({@link tokenRef}, a one-way hash) to the
 * upstream token — NEVER the raw token, access secret, or refresh token. This
 * lets us correlate/track sessions without holding a credential at rest.
 */
export interface AuthSession {
  /** Session id (stable hash of the token reference). */
  id: string;
  /** The user this session belongs to (the `sub`). */
  sub: string;
  /** The issuer that minted the token. */
  issuer?: string;
  /** OAuth client id (the host/connector that brokered the flow). */
  clientId?: string;
  /**
   * An opaque, one-way reference to the upstream token (a SHA-256 hash) — used
   * only to de-duplicate/correlate sessions. NEVER the raw token. May be
   * absent when no token reference is available.
   */
  tokenRef?: string;
  /** Granted scopes (space-joined for storage). */
  scopes?: string[];
  /** When the session was first recorded (epoch ms). */
  createdAt: number;
  /** When the session was last refreshed (epoch ms). */
  lastSeenAt: number;
  /** Upstream token expiry (epoch seconds), when known. */
  expiresAt?: number;
  /**
   * Whether this is a guest session (A3). Derived from the `guest:`
   * {@link GUEST_SUB_PREFIX} on `sub` (computed on read — no DB migration).
   * Lets the Auth tab (A5) distinguish guests from authenticated users.
   */
  isGuest?: boolean;
}

/** Filter for {@link StorageAdapter.listSessions} / {@link StorageAdapter.listUsers}. */
export interface SessionQuery {
  /** Only sessions/users for this `sub`. */
  sub?: string;
  /** Maximum rows returned (most recent first). */
  limit?: number;
}

/** A single config-change audit record. */
export interface ConfigAuditEntry {
  /** Unix epoch milliseconds. */
  ts: number;
  /** Config key that changed. */
  key: string;
  /** Previous value (JSON-serializable), or `undefined` if newly set. */
  oldValue: unknown;
  /** New value (JSON-serializable). */
  newValue: unknown;
  /** Who made the change (defaults to `"system"`). */
  actor: string;
}

/** Options passed to a storage adapter factory. */
export interface StorageAdapterOptions {
  /** Ring-buffer capacity (memory) — max events/logs retained. */
  cap?: number;
  /** Database path (sqlite). */
  path?: string;
}

/** Factory signature for {@link registerStorageAdapter}. */
export type StorageAdapterFactory = (
  opts?: StorageAdapterOptions,
) => StorageAdapter;
