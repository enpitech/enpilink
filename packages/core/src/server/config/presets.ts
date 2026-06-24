import type { RuntimeKey } from "./schema.js";

/**
 * Config presets / profiles (automation).
 *
 * A preset is a named bundle of RUNTIME-key → value overrides applied in one
 * action. Presets ONLY touch runtime keys — never secrets, never the `admin`
 * gate, never restart-tier or env-only bootstrap keys (`port`/`storage`/
 * `dbPath` are startup/env-only). The
 * router applies each value through the same validation + audit path as a
 * manual PUT, and skips any key currently pinned by env/file.
 */

export interface Preset {
  /** Stable id (used in the URL: `POST /config/preset/:name`). */
  name: string;
  /** Human label for the UI button. */
  label: string;
  /** What the preset is for, in one line. */
  description: string;
  /** The runtime-key → value map this preset sets. */
  values: Partial<Record<RuntimeKey, unknown>>;
}

/**
 * Built-in presets.
 *
 * - **Dev** — maximum visibility for local development: analytics on, full
 *   sampling (record everything), live logs on, generous retention, fine
 *   1-minute chart buckets.
 * - **Prod** — sensible production defaults: analytics on but sampled down to
 *   25% to cut overhead/storage on busy servers, larger retention caps to keep
 *   useful history, live logs off (avoid streaming overhead), coarser 5-minute
 *   chart buckets.
 */
export const PRESETS: Record<string, Preset> = {
  dev: {
    name: "dev",
    label: "Dev",
    description:
      "Maximum visibility for local development: analytics on, full sampling, live logs on, fine-grained charts.",
    values: {
      "analytics.enabled": true,
      "analytics.sampleRate": 1,
      "retention.events": 5000,
      "retention.logs": 5000,
      "flags.liveLogs": true,
      "display.bucketMs": 60_000,
    },
  },
  prod: {
    name: "prod",
    label: "Prod",
    description:
      "Production-friendly defaults: analytics on but sampled to 25%, larger retention, live logs off, coarser charts.",
    values: {
      "analytics.enabled": true,
      "analytics.sampleRate": 0.25,
      "retention.events": 20_000,
      "retention.logs": 20_000,
      "flags.liveLogs": false,
      "display.bucketMs": 300_000,
    },
  },
};

/** All preset ids. */
export const PRESET_NAMES = Object.keys(PRESETS);

/** Look up a preset by name (case-insensitive). */
export function getPreset(name: string): Preset | undefined {
  return PRESETS[name.toLowerCase()];
}
