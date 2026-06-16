import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

/**
 * Configuration client (M4): TanStack Query hooks for the config admin API
 * (`GET /__enpilink/config`, `PUT /__enpilink/config/:key`,
 * `GET /__enpilink/config/audit`). The Configuration tab consumes these.
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
});

export type Setting = z.infer<typeof settingSchema>;

const configResponseSchema = z.object({
  settings: z.array(settingSchema),
});

const auditEntrySchema = z.object({
  ts: z.number(),
  key: z.string(),
  oldValue: z.unknown().optional(),
  newValue: z.unknown(),
  actor: z.string(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

const auditResponseSchema = z.object({
  enabled: z.boolean(),
  audit: z.array(auditEntrySchema),
});

export function useConfig() {
  return useQuery({
    queryKey: ["config", "settings"],
    queryFn: async (): Promise<Setting[]> => {
      const res = await fetch(BASE);
      if (!res.ok) {
        throw new Error(`config failed (${res.status})`);
      }
      return configResponseSchema.parse(await res.json()).settings;
    },
    refetchInterval: 10_000,
  });
}

export function useConfigAudit() {
  return useQuery({
    queryKey: ["config", "audit"],
    queryFn: async (): Promise<AuditEntry[]> => {
      const res = await fetch(`${BASE}/audit`);
      if (!res.ok) {
        throw new Error(`audit failed (${res.status})`);
      }
      return auditResponseSchema.parse(await res.json()).audit;
    },
    refetchInterval: 10_000,
  });
}

/** Set a runtime, non-secret config key. Throws with the API's error message. */
export function useSetConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: unknown }) => {
      const res = await fetch(`${BASE}/${encodeURIComponent(key)}`, {
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
