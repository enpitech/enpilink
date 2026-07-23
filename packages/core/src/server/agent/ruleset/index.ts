/**
 * The detection ruleset — the DATA half of agent detection (D1). See
 * `./schema.js` for the design (method/data boundary, no-baseline).
 *
 * NOTE for edge consumers: this barrel re-exports value modules that pull in zod
 * (the schema) and `ip-ranges.ts`, so it is NOT edge-safe. The pure classifier
 * imports the ruleset TYPE from `./types.js` directly (type-only, erased). Import
 * from this barrel only from Node code.
 */

export { getCurrentRuleset, setCurrentRuleset } from "./holder.js";
export { INITIAL_RULESET } from "./initial.js";
export {
  parseRuleset,
  type Ruleset,
  type RulesetIpRanges,
  RulesetValidationError,
  rulesetSchema,
  type ShapeCondition,
  type ShapeRule,
  safeParseRuleset,
  type UaPattern,
} from "./schema.js";
