import type { Hook } from "@oclif/core";

/**
 * Telemetry is removed in enpilink. This module is a no-op stub kept only so
 * the public API surface (and the oclif `finally` hook) stays stable.
 *
 * There is NO network activity, NO hardcoded analytics key, and NO writes to
 * any global config dir. enpilink never phones home.
 */

export function isEnabled(): boolean {
  return false;
}

export function isDebugMode(): boolean {
  return false;
}

export function setEnabled(_enabled: boolean): void {
  // no-op: enpilink has no telemetry to enable/disable.
}

export function getMachineId(): string {
  return "telemetry-disabled";
}

const hook: Hook<"finally"> = async () => {
  // no-op: enpilink does not collect or send telemetry.
};

export default hook;
