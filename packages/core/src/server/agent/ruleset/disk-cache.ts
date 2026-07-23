import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CachedRuleset, RulesetCacheStore } from "./cache-store.js";

/**
 * The Node PERSISTED-CACHE store (D2) — writes the validated ruleset to disk so
 * a restart warms instantly from the file instead of waiting on the network.
 *
 * This is the Node seam behind {@link RulesetCacheStore}: it is the ONE place
 * `node:fs` enters the ruleset client, kept out of the runtime-neutral core (and
 * therefore out of any edge bundle). The edge equivalent — a KV / Cache-API
 * store — is D4/adapter territory and implements the same interface.
 *
 * Reads never throw (an absent/corrupt file ⇒ `null` ⇒ a cold fetch); the loaded
 * body is re-validated by the client with `parseRuleset` before it goes live, so
 * a tampered cache file cannot inject a live ruleset. Writes are atomic
 * (temp-file + rename) so a crash mid-write can never leave a torn cache.
 */
export class DiskRulesetCacheStore implements RulesetCacheStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<CachedRuleset | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "body" in parsed &&
        "fetchedAt" in parsed
      ) {
        const entry = parsed as Record<string, unknown>;
        const fetchedAt =
          typeof entry.fetchedAt === "number" ? entry.fetchedAt : 0;
        const maxAgeSeconds =
          typeof entry.maxAgeSeconds === "number" ? entry.maxAgeSeconds : null;
        return { body: entry.body, fetchedAt, maxAgeSeconds };
      }
      return null;
    } catch {
      // Absent / unreadable / malformed → treat as no cache (cold fetch).
      return null;
    }
  }

  async save(entry: CachedRuleset): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), "utf8");
    // Atomic replace — a reader never observes a half-written file.
    await rename(tmp, this.filePath);
  }
}
