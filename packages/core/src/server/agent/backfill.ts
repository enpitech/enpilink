import type {
  AgentClassificationUpdate,
  StorageAdapter,
} from "../storage/types.js";
import { classify } from "./detect.js";
import type { Ruleset } from "./ruleset/types.js";

/**
 * Backfill re-classification (D1).
 *
 * Capture is ruleset-independent: a raw row is ALWAYS written, and when no
 * ruleset was loaded it lands `pending` (family/class NULL, no ruleset version).
 * Classification is a SEPARATE step. This function (re)classifies the rows a
 * newly-loaded or version-changed ruleset makes stale — i.e. every row whose
 * stored `rulesetVersion` differs from `ruleset.version` (NULL/pending included) —
 * and stamps each with the current version so it drops out of the scan.
 *
 * WHO CALLS IT: D2's cached client, right after it `setCurrentRuleset(...)` on
 * (a) the first successful fetch and (b) a version change. For D1 it is invoked
 * explicitly (tests, the smoke test). It is off the request hot path — safe to
 * run in the background.
 *
 * LIMITATION (documented, not a bug): it re-runs `classify()` (shape + UA) over
 * the STORED headers. It does NOT re-run the optional published-IP tier — the raw
 * client IP was discarded at capture (only the salted hash is kept), so a row that
 * was `ip-verified` at capture and later re-classified on a version change drops to
 * its shape/UA confidence. Pending rows never had an IP verdict anyway.
 */

/** Options for {@link backfillClassification}. */
export interface BackfillOptions {
  /** Rows fetched + updated per page. Default 500. */
  batchSize?: number;
  /** Restrict the backfill to one site. Default: all sites. */
  siteId?: string;
}

/** What a backfill run did. */
export interface BackfillResult {
  /** How many rows were re-classified + stamped. */
  reclassified: number;
  /** How many pages were processed (0 when the adapter lacks the methods). */
  pages: number;
}

/**
 * Re-classify every stale row for `ruleset` and stamp its version. Best-effort:
 * a no-op (returns zero) when `storage` is null or lacks the backfill methods
 * (a custom adapter predating D1). Pages until drained; each processed page is
 * stamped current, so it leaves the "stale" predicate and the loop terminates.
 */
export async function backfillClassification(
  storage: StorageAdapter | null,
  ruleset: Ruleset,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  if (
    !storage?.queryUnclassifiedAgentRequests ||
    !storage.updateAgentClassifications
  ) {
    return { reclassified: 0, pages: 0 };
  }
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : 500;
  let reclassified = 0;
  let pages = 0;

  for (;;) {
    const rows = await storage.queryUnclassifiedAgentRequests({
      rulesetVersion: ruleset.version,
      ...(opts.siteId !== undefined ? { siteId: opts.siteId } : {}),
      limit: batchSize,
    });
    if (rows.length === 0) {
      break;
    }
    pages += 1;

    const updates: AgentClassificationUpdate[] = [];
    for (const row of rows) {
      if (row.id === undefined) {
        continue;
      }
      const detection = classify(ruleset, row.headers, row.ua);
      updates.push({
        id: row.id,
        agentFamily: detection.family,
        agentClass: detection.class,
        confidence: detection.confidence,
        rulesetVersion: ruleset.version,
      });
    }

    // No id on any row → we can never advance the version stamp; stop rather than
    // loop forever (defensive — SQL + memory rows always carry an id).
    if (updates.length === 0) {
      break;
    }
    await storage.updateAgentClassifications(updates);
    reclassified += updates.length;

    // A short page means the scan is drained.
    if (rows.length < batchSize) {
      break;
    }
  }

  return { reclassified, pages };
}
