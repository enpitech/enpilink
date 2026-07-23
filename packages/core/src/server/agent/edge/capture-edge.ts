import type { AgentRequestRecord, HeaderPair } from "../../storage/types.js";
import {
  type CaptureOutcome,
  type MinimalRequest,
  toCaptureRecord,
} from "../capture.js";
import { classify } from "../detect.js";
// TYPE-ONLY (erased): keeps the edge runtime graph free of the ruleset's zod
// schema — the ruleset VALUE is passed in by the caller, never imported here.
import type { Ruleset } from "../ruleset/types.js";

/**
 * Edge/Web-standard agent capture core (M8).
 *
 * The runtime-neutral counterpart to `express-middleware.ts`: it builds an
 * {@link AgentRequestRecord} from a **Web `Request`** (Next edge middleware, a
 * Cloudflare Worker, Hono's `c.req.raw`) using ONLY web-standard globals —
 * `Headers`, `crypto.subtle`, `TextEncoder`. It imports the SAME pure core the
 * Node path does (`capture.ts` `toCaptureRecord` + `detect.ts` `classify`), so
 * the record shape and the detection verdict are identical across runtimes. It
 * pulls in NO `node:*`, NO Express, NO storage adapter — that is what keeps the
 * `enpilink/next` entry edge-safe (verified by `next/edge-safety.test.ts`).
 *
 * ── WHAT THE EDGE CAN AND CANNOT SEE vs THE NODE PATH (read this) ─────────────
 * The Node/Express adapter reads `req.rawHeaders`, so it preserves the ORIGINAL
 * header order AND casing — the two best disguise signals (a real Chrome sends
 * `sec-ch-ua` lowercase; a disguised HTTP library title-cases it to `Sec-Ch-Ua`,
 * the marquee Claude tell). **A Web `Headers` object has neither**: iterating it
 * yields header names LOWERCASED and LEXICOGRAPHICALLY SORTED, with duplicates
 * comma-joined. So on the edge path:
 * - **Preserved:** which headers are present, their values, the header count →
 *   `hasSecFetch`, `hasClientHints`, `envoy`, `wantsMarkdown`, `zstdFirst`,
 *   `noCacheOnNav`, the platform-claim cross-check, and every UA-named family
 *   (`ChatGPT-User`, `Gemini`, `Claude-User`, `GPTBot`, `Googlebot`, …). These
 *   are the bulk of detection and they classify identically to the Node path.
 * - **Degraded:** header ORDER and CASING. `titleCasedClientHints` can never be
 *   true here, so Claude's Chrome-disguise fetcher is NOT caught by that tell on
 *   the edge — it falls through to `human-or-browser` by shape. Named-by-UA
 *   agents are unaffected.
 * - **Unavailable:** the HTTP version (`httpVersion` is recorded as `""`), the
 *   optional published-IP-range confidence tier (`ip-verified` — it needs a Node
 *   network cache), and — for a pass-through request — the DOWNSTREAM response
 *   status. Next edge middleware runs BEFORE the route resolves, so unless the
 *   middleware itself produces the response (redirect/rewrite/block/explicit),
 *   the final 200-vs-404 is decided downstream and is invisible here. See
 *   {@link EdgeCaptureOutcome} and `next/index.ts`.
 *
 * The authoritative OUTCOME/dead-end signal therefore remains the Node capture
 * path; the edge path's strength is DETECTION + the fingerprint corpus ("log
 * everything on every request"). Both are documented honestly, never papered over.
 */

/** IP headers checked in order — most authoritative first. Case-insensitive. */
const IP_HEADERS = [
  "cf-connecting-ip",
  "x-real-ip",
  "x-forwarded-for",
] as const;

/**
 * Resolve the client IP from a Web `Headers`, preferring Cloudflare's
 * authoritative `CF-Connecting-IP`, then `X-Real-IP`, then the FIRST hop of
 * `X-Forwarded-For` (the original client; the rest are proxies). Returns `null`
 * when nothing usable is present. NEVER returns anything that gets stored raw —
 * the caller hashes it (see {@link hashIpEdge}).
 */
export function resolveEdgeClientIp(headers: Headers): string | null {
  for (const name of IP_HEADERS) {
    const raw = headers.get(name);
    if (raw && raw.length > 0) {
      // X-Forwarded-For is a comma list: client, proxy1, proxy2. Take the first.
      const first = raw.split(",")[0]?.trim();
      if (first && first.length > 0) {
        return first;
      }
    }
  }
  return null;
}

/**
 * Hash a client IP with a per-deployment salt using `crypto.subtle` (SHA-256,
 * hex). Byte-compatible with the Node path's
 * `createHash("sha256").update(salt).update(":").update(ip)` — so with the SAME
 * salt an edge-captured hash equals a Node-captured one for the same IP. NEVER
 * returns or stores the raw IP.
 */
export async function hashIpEdge(ip: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The header pairs a Web `Headers` can expose — lowercased names, sorted order,
 * duplicates comma-joined. This is the fingerprint the edge path can capture;
 * its casing/order fidelity loss vs `req.rawHeaders` is documented above.
 */
export function edgeHeaderPairs(headers: Headers): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (const [name, value] of headers.entries()) {
    pairs.push([name, value]);
  }
  return pairs;
}

/** The response-side facts the edge adapter can observe. See {@link buildEdgeRecord}. */
export interface EdgeCaptureOutcome {
  /**
   * Final HTTP status, when the middleware KNOWS it — i.e. it produced the
   * response itself (redirect/rewrite/block/explicit `Response`). For a
   * pass-through (`NextResponse.next()` / no handler) the downstream status is
   * invisible to edge middleware, so pass `0`; the record is then marked
   * `meta.statusUnknown = true` and its outcome is a best-effort `resolved`
   * placeholder (the real outcome comes from the Node path). NEVER fabricated.
   */
  status: number;
  /** Epoch ms when the middleware started (the record's `ts`). */
  ts: number;
  /** Middleware execution duration in ms (NOT end-to-end page time). */
  ms: number;
  /**
   * When true, the request would otherwise have dead-ended (404/410) but the edge
   * SERVE layer rescued it with the representation. Records the PRE-rescue truth
   * (`outcome = "dead_end"`) even though a 200 was returned — see
   * {@link toCaptureRecord}. Set by the Cloudflare Worker adapter's serve path;
   * the Next capture-only path never sets it.
   */
  rescuedDeadEnd?: boolean;
}

/** Options for {@link buildEdgeRecord}. */
export interface BuildEdgeRecordOptions {
  /** Site id to attribute the capture to. */
  siteId: string;
  /**
   * Per-deployment salt for IP hashing. When absent, the IP is NOT hashed and
   * NOT sent (we never fall back to a raw IP). Provide the same salt as the
   * target site's stored salt if you want edge and Node hashes to be joinable.
   */
  ipSalt?: string;
  /**
   * The loaded detection ruleset. Capture is ruleset-INDEPENDENT (the record is
   * always built); classification is applied ONLY when this is provided. When
   * absent/`null` the record is `pending` (family/class NULL, no version) — the
   * no-baseline default. Passed in by the caller (D2's edge cache supplies it);
   * this module never imports a holder, so the edge runtime graph stays pure.
   */
  ruleset?: Ruleset | null;
}

/**
 * Build an {@link AgentRequestRecord} from a Web `Request` + the observed
 * outcome. Async because IP hashing uses `crypto.subtle`. Pure apart from the
 * subtle-crypto call: same inputs → same record. Reuses `toCaptureRecord`
 * (record assembly + UA/Referer lifting); classification runs `classify` against
 * `opts.ruleset` (or leaves the row `pending` when none is passed — no baseline).
 * Adds `meta.edge = true` so a consumer can tell edge-captured rows from
 * Node-captured ones (their outcome fidelity differs — see the module header).
 */
export async function buildEdgeRecord(
  request: Request,
  outcome: EdgeCaptureOutcome,
  opts: BuildEdgeRecordOptions,
): Promise<AgentRequestRecord> {
  const rawHeaders = edgeHeaderPairs(request.headers);

  const ip = resolveEdgeClientIp(request.headers);
  let ipHash: string | undefined;
  if (ip && opts.ipSalt) {
    ipHash = await hashIpEdge(ip, opts.ipSalt);
  }

  const minimal: MinimalRequest = {
    method: request.method,
    path: pathnameOf(request.url),
    // The edge cannot see the HTTP version (no analogue on a Web Request).
    httpVersion: "",
    rawHeaders,
  };
  if (ipHash !== undefined) {
    minimal.ipHash = ipHash;
  }

  const captureOutcome: CaptureOutcome = {
    status: outcome.status,
    ts: outcome.ts,
    ms: outcome.ms,
    ...(outcome.rescuedDeadEnd === true ? { rescuedDeadEnd: true } : {}),
  };
  const record = toCaptureRecord(minimal, captureOutcome, opts.siteId);

  // CLASSIFY — a separate step keyed on the ruleset the caller passed (D2's edge
  // cache supplies it). No ruleset → `pending` (family/class NULL, no version):
  // the no-baseline default, backfilled by the Node sink once a ruleset loads.
  // The edge does NOT run the published-IP-range tier (it is Node-oriented), so
  // confidence stays at classify()'s shape/UA level — never `ip-verified` here.
  const ruleset = opts.ruleset ?? null;
  if (ruleset) {
    const detection = classify(ruleset, rawHeaders);
    if (detection.family !== null) {
      record.agentFamily = detection.family;
    }
    record.agentClass = detection.class;
    record.confidence = detection.confidence;
    record.rulesetVersion = ruleset.version;
  } else {
    record.confidence = "pending";
  }

  // Mark the capture point + flag the unknown-status pass-through case so the
  // dashboard never reads an edge placeholder as a real resolve.
  const meta: Record<string, unknown> = { edge: true };
  if (outcome.status === 0) {
    meta.statusUnknown = true;
  }
  record.meta = { ...(record.meta ?? {}), ...meta };

  return record;
}

/** Extract the pathname from a request URL, tolerating a relative URL. */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // A relative or malformed URL: take everything before the query/hash.
    const q = url.search(/[?#]/);
    return q === -1 ? url : url.slice(0, q);
  }
}
