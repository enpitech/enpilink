import { resolveConfig } from "../config/index.js";
import { getActiveStorage } from "../log-sink.js";

/**
 * Live capture gate for the HTTP agent surface (M1) — a direct clone of the
 * analytics `capture-gate.ts` pattern, kept SEPARATE so the two capture points
 * toggle independently (agent capture is a different, heavier surface and OFF by
 * default regardless of `analytics.enabled`).
 *
 * The gate mirrors the resolved runtime config of `agent.enabled` (+
 * `agent.sampleRate`) using the documented env > file > db > default precedence.
 * It is a cheap, synchronous, in-memory snapshot read on the request hot path —
 * no DB read, no async, never throws — re-resolved only when config is written
 * (the config router calls {@link refreshAgentCaptureGate} after a successful
 * PUT/DELETE/preset). So toggling `agent.enabled` in the UI takes effect for
 * subsequent requests WITHOUT a restart, and an env pin (`ENPILINK_AGENT`) still
 * wins (env > db).
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
}

/**
 * The current gate. Defaults to OFF so that, before the first resolve (or if a
 * resolve fails), capture stays off — preserving the off-by-default guarantee.
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
    };
  } catch {
    // Keep the previous gate; a config-resolve failure must never break or
    // change capture behavior abruptly.
  }
  return gate;
}
