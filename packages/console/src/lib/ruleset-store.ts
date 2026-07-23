import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { authedFetch } from "./admin-token-store.js";

/**
 * Detection-ruleset status client (D3): a TanStack Query hook + zod schema for
 * `GET /__enpilink/agents/ruleset/status`. The Agents tab's "Detection ruleset"
 * card consumes this to show the LIVE ruleset state — the version this server is
 * classifying with, when it last refreshed, its source, and the resolved
 * mode/TTL/URL. Mirrors `agents-store.ts`: `authedFetch` for the prod bearer, a
 * tolerant zod parse, and the `{ enabled: false }` degrade shape (never throws on
 * the disabled path).
 *
 * This is the CONSUMING client's state (what detection runs on), which is
 * distinct from the public artifact this server may self-host at
 * `/__enpilink/agents/ruleset`.
 */

const BASE = "/__enpilink/agents";

/** Live status when a ruleset client is bootstrapped (agent surface on). */
const rulesetStatusEnabledSchema = z.object({
  enabled: z.literal(true),
  /** A validated ruleset is held. `false` ⇒ detection is `pending`. */
  loaded: z.boolean(),
  /** The held ruleset version, or null when nothing has loaded yet. */
  version: z.string().nullable(),
  /** Epoch-ms the held ruleset was fetched, or null. */
  fetchedAt: z.number().nullable(),
  /** Where the held ruleset came from, or null. */
  source: z.enum(["network", "cache"]).nullable(),
  /** Resolved `agent.ruleset.mode`. */
  mode: z.enum(["live", "dev"]),
  /** Resolved `agent.ruleset.ttlSeconds` (0 ⇒ honor Cache-Control). */
  ttlSeconds: z.number(),
  /** Resolved `agent.ruleset.url`. */
  url: z.string(),
  /** Resolved `agent.ruleset.enabled` — whether network fetching is on. */
  fetchEnabled: z.boolean(),
});

/** Degraded shape — no ruleset client bootstrapped (agent surface off). */
const rulesetStatusDisabledSchema = z.object({ enabled: z.literal(false) });

export const rulesetStatusSchema = z.discriminatedUnion("enabled", [
  rulesetStatusEnabledSchema,
  rulesetStatusDisabledSchema,
]);

export type RulesetStatus = z.infer<typeof rulesetStatusSchema>;
export type RulesetStatusEnabled = z.infer<typeof rulesetStatusEnabledSchema>;

/**
 * Poll the detection-ruleset status. 10s cadence (freshness state changes
 * slowly). Does NOT require an MCP connection. Tolerant parse — unknown fields
 * are ignored so the API can grow.
 */
export function useRulesetStatus() {
  return useQuery({
    queryKey: ["agents", "ruleset", "status"],
    queryFn: async (): Promise<RulesetStatus> => {
      const res = await authedFetch(`${BASE}/ruleset/status`);
      if (!res.ok) {
        throw new Error(`ruleset status failed (${res.status})`);
      }
      return rulesetStatusSchema.parse(await res.json());
    },
    refetchInterval: 10_000,
  });
}
