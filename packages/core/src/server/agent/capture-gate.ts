import { resolveConfig } from "../config/index.js";
import { getActiveStorage } from "../log-sink.js";

/**
 * Live runtime snapshot of the HTTP agent surface (M1 + M3) — a direct clone of
 * the analytics `capture-gate.ts` pattern, kept SEPARATE so the agent surface
 * toggles independently of `analytics.enabled` (it is a different, heavier
 * surface and OFF by default). Despite the name it now holds the resolved config
 * for BOTH agent capture (`agent.enabled`/`sampleRate`/`verifyIpRanges`) and
 * agent SERVING (`agent.serve` + the `agent.site.*` summary), so both hot paths
 * read one cheap synchronous snapshot.
 *
 * The gate mirrors the resolved runtime config using the documented
 * env > file > db > default precedence. It is read synchronously on the request
 * hot path — no DB read, no async, never throws — re-resolved only when config is
 * written (the config router calls {@link refreshAgentCaptureGate} after a
 * successful PUT/DELETE/preset). So toggling `agent.enabled` or `agent.serve` in
 * the UI takes effect for subsequent requests WITHOUT a restart, and an env pin
 * (`ENPILINK_AGENT`, `ENPILINK_CFG_AGENT_SERVE`) still wins (env > db).
 */

/** The cheap, synchronous snapshot read on the hot path. */
export interface AgentCaptureGate {
  /** Whether to capture agent requests at all (resolved `agent.enabled`). */
  enabled: boolean;
  /** Fraction of requests to capture `[0, 1]` (resolved `agent.sampleRate`). */
  sampleRate: number;
  /**
   * Whether the OPTIONAL IP confidence tier is on (resolved
   * `agent.verifyIpRanges`). Off by default. When on, capture cross-checks a
   * UA-claimed vendor against its published IP ranges to upgrade confidence to
   * `ip-verified` (or flag a spoof). Optional field so existing callers of
   * {@link setAgentCaptureGate} keep compiling; absent/undefined reads as off.
   */
  verifyIpRanges?: boolean;
  /**
   * Whether to SERVE the agent representation to eligible chat fetchers (resolved
   * `agent.serve`, M3). OFF by default and independent of {@link enabled}.
   * Optional so existing test callers keep compiling; absent/undefined reads off.
   */
  serve?: boolean;
  /** Resolved owner-declared site title (`agent.site.title`), or "" if unset. */
  siteTitle?: string;
  /**
   * Resolved owner-declared site description (`agent.site.description`), or "".
   */
  siteDescription?: string;
}

/**
 * The current gate. Defaults to OFF so that, before the first resolve (or if a
 * resolve fails), both capture and serving stay off — preserving the
 * off-by-default guarantee.
 */
let gate: AgentCaptureGate = { enabled: false, sampleRate: 1 };

/** Read the current agent capture gate (synchronous, cheap, never throws). */
export function getAgentCaptureGate(): AgentCaptureGate {
  return gate;
}

/** TEST-ONLY: force the gate to a known value without resolving config. */
export function setAgentCaptureGate(next: AgentCaptureGate): void {
  gate = next;
}

/**
 * Re-resolve the agent capture gate from the active storage + env/file. Called
 * at install and after every config write. Never throws (a resolve failure
 * leaves the previous gate in place). Returns the freshly resolved gate.
 */
export async function refreshAgentCaptureGate(): Promise<AgentCaptureGate> {
  try {
    const { values } = await resolveConfig(getActiveStorage());
    gate = {
      enabled: values["agent.enabled"] === true,
      sampleRate: values["agent.sampleRate"],
      verifyIpRanges: values["agent.verifyIpRanges"] === true,
      serve: values["agent.serve"] === true,
      siteTitle: values["agent.site.title"],
      siteDescription: values["agent.site.description"],
    };
  } catch {
    // Keep the previous gate; a config-resolve failure must never break or
    // change capture behavior abruptly.
  }
  return gate;
}
