import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { authedFetch } from "./admin-token-store.js";

/**
 * Configuration client: TanStack Query hooks for the config admin API.
 *
 * Endpoints:
 * - `GET    /__enpilink/config`              — settings + rich metadata.
 * - `PUT    /__enpilink/config/:key`         — set a runtime/restart key.
 * - `DELETE /__enpilink/config/:key`         — reset a key to its default.
 * - `GET    /__enpilink/config/presets`      — available presets.
 * - `POST   /__enpilink/config/preset/:name` — apply a preset.
 * - `GET    /__enpilink/config/audit`        — change history.
 *
 * Fetched relative to `window.location.origin`. Secrets are returned masked by
 * the API (`secret: true`, `value: "••••••"`); the UI renders them read-only
 * and NEVER attempts to display a plaintext secret.
 */

const BASE = "/__enpilink/config";

const settingSchema = z.object({
  key: z.string(),
  tier: z.enum(["bootstrap", "runtime"]),
  value: z.unknown(),
  source: z.enum(["env", "file", "db", "default"]),
  secret: z.boolean(),
  envLocked: z.boolean(),
  env: z.string(),
  label: z.string(),
  description: z.string(),
  group: z.string(),
  unit: z.string().optional(),
  default: z.unknown().optional(),
  editable: z.enum(["runtime", "restart", "readonly"]),
  modified: z.boolean(),
  restartRequired: z.boolean(),
});

export type Setting = z.infer<typeof settingSchema>;

const configResponseSchema = z.object({
  settings: z.array(settingSchema),
});

const presetSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  values: z.record(z.string(), z.unknown()),
});

export type Preset = z.infer<typeof presetSchema>;

const presetsResponseSchema = z.object({
  presets: z.array(presetSchema),
});

const auditEntrySchema = z.object({
  ts: z.number(),
  key: z.string(),
  oldValue: z.unknown().optional(),
  // Absent (reset to default) or any JSON value.
  newValue: z.unknown().optional(),
  actor: z.string(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

const auditResponseSchema = z.object({
  enabled: z.boolean(),
  audit: z.array(auditEntrySchema),
});

const applyResultSchema = z.object({
  ok: z.boolean(),
  preset: z.string(),
  applied: z.array(z.object({ key: z.string(), value: z.unknown() })),
  skipped: z.array(z.object({ key: z.string(), reason: z.string() })),
});

export type ApplyResult = z.infer<typeof applyResultSchema>;

export function useConfig() {
  return useQuery({
    queryKey: ["config", "settings"],
    queryFn: async (): Promise<Setting[]> => {
      const res = await authedFetch(BASE);
      if (!res.ok) {
        throw new Error(`config failed (${res.status})`);
      }
      return configResponseSchema.parse(await res.json()).settings;
    },
    refetchInterval: 10_000,
  });
}

export function usePresets() {
  return useQuery({
    queryKey: ["config", "presets"],
    queryFn: async (): Promise<Preset[]> => {
      const res = await authedFetch(`${BASE}/presets`);
      if (!res.ok) {
        throw new Error(`presets failed (${res.status})`);
      }
      return presetsResponseSchema.parse(await res.json()).presets;
    },
  });
}

export function useConfigAudit() {
  return useQuery({
    queryKey: ["config", "audit"],
    queryFn: async (): Promise<AuditEntry[]> => {
      const res = await authedFetch(`${BASE}/audit`);
      if (!res.ok) {
        throw new Error(`audit failed (${res.status})`);
      }
      return auditResponseSchema.parse(await res.json()).audit;
    },
    refetchInterval: 10_000,
  });
}

/** Set a runtime or restart-tier config key. Throws with the API's message. */
export function useSetConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: unknown }) => {
      const res = await authedFetch(`${BASE}/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(json?.error ?? `update failed (${res.status})`);
      }
      return json;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["config"] });
    },
  });
}

/** Reset a config key to its default (clears the DB override). */
export function useResetConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key }: { key: string }) => {
      const res = await authedFetch(`${BASE}/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(json?.error ?? `reset failed (${res.status})`);
      }
      return json;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["config"] });
    },
  });
}

/** Apply a named preset (runtime keys only; env-locked keys are skipped). */
export function useApplyPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name }: { name: string }): Promise<ApplyResult> => {
      const res = await authedFetch(
        `${BASE}/preset/${encodeURIComponent(name)}`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const err = (json as { error?: string } | null)?.error;
        throw new Error(err ?? `preset failed (${res.status})`);
      }
      return applyResultSchema.parse(json);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["config"] });
    },
  });
}
