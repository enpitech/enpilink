import type { AgentToolParam } from "../represent.js";

/**
 * THE SAFETY GATE (M7, ARCHITECTURE §3.3) — the deliverable that matters most.
 *
 * Exposing a mutating or authed tool on an unauthenticated GET must be
 * IMPOSSIBLE. This is enforced at REGISTRATION time, not request time: a
 * misconfigured server does NOT START (it throws from `registerTool`), rather
 * than leak at 3am. `evaluateGetSafety` is the pure verdict (each failure mode is
 * a unit test); `assertGetExposable` is the thin throwing wrapper `server.ts`
 * calls.
 *
 * A tool is GET-exposable ONLY if ALL hold:
 *  1. `transports.get.safe === true` — a written, physical author assertion.
 *  2. `annotations.readOnlyHint === true` — reuse MCP's own annotation.
 *  3. `annotations.destructiveHint !== true`.
 *  4. `securitySchemes` is public — absent, empty, or `noauth`-only (never oauth2).
 *  5. the input schema is FLAT — no nested-object parameter (it cannot round-trip
 *     through a query string; §3.4).
 *
 * GET is SAFE + IDEMPOTENT by construction and by the compiler. Mutating/authed
 * tools are MCP/WebMCP only; there is no code path in which they acquire a GET
 * projection.
 */

/** The inputs the gate inspects, extracted from a tool's registration config. */
export interface GetSafetyInput {
  /** The literal `transports.get.safe` value (must be exactly `true`). */
  safe: unknown;
  /** `annotations.readOnlyHint`. */
  readOnlyHint?: boolean;
  /** `annotations.destructiveHint`. */
  destructiveHint?: boolean;
  /** Declared security schemes (only their `type` matters here). */
  securitySchemes?: readonly { type: string }[];
  /** The derived input parameters (to reject a nested-object shape). */
  params: readonly AgentToolParam[];
}

/** A gate verdict. `ok: false` carries a human reason naming the failure. */
export type GetSafetyVerdict = { ok: true } | { ok: false; reason: string };

/** The pure safety verdict. Returns the FIRST failing reason, or `ok`. */
export function evaluateGetSafety(input: GetSafetyInput): GetSafetyVerdict {
  if (input.safe !== true) {
    return {
      ok: false,
      reason:
        "transports.get.safe must be the literal `true` (a written assertion this tool is safe, public and idempotent)",
    };
  }
  if (input.readOnlyHint !== true) {
    return {
      ok: false,
      reason:
        "it must declare annotations.readOnlyHint: true — only a read-only tool can be projected onto an unauthenticated GET",
    };
  }
  if (input.destructiveHint === true) {
    return {
      ok: false,
      reason:
        "it declares annotations.destructiveHint: true — a destructive tool is never GET-exposable",
    };
  }
  const nonPublic = (input.securitySchemes ?? []).find(
    (s) => s.type !== "noauth",
  );
  if (nonPublic) {
    return {
      ok: false,
      reason: `it declares a non-public security scheme (${nonPublic.type}) — a tool behind auth can never be projected onto an unauthenticated GET`,
    };
  }
  const nested = input.params.find(
    (p) =>
      p.type === "object" ||
      (typeof p.type === "string" && p.type.includes("object")),
  );
  if (nested) {
    return {
      ok: false,
      reason: `its parameter \`${nested.name}\` is a nested object, which cannot round-trip through a query string — GET tools must have a flat input schema`,
    };
  }
  return { ok: true };
}

/**
 * Throw if a tool declaring `transports.get` fails the safety gate. Called from
 * `registerTool` so a bad configuration crashes server boot with a message naming
 * the tool and the exact reason.
 */
export function assertGetExposable(
  toolName: string,
  input: GetSafetyInput,
): void {
  const verdict = evaluateGetSafety(input);
  if (!verdict.ok) {
    throw new Error(
      `Tool "${toolName}" declares transports.get but cannot be exposed on an unauthenticated GET: ${verdict.reason}.`,
    );
  }
}
