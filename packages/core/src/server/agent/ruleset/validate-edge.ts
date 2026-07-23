// TYPE-ONLY (erased): the validated value IS a `Ruleset`, but we never import the
// zod schema that defines it — that is the whole point of this module.
import type { Ruleset, ShapeRule, UaPattern } from "./types.js";

/**
 * THE ZOD-FREE EDGE RULESET VALIDATOR (D4b) — the answer to "how do you validate a
 * fetched ruleset on the edge WITHOUT zod?".
 *
 * The D2 client (`client.ts`) validates a fetched artifact with `parseRuleset`
 * (zod). Zod cannot enter an edge bundle (it is ~50KB+ and the edge-safety test
 * forbids it), so the edge client (`edge-client.ts`) cannot reuse `client.ts`. The
 * chosen approach (DISTRIBUTION-PLAN §key-problem option (a)):
 *
 *   A LIGHTWEIGHT, HAND-WRITTEN STRUCTURAL VALIDATOR — enough that a corrupt
 *   artifact can NEVER crash the classifier or corrupt the stored rows, while
 *   trusting the CDN's HTTPS + the content-addressed `version` for byte integrity.
 *
 * Why this is safe:
 * - The classifier (`detect.ts`) iterates `ruleset.uaPatterns` and
 *   `ruleset.shapeRules`, so those MUST be arrays of the right shape or the `for`
 *   loops throw. This validator guarantees exactly that: `version` is a non-empty
 *   string, `uaPatterns`/`shapeRules` are arrays whose every item has the fields
 *   `classify()` reads, every `class`/`confidence`/`when` is a known enum value,
 *   and every regex `pattern` COMPILES (a bad regex is rejected, matching zod's
 *   `compilable` refinement — never shipped as a rule that silently never matches).
 * - `detect.ts` is ALSO defensive on its own (its `regexFor` caches `null` for a
 *   pattern that won't compile and treats it as non-matching; `matchShapeRule` has
 *   a `default: false`). Validator + defensive classifier = two independent layers,
 *   so a malformed artifact DEGRADES (the edge client keeps the last-good ruleset,
 *   or stays `pending`) and NEVER throws into a request.
 *
 * Deliberate divergences from the strict Node (zod) schema, and why they're OK:
 * - **Lenient on unknown/extra fields** (the Node schema is `.strict()`). The edge
 *   validator ignores fields it does not know, so a future artifact that adds a
 *   benign field still classifies on an older edge deploy (forward-compatible).
 *   Integrity is already guaranteed by HTTPS + content-addressing.
 * - **Lenient on `ipRanges`.** The optional published-IP confidence tier is
 *   Node-only (it needs a network cache); the edge classifier never reads
 *   `ipRanges`, so a malformed one cannot crash it. We coerce a non-object to an
 *   empty tier rather than reject the whole (otherwise valid) artifact.
 *
 * Full zod validation stays a Node/build-time concern (`publish.ts` +
 * `client.ts`); this is the runtime edge gate.
 */

/** Behavioural classes a rule may emit (mirrors `AgentClass`, minus edge concerns). */
const AGENT_CLASSES = new Set([
  "crawler",
  "chat-fetcher",
  "agent-mode",
  "browser-agent",
  "cli",
  "tool",
  "human-or-browser",
  "unknown",
]);

/** Confidence tiers a RULE may emit (note: `pending` is a capture state, never a
 * rule output — it is intentionally absent, matching `ruleConfidenceSchema`). */
const RULE_CONFIDENCES = new Set([
  "crypto",
  "ip-verified",
  "ua+shape",
  "shape",
  "ua-only",
  "none",
]);

/** The shape-condition vocabulary (mirrors `shapeConditionSchema`). */
const SHAPE_CONDITIONS = new Set([
  "title-cased-hints-and-ua",
  "title-cased-hints",
  "envoy",
  "has-sec-fetch",
  "has-headers",
  "always",
]);

/** Upper bounds, mirroring the zod schema's `.max()` — a hostile artifact can't
 * blow up memory or spin the classifier on an enormous rule list. */
const MAX_UA_PATTERNS = 1000;
const MAX_SHAPE_RULES = 100;

/** Raised when a fetched artifact fails edge validation. The edge client catches
 * this, keeps the last-good ruleset (or stays `pending`), and never rethrows. */
export class EdgeRulesetValidationError extends Error {
  constructor(message: string) {
    super(`invalid ruleset (edge): ${message}`);
    this.name = "EdgeRulesetValidationError";
  }
}

/** A plain (non-null, non-array) object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether `pattern` compiles as a RegExp with `flags` — a bad regex is rejected. */
function regexCompiles(pattern: string, flags: string): boolean {
  try {
    // Compile-only check — the RegExp is discarded; we only care that it parses.
    void new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

/** Validate + normalise one UA-naming rule. Throws on any structural problem. */
function validateUaPattern(raw: unknown, i: number): UaPattern {
  if (!isObject(raw)) {
    throw new EdgeRulesetValidationError(`uaPatterns[${i}] is not an object`);
  }
  const where = `uaPatterns[${i}]`;
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new EdgeRulesetValidationError(
      `${where}.id must be a non-empty string`,
    );
  }
  const pattern = raw.pattern;
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new EdgeRulesetValidationError(
      `${where}.pattern must be a non-empty string`,
    );
  }
  // `flags` defaults to "i" (matching `regexFields.flags.default("i")`), so an
  // artifact that omits flags classifies byte-identically to the Node path.
  const flags = typeof raw.flags === "string" ? raw.flags : "i";
  if (!regexCompiles(pattern, flags)) {
    throw new EdgeRulesetValidationError(`${where}.pattern does not compile`);
  }
  if (!(raw.family === null || typeof raw.family === "string")) {
    throw new EdgeRulesetValidationError(
      `${where}.family must be string or null`,
    );
  }
  if (typeof raw.class !== "string" || !AGENT_CLASSES.has(raw.class)) {
    throw new EdgeRulesetValidationError(`${where}.class is not a known class`);
  }
  if (
    typeof raw.confidence !== "string" ||
    !RULE_CONFIDENCES.has(raw.confidence)
  ) {
    throw new EdgeRulesetValidationError(
      `${where}.confidence is not a known confidence`,
    );
  }
  if (raw.familyFrom !== undefined && raw.familyFrom !== "ua-token") {
    throw new EdgeRulesetValidationError(`${where}.familyFrom is invalid`);
  }
  if (raw.corroboration !== undefined) {
    validateCorroboration(raw.corroboration, where);
  }
  // Return the raw object cast to the validated type — we validated every field
  // `classify()` reads, and left benign extras intact (forward-compatible). We
  // normalise only `flags` (so an omitted-flags artifact behaves like the Node
  // path); everything else is passed through as-authored.
  return { ...(raw as UaPattern), flags };
}

/** Validate a UA rule's optional shape-corroboration block. */
function validateCorroboration(raw: unknown, where: string): void {
  if (!isObject(raw)) {
    throw new EdgeRulesetValidationError(
      `${where}.corroboration is not an object`,
    );
  }
  if (
    typeof raw.confidence !== "string" ||
    !RULE_CONFIDENCES.has(raw.confidence)
  ) {
    throw new EdgeRulesetValidationError(
      `${where}.corroboration.confidence is invalid`,
    );
  }
  if (
    raw.requireNoSecFetch !== undefined &&
    typeof raw.requireNoSecFetch !== "boolean"
  ) {
    throw new EdgeRulesetValidationError(
      `${where}.corroboration.requireNoSecFetch must be boolean`,
    );
  }
  if (
    raw.maxHeaderCount !== undefined &&
    !(typeof raw.maxHeaderCount === "number" && raw.maxHeaderCount >= 0)
  ) {
    throw new EdgeRulesetValidationError(
      `${where}.corroboration.maxHeaderCount must be a non-negative number`,
    );
  }
}

/** Validate + normalise one shape rule. Throws on any structural problem. */
function validateShapeRule(raw: unknown, i: number): ShapeRule {
  if (!isObject(raw)) {
    throw new EdgeRulesetValidationError(`shapeRules[${i}] is not an object`);
  }
  const where = `shapeRules[${i}]`;
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new EdgeRulesetValidationError(
      `${where}.id must be a non-empty string`,
    );
  }
  if (typeof raw.when !== "string" || !SHAPE_CONDITIONS.has(raw.when)) {
    throw new EdgeRulesetValidationError(
      `${where}.when is not a known condition`,
    );
  }
  if (raw.uaPattern !== undefined) {
    if (typeof raw.uaPattern !== "string" || raw.uaPattern.length === 0) {
      throw new EdgeRulesetValidationError(
        `${where}.uaPattern must be a non-empty string`,
      );
    }
    const uaFlags = typeof raw.uaFlags === "string" ? raw.uaFlags : "";
    if (!regexCompiles(raw.uaPattern, uaFlags)) {
      throw new EdgeRulesetValidationError(
        `${where}.uaPattern does not compile`,
      );
    }
  }
  if (!(raw.family === null || typeof raw.family === "string")) {
    throw new EdgeRulesetValidationError(
      `${where}.family must be string or null`,
    );
  }
  if (typeof raw.class !== "string" || !AGENT_CLASSES.has(raw.class)) {
    throw new EdgeRulesetValidationError(`${where}.class is not a known class`);
  }
  if (
    typeof raw.confidence !== "string" ||
    !RULE_CONFIDENCES.has(raw.confidence)
  ) {
    throw new EdgeRulesetValidationError(
      `${where}.confidence is not a known confidence`,
    );
  }
  return raw as ShapeRule;
}

/** The IP-range tier as edge-normalised — see the module note on why it's lenient. */
function normaliseIpRanges(raw: unknown): Ruleset["ipRanges"] {
  if (!isObject(raw)) {
    return { vendorLists: {}, familyToVendor: {} };
  }
  const vendorLists = isObject(raw.vendorLists) ? raw.vendorLists : {};
  const familyToVendor = isObject(raw.familyToVendor) ? raw.familyToVendor : {};
  return {
    vendorLists,
    familyToVendor,
  } as Ruleset["ipRanges"];
}

/**
 * Validate an unknown value (a fetched JSON body) into a {@link Ruleset} WITHOUT
 * zod. Throws {@link EdgeRulesetValidationError} on any problem the classifier
 * would choke on. Normalises `uaPatterns[].flags` to `"i"` when absent (so edge
 * classification matches the Node path) and coerces a malformed `ipRanges` to an
 * empty tier (unused on the edge). The returned value is a real `Ruleset` the
 * pure `classify()` consumes unchanged.
 */
export function parseRulesetEdge(input: unknown): Ruleset {
  if (!isObject(input)) {
    throw new EdgeRulesetValidationError("root is not an object");
  }
  if (typeof input.version !== "string" || input.version.length === 0) {
    throw new EdgeRulesetValidationError("version must be a non-empty string");
  }
  if (!Array.isArray(input.uaPatterns)) {
    throw new EdgeRulesetValidationError("uaPatterns must be an array");
  }
  if (input.uaPatterns.length > MAX_UA_PATTERNS) {
    throw new EdgeRulesetValidationError("uaPatterns exceeds the max length");
  }
  if (!Array.isArray(input.shapeRules)) {
    throw new EdgeRulesetValidationError("shapeRules must be an array");
  }
  if (input.shapeRules.length > MAX_SHAPE_RULES) {
    throw new EdgeRulesetValidationError("shapeRules exceeds the max length");
  }
  const uaPatterns = input.uaPatterns.map((p, i) => validateUaPattern(p, i));
  const shapeRules = input.shapeRules.map((r, i) => validateShapeRule(r, i));
  return {
    version: input.version,
    uaPatterns,
    shapeRules,
    ipRanges: normaliseIpRanges(input.ipRanges),
  };
}

/** The result of a non-throwing validation. */
export type EdgeParseResult =
  | { ok: true; ruleset: Ruleset }
  | { ok: false; error: EdgeRulesetValidationError };

/**
 * Non-throwing variant — the edge client uses this to BRANCH (keep last-good on a
 * bad artifact) rather than try/catch. Never throws.
 */
export function safeParseRulesetEdge(input: unknown): EdgeParseResult {
  try {
    return { ok: true, ruleset: parseRulesetEdge(input) };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof EdgeRulesetValidationError
          ? err
          : new EdgeRulesetValidationError(
              err instanceof Error ? err.message : String(err),
            ),
    };
  }
}
