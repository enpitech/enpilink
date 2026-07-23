import crypto from "node:crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { resolveConfig } from "../config/index.js";
import { getActiveStorage } from "../log-sink.js";
import type { AgentRequestRecord, StorageAdapter } from "../storage/types.js";
import { getAgentCaptureGate } from "./capture-gate.js";

/**
 * The beacon SINK (M8) — the Node-side counterpart to the `enpilink/next` edge
 * middleware. Next.js middleware runs on the edge runtime and cannot write to a
 * `StorageAdapter` (no `better-sqlite3`, no `fs`), so it POSTs batches of
 * captured records to THIS endpoint, which runs in a full Node enpilink server
 * and persists them via the existing {@link StorageAdapter.recordAgentRequests}.
 *
 * ── THE GUARD MODEL ──────────────────────────────────────────────────────────
 * This endpoint ACCEPTS WRITES, so it is never an open write surface:
 * - It is **DISABLED unless `agent.ingestToken` (`ENPILINK_AGENT_INGEST_TOKEN`)
 *   is set.** With no token configured every request gets a `404` — as if the
 *   route were not mounted. This preserves off-by-default.
 * - With a token set, a request MUST present `Authorization: Bearer <token>`
 *   (constant-time compared, like the admin token). A missing/wrong token → 401.
 * - The token is a **separate shared secret from the admin token**, so an edge
 *   deployment can beacon WITHOUT holding the full admin credential. It is an
 *   env-only bootstrap secret (never persisted to the DB, never returned by the
 *   config API) — see `config/schema.ts`.
 *
 * ── DEGRADE-GRACEFULLY DISCIPLINE (copied from `telemetry.ts`) ────────────────
 * A bad-shaped batch → `400` (zod). Too many records → `413`. No storage → a
 * `200 { enabled:false }`. A storage write failure is swallowed (best-effort,
 * like every other capture write) and still answered `202` — the edge caller is
 * fire-and-forget and never reads the body. It NEVER 500s.
 */

/** Where the sink is mounted. Under `/__enpilink/agents/*` like the read API. */
export const INGEST_PATH = "/__enpilink/agents/ingest";

/** Hard cap on records per POST — a bounded batch, never an unbounded write. */
export const MAX_INGEST_BATCH = 100;

/** The four S3 outcome classes an edge record may carry. */
const OUTCOME_VALUES = ["resolved", "dead_end", "blocked", "broken"] as const;
/** The behavioural taxonomy classes an edge record may carry. */
const CLASS_VALUES = [
  "crawler",
  "chat-fetcher",
  "agent-mode",
  "browser-agent",
  "cli",
  "tool",
  "human-or-browser",
  "unknown",
] as const;
/** The confidence tiers an edge record may carry (incl. `pending` — an edge row
 * captured with no ruleset loaded, awaiting backfill). */
const CONFIDENCE_VALUES = [
  "crypto",
  "ip-verified",
  "ua+shape",
  "shape",
  "ua-only",
  "none",
  "pending",
] as const;

/** A single `[name, value]` header pair — a 2-string tuple off the wire. */
const headerPairSchema = z.tuple([z.string(), z.string()]);

/**
 * Validate one captured record off the wire. Mirrors {@link AgentRequestRecord}:
 * the request + fingerprint fields are required; detection/served/meta are
 * optional. Unknown top-level keys are stripped (zod's default), so a malformed
 * or hostile payload cannot smuggle fields into the insert. `meta` stays an open
 * record for the edge's `edge`/`statusUnknown` flags.
 */
const recordSchema = z.object({
  ts: z.number(),
  siteId: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number(),
  outcome: z.enum(OUTCOME_VALUES),
  httpVersion: z.string(),
  headers: z.array(headerPairSchema),
  ipHash: z.string().optional(),
  ua: z.string().optional(),
  referer: z.string().optional(),
  ms: z.number().optional(),
  agentFamily: z.string().optional(),
  agentClass: z.enum(CLASS_VALUES).optional(),
  confidence: z.enum(CONFIDENCE_VALUES).optional(),
  rulesetVersion: z.string().optional(),
  served: z.boolean().optional(),
  servedEncoding: z.enum(["markdown", "html"]).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** The ingest batch envelope: `{ records: [...] }`, bounded length. */
const batchSchema = z.object({
  records: z.array(recordSchema).max(MAX_INGEST_BATCH),
});

/** The parsed, validated batch. */
export type IngestBatch = z.infer<typeof batchSchema>;

/**
 * The raw ingest bearer token, read in-process from the resolved config
 * (env-only bootstrap secret). Empty/unset → `undefined`. Same discipline as
 * `admin.ts` `readAdminToken`.
 */
export async function readIngestToken(): Promise<string | undefined> {
  const { values } = await resolveConfig(null);
  const token = values["agent.ingestToken"];
  if (typeof token !== "string") {
    return undefined;
  }
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Constant-time bearer-token match (avoids leaking the token via timing). */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extract a bearer token from the `Authorization` header, or `null`. */
function bearerOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? (m[1] as string).trim() : null;
}

/** Options for {@link installAgentIngest} / {@link createAgentIngestHandler}. */
export interface AgentIngestOptions {
  /** Resolve the active storage at write time. Defaults to {@link getActiveStorage}. */
  getStorage?: () => StorageAdapter | null;
  /**
   * Resolve the current shared ingest token. Defaults to the live capture-gate
   * value (resolved from `agent.ingestToken`). `undefined`/empty ⇒ disabled.
   */
  getToken?: () => string | undefined;
}

/**
 * Build the POST handler for the beacon sink. Exposed for testing; production
 * mounts it via {@link installAgentIngest}.
 */
export function createAgentIngestHandler(
  opts: AgentIngestOptions = {},
): RequestHandler {
  const getStorage = opts.getStorage ?? getActiveStorage;
  const getToken = opts.getToken ?? (() => getAgentCaptureGate().ingestToken);

  return (req: Request, res: Response): void => {
    // (1) Disabled unless a token is configured — never an open write endpoint.
    const expected = getToken();
    if (!expected || expected.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // (2) Bearer required and must match (constant-time).
    const presented = bearerOf(req);
    if (!presented || !tokenMatches(presented, expected)) {
      res
        .status(401)
        .set("WWW-Authenticate", "Bearer")
        .json({ error: "unauthorized" });
      return;
    }
    // (3) Validate the batch shape (zod). Bad shape / oversize → 400 / 413.
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      const tooMany =
        Array.isArray((req.body as { records?: unknown[] })?.records) &&
        (req.body as { records: unknown[] }).records.length > MAX_INGEST_BATCH;
      res.status(tooMany ? 413 : 400).json({
        error: tooMany ? "batch_too_large" : "invalid_batch",
        max: MAX_INGEST_BATCH,
      });
      return;
    }
    const records = parsed.data.records as AgentRequestRecord[];

    // (4) No storage → degrade to a 200 disabled shape, never a 500.
    const storage = getStorage();
    if (!storage?.recordAgentRequests) {
      res.json({ enabled: false, accepted: 0 });
      return;
    }
    // (5) Fire-and-forget write, swallow failures (best-effort, like all
    //     capture writes). Answer 202 immediately — the edge never reads this.
    if (records.length > 0) {
      void (async () => {
        try {
          await storage.recordAgentRequests?.(records);
        } catch {
          // A storage failure must never surface; the batch is lost.
        }
      })();
    }
    res.status(202).json({ accepted: records.length });
  };
}

/**
 * Mount the beacon sink at {@link INGEST_PATH} on an Express app. Install it
 * EARLY (before the admin plane) so it owns its path and is guarded by the
 * ingest token — not the admin token. A cheap, self-contained handler; disabled
 * (404) until `agent.ingestToken` is configured.
 */
export function installAgentIngest(
  app: Express,
  opts: AgentIngestOptions = {},
): void {
  app.post(INGEST_PATH, createAgentIngestHandler(opts));
}
