import { resolveConfig } from "./config/index.js";
import { getActiveStorage } from "./log-sink.js";

/**
 * Live capture gate for analytics (bugfix milestone).
 *
 * The analytics capture middleware is installed whenever there is an active
 * {@link StorageAdapter} (so the dashboard/observability always has a backing
 * store), but whether it ACTUALLY records an event is decided per-call by this
 * gate. The gate mirrors the resolved runtime config value of
 * `analytics.enabled` (+ `analytics.sampleRate`) using the documented
 * env > file > db > default precedence.
 *
 * Why a cached gate instead of resolving config on every tool call:
 * - {@link resolveConfig} does an async DB read; doing that on the hot path of
 *   every tool call would measurably slow calls and could throw into the path.
 * - Instead we resolve ONCE at install and re-resolve only when config is
 *   written (the config router calls {@link refreshCaptureGate} after a
 *   successful PUT/DELETE/preset). The middleware reads a cheap, synchronous,
 *   in-memory snapshot — no DB read, no async, never throws.
 *
 * Result: toggling `analytics.enabled` in the Configuration UI takes effect for
 * subsequent tool calls WITHOUT a process restart. An env override of
 * `ENPILINK_ANALYTICS` still wins (env > db) because `resolveConfig` applies the
 * same precedence — so an operator who pins the env var env-locks the toggle.
 *
 * No backfill: enabling analytics starts capturing forward only; it does not
 * retroactively synthesize events for calls made while it was off.
 */

/** The cheap, synchronous snapshot read on the hot path. */
export interface CaptureGate {
  /** Whether to record events at all (resolved `analytics.enabled`). */
  enabled: boolean;
  /** Fraction of calls to record `[0, 1]` (resolved `analytics.sampleRate`). */
  sampleRate: number;
}

/**
 * The current gate. Defaults to OFF so that, before the first resolve (or if a
 * resolve fails), capture stays off — preserving the off-by-default guarantee.
 */
let gate: CaptureGate = { enabled: false, sampleRate: 1 };

/** Read the current capture gate (synchronous, cheap, never throws). */
export function getCaptureGate(): CaptureGate {
  return gate;
}

/**
 * TEST-ONLY / mock: force the gate to a known value without resolving config.
 * `--mock` mode uses this to force capture on for the session.
 */
export function setCaptureGate(next: CaptureGate): void {
  gate = next;
}

/**
 * Re-resolve the capture gate from the active storage + env/file. Called at
 * install and after every config write. Fire-and-forget friendly: it never
 * throws (a resolve failure leaves the previous gate in place). Returns the
 * freshly resolved gate for callers/tests that want to await it.
 */
export async function refreshCaptureGate(): Promise<CaptureGate> {
  try {
    const { values } = await resolveConfig(getActiveStorage());
    gate = {
      enabled: values["analytics.enabled"] === true,
      sampleRate: values["analytics.sampleRate"],
    };
  } catch {
    // Keep the previous gate; a config-resolve failure must never break or
    // change capture behavior abruptly.
  }
  return gate;
}
