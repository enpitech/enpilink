import { createHash } from "node:crypto";
import { INITIAL_RULESET } from "./initial.js";
import { parseRuleset } from "./schema.js";
import type { Ruleset } from "./types.js";

/**
 * THE RULESET PUBLISH PIPELINE (D3) — turns the maintained detection corpus into
 * a versioned, validated, ready-to-serve artifact.
 *
 * WHERE THE DATA LIVES: the corpus is `./initial.js`'s {@link INITIAL_RULESET}
 * (today's rules, extracted to data in D1) plus the vendor IP-range source list
 * it references from `../ip-ranges.js`. **A new agent signature is added in ONE
 * place — `initial.ts`** (a new `uaPatterns`/`shapeRules` entry, or a new
 * `ipRanges.familyToVendor` mapping) — then this pipeline re-emits the artifact.
 * The npm package stays PURE LOGIC; this module only assembles + versions DATA,
 * it bakes nothing new into the runtime classifier.
 *
 * THE #1 CORRECTNESS RULE (backfill fires ONLY on a `version` change): any change
 * to the ruleset DATA must bump `version`, or existing rows never re-classify.
 * We enforce this STRUCTURALLY by making the version CONTENT-ADDRESSED: the
 * published `version` embeds a hash of the (version-stripped) ruleset content, so
 * it is impossible to change the data without changing the version.
 * {@link assertVersionMatchesContent} re-derives the hash and rejects any
 * artifact whose `version` no longer matches its content — that is the guard the
 * CLI runs before publishing (it catches a hand-edited/stale version, the one way
 * the #1 rule could be violated).
 *
 * Node-only: it uses `node:crypto` + zod (`parseRuleset`). It is imported by the
 * build script and the self-host serve endpoint — both Node. It is NEVER in the
 * edge graph (the edge path is handed a ruleset value directly).
 */

/**
 * The stable CDN path segment / artifact SCHEMA-major. The consumer always
 * fetches `<host>/agent/ruleset/<ARTIFACT_SCHEMA_VERSION>.json` (a stable URL);
 * the artifact's `version` FIELD changes on every data change while the URL does
 * not, so `Cache-Control` on that URL controls refresh. Bump this ONLY on an
 * incompatible schema change (that needs a package release anyway).
 */
export const ARTIFACT_SCHEMA_VERSION = "v1";

/**
 * The human release tag prefixed onto the content-addressed version, purely for
 * legibility in the dashboard/logs (e.g. `2026-07-23-a1b2c3d4e5`). The hash
 * suffix — not this — is the correctness guarantee, so a maintainer who forgets
 * to bump this date still cannot ship changed data under an unchanged version.
 * Bump it when curating a release for a human-readable marker.
 */
export const RELEASE_TAG = "2026-07-23";

/** Hex chars of the content hash carried in the version (collision-safe enough
 * for an artifact that is also validated + reviewed). */
const HASH_LEN = 10;

/**
 * Deterministic serialization for HASHING: object keys sorted recursively, array
 * order PRESERVED (uaPatterns/shapeRules are order-significant — first match
 * wins). Invariant to key insertion order so the hash is stable across runs, but
 * sensitive to any value or ordering change. Not for display — only the digest.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // Ruleset leaves are only string/number/boolean/null (no undefined keys
    // survive the schema), so JSON.stringify always yields a real string here.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * The content hash of a ruleset — sha256 over the canonical, VERSION-STRIPPED
 * body. Stripping `version` is what makes the hash a function of the DATA alone,
 * so stamping the hash back into `version` is self-consistent (re-hashing the
 * stamped artifact yields the same digest).
 */
export function rulesetContentHash(ruleset: Ruleset): string {
  const { version: _version, ...content } = ruleset;
  return createHash("sha256")
    .update(stableStringify(content))
    .digest("hex")
    .slice(0, HASH_LEN);
}

/** The content-addressed version for a ruleset: `<releaseTag>-<contentHash>`. */
export function versionFor(ruleset: Ruleset, releaseTag = RELEASE_TAG): string {
  return `${releaseTag}-${rulesetContentHash(ruleset)}`;
}

/** Raised when an artifact's `version` does not encode its own content hash —
 * i.e. the data changed but the version did not (the #1-rule violation). */
export class RulesetVersionMismatchError extends Error {
  constructor(
    readonly version: string,
    readonly expectedHash: string,
  ) {
    super(
      `ruleset version "${version}" does not match its content hash "${expectedHash}" — ` +
        "the data changed but the version did not (re-run the publish pipeline)",
    );
    this.name = "RulesetVersionMismatchError";
  }
}

/**
 * THE #1-RULE GUARD. Re-derive the content hash and assert the artifact's
 * `version` ends with it. Throws {@link RulesetVersionMismatchError} otherwise.
 * This is what makes "changed content under an unchanged version" impossible to
 * publish: the CLI runs it on every emitted artifact.
 */
export function assertVersionMatchesContent(ruleset: Ruleset): void {
  const expected = rulesetContentHash(ruleset);
  if (!ruleset.version.endsWith(expected)) {
    throw new RulesetVersionMismatchError(ruleset.version, expected);
  }
}

/** A built, versioned, validated ruleset artifact ready to write or serve. */
export interface RulesetArtifact {
  /** The content-addressed `version` stamped into the body. */
  version: string;
  /** The stable serving filename / CDN path segment (`v1.json`). */
  filename: string;
  /** The validated, version-stamped ruleset object. */
  body: Ruleset;
  /** The exact JSON bytes to write to disk / send over the wire (pretty, LF). */
  json: string;
}

/** Options for {@link buildRulesetArtifact}. */
export interface BuildRulesetOptions {
  /** The corpus to publish. Defaults to the maintained {@link INITIAL_RULESET}. */
  corpus?: Ruleset;
  /** The human release tag prefix. Defaults to {@link RELEASE_TAG}. */
  releaseTag?: string;
}

/**
 * Build the ruleset artifact from the corpus: normalise it (schema defaults
 * applied), compute the content-addressed version, stamp it, RE-VALIDATE, and
 * self-check the #1-rule guard. A broken corpus throws here (never publishable).
 * Deterministic: same corpus → byte-identical artifact, so the self-host endpoint
 * and the published CDN file agree without duplicating the data.
 */
export function buildRulesetArtifact(
  opts: BuildRulesetOptions = {},
): RulesetArtifact {
  const releaseTag = opts.releaseTag ?? RELEASE_TAG;
  // Normalise first (defaults like regex `flags: "i"` applied) so the hash and
  // the emitted bytes reflect exactly what a client will validate + run.
  const normalized = parseRuleset(opts.corpus ?? INITIAL_RULESET);
  const version = versionFor(normalized, releaseTag);
  const body = parseRuleset({ ...normalized, version });
  // Belt-and-braces: the artifact we just stamped MUST satisfy the guard.
  assertVersionMatchesContent(body);
  const json = `${JSON.stringify(body, null, 2)}\n`;
  return {
    version,
    filename: `${ARTIFACT_SCHEMA_VERSION}.json`,
    body,
    json,
  };
}
