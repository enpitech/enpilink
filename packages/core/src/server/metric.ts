import type { McpMiddlewareEntry } from "./middleware.js";

/**
 * Metrics are removed in enpilink. Upstream emitted a DogStatsD/UDP counter to
 * a hardcoded vendor IP for every tool call; that coupling is gone.
 *
 * This is a no-op stub that always returns `null`, so the server installs no
 * monitoring middleware and performs zero network activity.
 */
export function createMiddlewareEntry(): McpMiddlewareEntry | null {
  return null;
}
