import type { AgentClass, AgentRequestRecord } from "../storage/types.js";

/**
 * Honest cross-request correlation (M4) — recovery/abandonment and
 * escalation-to-browser, computed PURELY from captured
 * {@link AgentRequestRecord} rows. No Express, no clock, no I/O.
 *
 * THE HONESTY CONSTRAINT (ARCHITECTURE §1.1 — non-negotiable):
 * `ChatGPT-User` / `Claude-User` / Gemini and every crawler fetch from a SHARED
 * vendor IP pool with a byte-identical UA, no cookie, no JS. Two requests from
 * the same vendor IP are, in general, TWO DIFFERENT PEOPLE. There is no per-user
 * correlator, so we NEVER stitch a session for them — that would be a fiction.
 * They are reported {@link SessionAggregate.unsessionableByClass | unsessionable}.
 *
 * The hashed IP is a REAL user-scoped correlator only for {@link SESSIONABLE_CLASSES}
 * — `cli` (a coding CLI on the developer's own IP) and `browser-agent` (an
 * on-device browser agent on the user's residential IP). We stitch sessions and
 * compute recovery ONLY for those, and we ALWAYS report the coverage fraction so
 * the reader knows how much of the traffic the metric could actually see.
 *
 * NOTE: `browser-agent` is a RESERVED class — the M2 shape classifier cannot
 * separate an on-device browser agent from a human, so it reports
 * `human-or-browser` and never emits `browser-agent` today. In practice, then,
 * recovery is currently computed over `cli` traffic only; the class is included
 * so a future signed/crypto positive-id (M3+) starts feeding it with no change.
 *
 * WHAT THIS CANNOT SEE (state it, do not overclaim):
 * - Recovery/escalation for the sessionless majority (chat fetchers, crawlers) —
 *   by construction. The coverage fraction quantifies exactly this blind spot.
 * - Cloud→residential escalation. Claude WORK mode escalated from its cloud
 *   WebFetch (a vendor IP) to Playwright on the user's Mac (a residential IP) —
 *   DIFFERENT IPs (F-7/F-8). Since the escalation correlator is the hashed IP,
 *   that transition is invisible here; escalation is best-effort and UNDERcounts.
 *   It fires only when the pre- and post-request share a hashed IP (an on-device
 *   CLI/agent launching a local browser).
 */

/**
 * Behavioural classes whose client IP is user-scoped, so the hashed IP is a real
 * per-identity correlator. EVERYTHING ELSE is unsessionable (shared vendor pools,
 * or ambiguous human-or-browser traffic we refuse to gamble a session on).
 */
export const SESSIONABLE_CLASSES: ReadonlySet<AgentClass> = new Set<AgentClass>(
  ["cli", "browser-agent"],
);

/** A non-browser fetch that can ESCALATE to a full browser render (the F-8 tell). */
const ESCALATION_FROM: ReadonlySet<AgentClass> = new Set<AgentClass>([
  "chat-fetcher",
  "cli",
  "agent-mode",
  "tool",
]);

/** The full-browser render an escalation lands on. */
const ESCALATION_TO: ReadonlySet<AgentClass> = new Set<AgentClass>([
  "human-or-browser",
  "browser-agent",
]);

/** Default idle gap that splits one identity's requests into sessions (30 min). */
export const DEFAULT_IDLE_GAP_MS = 30 * 60 * 1000;
/** Default window in which a later `resolved` counts as recovering a dead-end. */
export const DEFAULT_RECOVERY_WINDOW_MS = 5 * 60 * 1000;
/** Default window in which a browser render counts as escalating a prior fetch. */
export const DEFAULT_ESCALATION_WINDOW_MS = 5 * 60 * 1000;

/** Tunable windows for {@link computeAgentSessions}. */
export interface SessionOptions {
  /** Idle gap (ms) that ends one session and starts the next. */
  idleGapMs?: number;
  /** Max gap (ms) from a dead-end to a later `resolved` to count as recovered. */
  recoveryWindowMs?: number;
  /** Max gap (ms) from a fetch to a later browser render to count as escalation. */
  escalationWindowMs?: number;
  /**
   * TRUE total request count for the coverage denominator. Defaults to
   * `records.length`. The read API passes the full-window total (from the cheap
   * DB aggregate) so `sessionableCoverage` is honest even when only the
   * correlatable subset of rows was pulled for the row-level metrics.
   */
  totalRequests?: number;
}

/** Recovery / abandonment stats over the sessionable slice. */
export interface RecoveryStats {
  /** Dead-ends observed WITHIN sessionable identities. */
  deadEnds: number;
  /** Dead-ends followed by a `resolved` from the same identity in-window. */
  recovered: number;
  /** Dead-ends with no such follow-up. */
  abandoned: number;
  /** `recovered / deadEnds`, in `[0, 1]` (0 when there were no dead-ends). */
  recoveryRate: number;
  /**
   * Fraction of ALL observed dead-ends that fell within a sessionable identity
   * (`sessionableDeadEnds / allDeadEnds`). This is the coverage of the recovery
   * metric: everything else is unsessionable and its recovery is UNKNOWN.
   */
  coverage: number;
}

/** One unsessionable class bucket (for the honest breakdown). */
export interface UnsessionableClass {
  /** The class string, or `"unclassified"` when the class was unset. */
  agentClass: string;
  /** How many requests it accounted for. */
  count: number;
}

/** The full honest correlation aggregate. */
export interface SessionAggregate {
  /** Total requests the coverage is measured against. */
  total: number;
  /** Requests in a sessionable class WITH a hashed IP (correlatable). */
  sessionableRequests: number;
  /** Everything else — reported honestly, never merged into a fake session. */
  unsessionableRequests: number;
  /** `sessionableRequests / total` — the coverage headline. */
  sessionableCoverage: number;
  /** Sessions stitched from sessionable requests (idle-gap split). */
  sessions: number;
  /** Recovery / abandonment over the sessionable slice. */
  recovery: RecoveryStats;
  /**
   * Best-effort escalation-to-browser count (F-8): a browser render preceded,
   * within the window and from the SAME hashed IP, by a non-browser fetch. A
   * signal nobody else can compute — but it UNDERcounts (see the module note).
   */
  escalations: number;
  /** Unsessionable requests, grouped by class, most first — the honest label. */
  unsessionableByClass: UnsessionableClass[];
}

/** Stable identity key for a sessionable request. */
function identityKey(r: AgentRequestRecord): string {
  return `${r.agentClass}:${r.ipHash}`;
}

/** Whether a record is sessionable: a sessionable class AND a hashed IP. */
function isSessionable(r: AgentRequestRecord): boolean {
  return (
    r.agentClass !== undefined &&
    SESSIONABLE_CLASSES.has(r.agentClass) &&
    r.ipHash !== undefined
  );
}

/**
 * Compute the honest correlation aggregate. Pure + deterministic. Recovery and
 * sessions cover ONLY {@link SESSIONABLE_CLASSES} with a hashed IP; escalation is
 * best-effort over the hashed-IP correlator; the coverage fraction is always
 * reported so no number is mistaken for full coverage.
 */
export function computeAgentSessions(
  records: readonly AgentRequestRecord[],
  opts: SessionOptions = {},
): SessionAggregate {
  const idleGapMs = opts.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const recoveryWindowMs = opts.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS;
  const escalationWindowMs =
    opts.escalationWindowMs ?? DEFAULT_ESCALATION_WINDOW_MS;
  const total = opts.totalRequests ?? records.length;

  // ── Partition into sessionable vs unsessionable, and count all dead-ends. ──
  const sessionable = new Map<string, AgentRequestRecord[]>();
  const unsessionableByClass = new Map<string, number>();
  let sessionableRequests = 0;
  let allDeadEnds = 0;
  for (const r of records) {
    if (r.outcome === "dead_end") {
      allDeadEnds += 1;
    }
    if (isSessionable(r)) {
      sessionableRequests += 1;
      const key = identityKey(r);
      const bucket = sessionable.get(key);
      if (bucket) {
        bucket.push(r);
      } else {
        sessionable.set(key, [r]);
      }
    } else {
      const cls = r.agentClass ?? "unclassified";
      unsessionableByClass.set(cls, (unsessionableByClass.get(cls) ?? 0) + 1);
    }
  }

  // ── Per identity: split into sessions by idle gap, compute recovery. ──
  let sessions = 0;
  let deadEnds = 0;
  let recovered = 0;
  for (const bucket of sessionable.values()) {
    const seq = bucket.slice().sort((a, b) => a.ts - b.ts);
    let prevTs: number | null = null;
    for (const r of seq) {
      if (prevTs === null || r.ts - prevTs > idleGapMs) {
        sessions += 1;
      }
      prevTs = r.ts;
    }
    // Recovery is identity-scoped and time-windowed (not session-bounded): given
    // a dead-end at t, did the SAME identity get a `resolved` within the window?
    for (let i = 0; i < seq.length; i++) {
      const r = seq[i] as AgentRequestRecord;
      if (r.outcome !== "dead_end") {
        continue;
      }
      deadEnds += 1;
      for (let j = i + 1; j < seq.length; j++) {
        const later = seq[j] as AgentRequestRecord;
        if (later.ts - r.ts > recoveryWindowMs) {
          break;
        }
        if (later.outcome === "resolved") {
          recovered += 1;
          break;
        }
      }
    }
  }
  const abandoned = deadEnds - recovered;

  const escalations = countEscalations(records, escalationWindowMs);

  const unsessionableList: UnsessionableClass[] = [
    ...unsessionableByClass.entries(),
  ]
    .map(([agentClass, count]) => ({ agentClass, count }))
    .sort(
      (a, b) => b.count - a.count || a.agentClass.localeCompare(b.agentClass),
    );

  return {
    total,
    sessionableRequests,
    unsessionableRequests: total - sessionableRequests,
    sessionableCoverage: total === 0 ? 0 : sessionableRequests / total,
    sessions,
    recovery: {
      deadEnds,
      recovered,
      abandoned,
      recoveryRate: deadEnds === 0 ? 0 : recovered / deadEnds,
      coverage: allDeadEnds === 0 ? 0 : deadEnds / allDeadEnds,
    },
    escalations,
    unsessionableByClass: unsessionableList,
  };
}

/**
 * Count browser escalations: for each browser render, whether the SAME hashed IP
 * made a non-browser fetch within the preceding window. Best-effort — see the
 * module note on why it undercounts.
 */
function countEscalations(
  records: readonly AgentRequestRecord[],
  windowMs: number,
): number {
  const byIp = new Map<string, AgentRequestRecord[]>();
  for (const r of records) {
    if (r.ipHash === undefined || r.agentClass === undefined) {
      continue;
    }
    const bucket = byIp.get(r.ipHash);
    if (bucket) {
      bucket.push(r);
    } else {
      byIp.set(r.ipHash, [r]);
    }
  }

  let escalations = 0;
  for (const bucket of byIp.values()) {
    const seq = bucket.slice().sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < seq.length; i++) {
      const to = seq[i] as AgentRequestRecord;
      if (to.agentClass === undefined || !ESCALATION_TO.has(to.agentClass)) {
        continue;
      }
      // Any non-browser fetch from this IP in [to.ts - window, to.ts) counts.
      for (let j = i - 1; j >= 0; j--) {
        const from = seq[j] as AgentRequestRecord;
        if (to.ts - from.ts > windowMs) {
          break;
        }
        if (
          from.agentClass !== undefined &&
          ESCALATION_FROM.has(from.agentClass)
        ) {
          escalations += 1;
          break;
        }
      }
    }
  }
  return escalations;
}
