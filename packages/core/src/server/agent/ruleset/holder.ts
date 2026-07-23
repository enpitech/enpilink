import type { Ruleset } from "./types.js";

/**
 * The CURRENT-RULESET holder — a single in-memory slot for the ruleset the
 * classifier consumes (D1).
 *
 * It starts EMPTY (`null`). Nothing populates it in D1: tests set it explicitly,
 * and D2's cached client will `setCurrentRuleset` from the network
 * (stale-while-revalidate) and trigger a `backfillClassification` on load /
 * version change. This module is deliberately a dumb slot — no fetching, no
 * validation, no side effects — so it is pure and edge-safe (it imports the
 * ruleset TYPE only, no zod, no `node:*`).
 *
 * CRUCIAL (the no-baseline decision): the holder does NOT default to the initial
 * ruleset. With nothing set, `getCurrentRuleset()` returns `null` and the
 * classifier yields `pending`, never a hardcoded guess. The initial ruleset
 * (`./initial.js`) is a test fixture + the seed for D3's first CDN artifact — it
 * is never silently loaded here.
 */

let current: Ruleset | null = null;

/** Read the current ruleset, or `null` when none is loaded. Synchronous, cheap. */
export function getCurrentRuleset(): Ruleset | null {
  return current;
}

/**
 * Set (or clear, with `null`) the current ruleset. D2 calls this after fetching +
 * validating an artifact; tests call it to load a fixture. Callers that want
 * pending rows re-labelled must run `backfillClassification` after setting — the
 * holder itself has no side effects.
 */
export function setCurrentRuleset(ruleset: Ruleset | null): void {
  current = ruleset;
}
