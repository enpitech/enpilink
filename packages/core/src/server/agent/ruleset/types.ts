/**
 * The ruleset's public TYPES.
 *
 * These are `z.infer`-derived from the zod schemas in `./schema.js` (one source
 * of truth) and re-exported here as TYPE-ONLY exports. A statement-level
 * `export type … from` is fully erased under `verbatimModuleSyntax`, so importing
 * `Ruleset` from THIS module pulls in NO zod runtime — which is what keeps the
 * pure `detect.ts` classifier edge-safe while still being typed against the
 * ruleset. Anything that needs to VALIDATE a ruleset (a value operation) imports
 * `parseRuleset`/`rulesetSchema` from `./schema.js` directly.
 */

export type {
  Ruleset,
  RulesetIpRanges,
  ShapeCondition,
  ShapeRule,
  UaPattern,
} from "./schema.js";
