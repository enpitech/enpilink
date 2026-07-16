import type {
  AgentOutcome,
  AgentRequestRecord,
  HeaderPair,
} from "../storage/types.js";

/**
 * Framework-agnostic HTTP agent capture core.
 *
 * This module is a PURE function of plain data — no Express, no Node globals, no
 * crypto, no clock, no I/O. That is deliberate: the Express adapter
 * (`express-middleware.ts`) resolves the runtime specifics (raw headers, client
 * IP, the IP hash, timing) and hands this core a neutral {@link MinimalRequest}
 * + {@link CaptureOutcome}; a future Next/edge adapter can reuse this same core
 * by constructing the same two objects. The core just assembles the persisted
 * {@link AgentRequestRecord} and derives what can be derived from the bytes.
 *
 * The one non-obvious contract: {@link MinimalRequest.rawHeaders} carries the
 * header pairs in ORIGINAL wire order and ORIGINAL casing. That is the whole
 * point of the capture (a real Chrome sends `sec-ch-ua` lowercase; a disguised
 * fetch library title-cases it). A Web `Headers`/`req.headers` object normalises
 * both away, so the adapter MUST source these from `req.rawHeaders`, never a
 * normalised map — and this core must never normalise them either.
 */

/**
 * The neutral request shape the capture core consumes. Modeled on a Web
 * `Request` but carrying the raw header pairs a `Headers` object cannot express.
 */
export interface MinimalRequest {
  /** HTTP method, original casing. */
  method: string;
  /** Request path (pathname only — the adapter strips the query string). */
  path: string;
  /** HTTP version string, e.g. `"1.1"` / `"2.0"`. */
  httpVersion: string;
  /** Raw header pairs, ORIGINAL order + casing. From `req.rawHeaders`. */
  rawHeaders: readonly HeaderPair[];
  /** `SHA-256(site salt + client IP)`, pre-computed by the adapter. Never raw. */
  ipHash?: string;
}

/** The response-side outcome the adapter observes when the response finishes. */
export interface CaptureOutcome {
  /** Final HTTP status code. */
  status: number;
  /** Epoch ms when the request started (the record's `ts`). */
  ts: number;
  /** Duration from receipt to response finish, in milliseconds. */
  ms: number;
}

/**
 * Reshape Node's flat `req.rawHeaders` (`[name, value, name, value, …]`) into
 * ordered {@link HeaderPair}s, preserving order and casing. A trailing unpaired
 * element (malformed input) is ignored.
 */
export function pairRawHeaders(flat: readonly string[]): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pairs.push([flat[i] as string, flat[i + 1] as string]);
  }
  return pairs;
}

/**
 * First value for a header, matched case-INSENSITIVELY over the raw pairs. Used
 * only to lift already-normalised fields (UA, Referer) out for indexed columns —
 * the raw pairs themselves are stored verbatim, so no signal is lost.
 */
export function headerValue(
  pairs: readonly HeaderPair[],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of pairs) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return undefined;
}

/**
 * Classify a request outcome from its status alone (S3 — zero config, always
 * available). See {@link AgentOutcome}.
 */
export function classifyOutcome(status: number): AgentOutcome {
  if (status === 404 || status === 410) {
    return "dead_end";
  }
  if (status === 401 || status === 403 || status === 429) {
    return "blocked";
  }
  if (status >= 500) {
    return "broken";
  }
  return "resolved";
}

/**
 * Assemble a persisted {@link AgentRequestRecord} from a captured request +
 * outcome. Pure and total: same inputs → same record, no side effects. The
 * detection/session fields are left unset here (filled by later milestones);
 * `confidence` defaults to `"none"` so the honesty invariant holds from day one.
 */
export function toCaptureRecord(
  req: MinimalRequest,
  outcome: CaptureOutcome,
  siteId: string,
): AgentRequestRecord {
  const record: AgentRequestRecord = {
    ts: outcome.ts,
    siteId,
    method: req.method,
    path: req.path,
    status: outcome.status,
    outcome: classifyOutcome(outcome.status),
    httpVersion: req.httpVersion,
    headers: [...req.rawHeaders],
    ms: outcome.ms,
    confidence: "none",
  };
  if (req.ipHash !== undefined) {
    record.ipHash = req.ipHash;
  }
  const ua = headerValue(req.rawHeaders, "user-agent");
  if (ua !== undefined) {
    record.ua = ua;
  }
  const referer = headerValue(req.rawHeaders, "referer");
  if (referer !== undefined) {
    record.referer = referer;
  }
  return record;
}
