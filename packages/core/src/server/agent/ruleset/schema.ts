import { z } from "zod";
import { VENDORS } from "../ip-ranges.js";

/**
 * The DETECTION RULESET — the DATA half of agent detection (D1).
 *
 * The npm package is PURE LOGIC: it holds the detection *methods* (the algorithms
 * in `detect.ts` — "is a client hint title-cased?", "no `Sec-Fetch-*`?", a
 * UA-regex match, an IP-CIDR lookup). This ruleset holds the *data* those methods
 * consume: which UA patterns map to which family/class, which shape signatures
 * name a disguised client, the vendor IP-range lists, and the family→vendor map —
 * plus a `version`. A new agent that fits a KNOWN method (a new UA, a new IP
 * range, a new title-cased tell) is recognised by shipping a new ruleset, with NO
 * package release; a genuinely NOVEL detection *technique* needs a package release
 * (a new `when` condition here + the code that evaluates it).
 *
 * WHY ZOD: D2 fetches this object from a CDN. Validating a fetched ruleset against
 * this schema — regexes that compile, a `version`, bounded array sizes — is what
 * lets the cached client reject a corrupt artifact and keep serving the last good
 * one. There is deliberately **no baseline compiled into the package**: with no
 * valid ruleset loaded, classification is `pending`, never a hardcoded guess.
 *
 * The `Ruleset` TYPE is `z.infer`-derived from these schemas (single source of
 * truth) and re-exported from `./types.js`. `detect.ts` imports it TYPE-ONLY, so
 * the pure/edge classifier never pulls zod into its runtime graph.
 */

/** The behavioural taxonomy a rule may emit — kept in sync with `AgentClass`. */
const agentClassSchema = z.enum([
  "crawler",
  "chat-fetcher",
  "agent-mode",
  "browser-agent",
  "cli",
  "tool",
  "human-or-browser",
  "unknown",
]);

/**
 * The confidence a rule may EMIT. Note `pending` is intentionally ABSENT: it is
 * the capture-time state for a row classified with NO ruleset, never something a
 * rule produces.
 */
const ruleConfidenceSchema = z.enum([
  "crypto",
  "ip-verified",
  "ua+shape",
  "shape",
  "ua-only",
  "none",
]);

/** A regex `pattern`/`flags` pair, refined to reject a source that won't compile. */
const regexFields = {
  /** Regex SOURCE (not a slash-delimited literal). */
  pattern: z.string().min(1),
  /** Regex flags. Defaults to `"i"` (case-insensitive, as every current rule is). */
  flags: z.string().default("i"),
} as const;

function compilable<T extends { pattern: string; flags: string }>(
  obj: T,
  ctx: z.RefinementCtx,
): void {
  try {
    new RegExp(obj.pattern, obj.flags);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `invalid regex /${obj.pattern}/${obj.flags}`,
      path: ["pattern"],
    });
  }
}

/**
 * A SHAPE corroboration for a UA-named match: when the shape predicate holds,
 * the match's confidence is UPGRADED from its base to {@link confidence}. The
 * predicate primitives are a fixed, tiny vocabulary (the two shape checks the
 * current rules actually use) — NOT a general expression engine.
 */
const corroborationSchema = z
  .object({
    /** The upgraded confidence when the predicate holds. */
    confidence: ruleConfidenceSchema,
    /** Require NO `Sec-Fetch-*` header (a browser tell is absent). */
    requireNoSecFetch: z.boolean().optional(),
    /** Require the request to carry at most this many header pairs. */
    maxHeaderCount: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * A UA-naming rule: a regex over the User-Agent that NAMES a family. Evaluated in
 * order; first match wins. Confidence is {@link confidence}, upgraded via
 * {@link corroboration} when the shape corroborates the claim.
 */
const uaPatternSchema = z
  .object({
    /** Stable id, for debugging / the corpus view. */
    id: z.string().min(1),
    ...regexFields,
    /**
     * The family label, or `null` when the family is DERIVED from the UA token
     * (see {@link familyFrom}). A literal string names the vendor/client.
     */
    family: z.string().nullable(),
    /**
     * When `"ua-token"`, the family is derived from the leading UA token (the
     * generic HTTP-client naming method), and {@link family} is ignored.
     */
    familyFrom: z.enum(["ua-token"]).optional(),
    class: agentClassSchema,
    /** Base confidence for a bare match. */
    confidence: ruleConfidenceSchema,
    corroboration: corroborationSchema.optional(),
  })
  .strict()
  .superRefine(compilable);

/** The shape condition a {@link ShapeRule} evaluates. A fixed vocabulary = the
 * shape methods that exist in `detect.ts`; a NEW one needs a package release. */
const shapeConditionSchema = z.enum([
  /** `titleCasedClientHints` AND the UA matches `uaPattern` (the claude-web tell). */
  "title-cased-hints-and-ua",
  /** `titleCasedClientHints` (a title-cased client hint, UA irrelevant). */
  "title-cased-hints",
  /** An `X-Envoy-*` header is present. */
  "envoy",
  /** Any `Sec-Fetch-*` header is present (a real browser shape). */
  "has-sec-fetch",
  /** The request carries at least one header. */
  "has-headers",
  /** Catch-all — always matches (the final default). */
  "always",
]);

/**
 * A SHAPE rule, applied in order AFTER every UA rule fails to name the client.
 * The `when` condition is a code method; the emitted family/class/confidence and
 * the optional UA parameter are DATA.
 */
const shapeRuleSchema = z
  .object({
    id: z.string().min(1),
    when: shapeConditionSchema,
    /** Regex over the UA — only meaningful for `title-cased-hints-and-ua`. */
    uaPattern: z.string().min(1).optional(),
    /** Flags for {@link uaPattern}. */
    uaFlags: z.string().optional(),
    family: z.string().nullable(),
    class: agentClassSchema,
    confidence: ruleConfidenceSchema,
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.uaPattern !== undefined) {
      compilable({ pattern: obj.uaPattern, flags: obj.uaFlags ?? "" }, ctx);
    }
  });

/** The vendor enum, derived from `ip-ranges.ts` `VENDORS` (single source). */
const vendorSchema = z.enum(VENDORS);

/**
 * The IP-range DATA the optional published-IP confidence tier consumes: the
 * per-vendor list URLs (fetched at runtime by `IpRangeVerifier` — a method) and
 * the family→vendor map that decides WHICH vendor's list can verify a family.
 */
const ipRangesSchema = z
  .object({
    /** Per-vendor published-list URLs (fetched by the verifier, never vendored).
     * Partial — a ruleset need not list every vendor (missing = no IP tier for it). */
    vendorLists: z.partialRecord(vendorSchema, z.array(z.url())),
    /** Which vendor's published range can verify a named family. */
    familyToVendor: z.record(z.string(), vendorSchema),
  })
  .strict();

/** The full detection ruleset. */
export const rulesetSchema = z
  .object({
    /**
     * Opaque version identifier. Any change to the DATA MUST bump this — it is the
     * key backfill re-classification is triggered on (a row stamped with a
     * different version is re-classified). Format is free (semver, a hash, a date).
     */
    version: z.string().min(1),
    /** UA-naming rules, evaluated IN ORDER (first match wins). */
    uaPatterns: z.array(uaPatternSchema).max(1000),
    /** Shape rules, evaluated IN ORDER after UA rules, ending in an `always`. */
    shapeRules: z.array(shapeRuleSchema).max(100),
    /** The optional-IP-tier data. */
    ipRanges: ipRangesSchema,
  })
  .strict();

/** The typed, validated detection ruleset (single source of truth). */
export type Ruleset = z.infer<typeof rulesetSchema>;
/** A single UA-naming rule. */
export type UaPattern = z.infer<typeof uaPatternSchema>;
/** A single shape rule. */
export type ShapeRule = z.infer<typeof shapeRuleSchema>;
/** The shape condition a {@link ShapeRule} evaluates. */
export type ShapeCondition = z.infer<typeof shapeConditionSchema>;
/** The IP-range tier data. */
export type RulesetIpRanges = z.infer<typeof ipRangesSchema>;

/** Raised when a candidate ruleset fails validation. Carries the zod issues. */
export class RulesetValidationError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    super(`invalid ruleset: ${issues.map((i) => i.message).join("; ")}`);
    this.name = "RulesetValidationError";
  }
}

/**
 * Parse + validate an unknown value (e.g. a fetched JSON body) into a
 * {@link Ruleset}. Throws {@link RulesetValidationError} on any problem — a
 * corrupt artifact never silently becomes a live ruleset. D2 uses this to gate a
 * fetched artifact before it enters the holder.
 */
export function parseRuleset(input: unknown): Ruleset {
  const result = rulesetSchema.safeParse(input);
  if (!result.success) {
    throw new RulesetValidationError(result.error.issues);
  }
  return result.data;
}

/** Non-throwing variant — returns the zod result for callers that branch on it. */
export function safeParseRuleset(
  input: unknown,
): ReturnType<typeof rulesetSchema.safeParse> {
  return rulesetSchema.safeParse(input);
}
