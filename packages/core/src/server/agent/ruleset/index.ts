/**
 * The detection ruleset — the DATA half of agent detection (D1) + the cached
 * ruleset CLIENT (D2). See `./schema.js` for the data design (method/data
 * boundary, no-baseline) and `./client.js` for the fetch/stale-while-revalidate
 * client.
 *
 * NOTE for edge consumers: this barrel re-exports value modules that pull in zod
 * (the schema, the client) and `node:*` (the disk cache), so it is NOT edge-safe.
 * The pure classifier imports the ruleset TYPE from `./types.js` directly
 * (type-only, erased) and the edge path is handed a ruleset VALUE by its adapter.
 * Import from this barrel only from Node code.
 */

export type {
  CachedRuleset,
  RulesetCacheStore,
} from "./cache-store.js";
export { NoopRulesetCacheStore } from "./cache-store.js";
export {
  type ActivateMeta,
  parseMaxAge,
  RulesetClient,
  type RulesetClientConfig,
  type RulesetClientOptions,
  type RulesetErrorPhase,
  type RulesetFetcher,
  type RulesetFetchResponse,
} from "./client.js";
export { DiskRulesetCacheStore } from "./disk-cache.js";
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
