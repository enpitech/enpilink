# Agent surface layer (agent analytics)

AI agents (ChatGPT, Claude, Gemini, crawlers) already fetch enpilink apps to
answer users. The **agent surface layer** lets an app **detect** those agents,
**serve** them a self-sufficient response, and **measure** whether they succeeded.
It is **off by default**, self-hosted, and sends nothing to enpitech — captured
data goes only to the app's own storage.

Use this when the user wants their app to be readable/measurable by AI agents, or
mentions agent analytics, SEO-for-agents, "ChatGPT can't see my site", or an SPA
being invisible to agents.

## The one thing to internalize first

Most agent traffic is **chat-mode** (ChatGPT web, Gemini web, Claude chat): it
makes **exactly one HTTP request and never comes back**. It runs no JavaScript. So
**the first response is the entire conversation** — everything must be in it. A
smaller, growing **agent/work mode** population (Comet, coding CLIs) does chain
requests, but do not design for it as the default.

**Never write prose addressed to an agent** ("if you are an AI, fetch this…") —
hardened agents refuse it as prompt injection. Use only clean markdown, semantic
HTML, and standard markup (`rel=search`, JSON-LD).

## Turn it on

Capture and serving are independent opt-ins (env or the Configuration tab):

```bash
ENPILINK_AGENT=1              # capture agent requests into storage (off by default)
ENPILINK_CFG_AGENT_SERVE=1    # serve the self-sufficient representation (off by default)
```

Declare what the app is, once, in the server setup — this is the source the
representation is built from:

```ts
server.describeForAgents({
  title: "Northwind",
  description: "An online store for outdoor gear.",
  facts: ["Ships worldwide", "Prices in USD"],
});
```

Keep it **descriptive, never imperative**. `agent.site.title` /
`agent.site.description` config keys override these fields when set.

## Installing on a standalone framework (one line)

If the app is NOT an enpilink `McpServer` (a plain Express/Hono/Next/Cloudflare
app), install the agent layer with a one-line adapter — each a subpath export of
the `enpilink` package. **Capture is ON the moment you mount the adapter** (mounting
IS the opt-in, unlike an MCP server, which waits for `ENPILINK_AGENT=1`); **serving
stays a separate opt-in** (`{ serve: true }`).

```ts
// Express / Node / NestJS — capture writes to sqlite (auto), no ENPILINK_ANALYTICS
import { agentCapture } from "enpilink/express";
app.use(agentCapture());                     // or agentCapture({ serve: true, siteTitle: "Acme" })

// Hono (Node runtime) — same shape; full header fidelity needs @hono/node-server
import { agentCapture } from "enpilink/hono";
app.use("*", agentCapture());

// Cloudflare Workers — full capture+detect+serve in the Worker, fail-open
import { agentCapture, d1CaptureSink } from "enpilink/cloudflare";
export default agentCapture({ serve: true, site: { title: "Acme" }, sink: (env) => d1CaptureSink(env.DB) });
```

```ts
// Next.js — edge capture-only; beacons to your own Node server's ingest sink
// middleware.ts
export { default } from "enpilink/next";     // env-configured; no-op until ENPILINK_AGENT_SINK_URL is set
```

**Account-free.** No login, no key. Detection data is fetched from a public ruleset
(see below); captured traffic goes only to the app's own storage. Full install guide
per framework: [docs.enpitech.dev/guides/agent-install](https://docs.enpitech.dev/guides/agent-install).

## Detection stays fresh from a live ruleset

The package is **pure logic — no detection data baked in**. It fetches a versioned
ruleset (`agent.ruleset.url`, default the enpitech public CDN),
**stale-while-revalidate**, so a request NEVER blocks on it. No ruleset yet →
capture still works and rows are `pending`, then **backfill** once it loads.
One-directional (rules in, nothing about traffic out); self-host by pointing
`agent.ruleset.url` at your own enpilink's `/__enpilink/agents/ruleset` (or a
`file://` path), or set `agent.ruleset.enabled=false`. See
[docs.enpitech.dev/guides/agent-detection-ruleset](https://docs.enpitech.dev/guides/agent-detection-ruleset).

## Serving modes (all behind one guardrail)

- **404-rescue** (`agent.serve`) — when an eligible chat fetcher would hit a 404,
  serve the representation (200) instead, recorded honestly as a rescued dead-end.
- **SPA mode** (`agent.spa`) — for a client-rendered app returning a 200 shell on
  every path, replace an eligible fetcher's empty shell with the representation.
- **Re-encode** (`agent.reencode`) — re-encode a real route's HTML to markdown
  (same facts, ~80% fewer tokens).

> **Cloaking guardrail (absolute):** same facts, different encoding — never
> different content. **Googlebot and every search indexer always get the normal
> page.** Only AI assistant fetchers are ever served. Violating this risks the
> app's organic search.

## GET transport (off by default, unproven)

A read-only, public tool can project to a plain `GET /agent/<path>` for the
multi-fetch minority:

```ts
server.registerTool(
  {
    name: "search",
    description: "Search the catalogue.",
    inputSchema: { q: z.string() },
    annotations: { readOnlyHint: true },
    securitySchemes: [{ type: "noauth" }],
    transports: { get: { path: "search", safe: true } },
  },
  async ({ q }) => ({ content: await search(q) }),
);
```

Enable with `ENPILINK_CFG_AGENT_GET_TRANSPORT=1`. A **registration-time safety
gate** throws (server won't start) unless the tool is read-only,
non-destructive, public (no auth), with a flat input schema — a mutating or authed
tool can never be GET-exposed. Framed honestly: chat agents can't reach it, and no
specific agent has yet been observed calling a standard affordance. Enable
deliberately, not by default.

## Measure

Read `GET /__enpilink/agents/summary` (open in dev, bearer-guarded in prod) or the
Console **Agents** tab: outcome classes (`resolved`/`dead_end`/`blocked`/`broken`),
dead-end rate by family/class, rescued dead-ends, and best-effort
recovery/escalation. Every correlation number carries a **coverage** fraction;
chat fetchers that share one vendor IP are labelled **`unsessionable`** (zero
sessions honestly, never a fiction).

## Deployment topologies

- **Single Node server (Express/Hono)** — capture writes straight to local storage
  (sqlite by default); nothing crosses a network.
- **Cloudflare Workers** — `agentCapture()` from `enpilink/cloudflare` does full
  capture+detect+serve in the Worker (fail-open); storage is D1 (`d1CaptureSink`) or
  a beacon to a Node server.
- **Next.js edge + beacon** — `enpilink/next` captures at the edge and POSTs to the
  app's own Node server's ingest sink (`POST /__enpilink/agents/ingest`, guarded by
  `ENPILINK_AGENT_INGEST_TOKEN`). The edge sees **less**: header casing/order (so
  Claude-chat's disguise isn't caught — UA-named agents are), HTTP version, the
  `ip-verified` tier, and downstream status are lost — the Node path stays the
  source of truth.

## Privacy

IPs are hashed with a per-site salt and never stored raw (raw IPs are stripped
from the captured header blob too). IP and UA are personal data under GDPR; the
app owner is the controller. Capture is off by default; `agent.sampleRate` and
`agent.retentionDays` are configurable.

## Config keys (all `agent.*`)

`agent.enabled`, `agent.sampleRate`, `agent.retentionDays`, `agent.verifyIpRanges`,
`agent.serve`, `agent.site.title`, `agent.site.description`, `agent.spa`,
`agent.reencode`, `agent.getTransport`, `agent.getRateLimit`, `agent.getRateBurst`,
and the ruleset keys `agent.ruleset.enabled` (default true), `agent.ruleset.url`,
`agent.ruleset.ttlSeconds`, `agent.ruleset.timeoutMs`, `agent.ruleset.mode`
(all runtime, DB-editable), and `agent.ingestToken` (secret, env-only).

Full docs: [docs.enpitech.dev/guides/agent-analytics](https://docs.enpitech.dev/guides/agent-analytics)
