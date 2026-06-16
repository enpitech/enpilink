# Northwind — enpilink Kitchen-Sink Demo

A **generic-brand showcase** MCP App built with [enpilink](https://docs.enpitech.dev).
"Northwind" is a fictional coffee/tea store; its purpose is to **exercise every
enpilink framework feature and all four mcp-ui interaction types** in one place,
and to serve as a not-empty starter you can build on.

> **Mock data only.** Fake customers (`NW-CUST-001`), fake products (`NW-P-…`),
> a frozen "today" (`2026-06-14`), no RNG, no real money, no real PII. Re-running
> any tool yields identical numbers — the demo reproduces exactly.
>
> Built with **enpilink** · powered by **Enpitech**. (enpilink is shown as a
> plain wordmark; the only logo image in the app is the real Enpitech mark.)

## What it demonstrates

9 tools, 9 views, all four mcp-ui interaction types, and every enpilink host hook.

### Tools → views

| Tool | View | What it shows |
|---|---|---|
| `home` | `home` | The hub: greet by device/locale, docs link, the 3 interaction buttons. |
| `browse_catalog` | `catalog` | Filter/sort the catalog; per-item details/modal/add-to-cart. |
| `product_details` | `product` | One product; expand panel (resize), enlarge (modal), external link. |
| `view_cart` | `cart` | Price a cart (Plus 10% off); checkout + ask-the-model. |
| `checkout` | `checkout` | Deterministic order confirmation + a success notification. |
| `my_orders` | `orders` | Order history; toggle inline ↔ fullscreen. |
| `my_account` | `account` | Profile, loyalty points, receipt download + avatar upload. |
| `sign_in` | `signin` | Mock OTP flow (the demo code is `000000`). |
| `feature_matrix` | `features` | Self-documenting coverage table (reads its own tool-info). |

### Feature → tool → view → interaction → per-runtime support

| Feature | Hook | Tool | View | mcp-ui type | MCP Apps | ChatGPT Apps SDK | Emulator |
|---|---|---|---|---|---|---|---|
| Call another tool | `useCallTool` | `browse_catalog`, `view_cart` | catalog, cart | **tool** | ✅ real | ✅ real | ✅ executes |
| Send a follow-up prompt | `useSendFollowUpMessage` | `home`, `view_cart` | home, cart | **prompt** | ✅ real | ✅ real | logged only |
| Notify the host | `useNotify` | `checkout`, `sign_in`, … | checkout, signin, home, catalog | **notify** | ✅ real (`notifications/message`) | ⚠️ enpilink ext | shown in Logs drawer |
| High-level intent | `useIntent` | `home`, `browse_catalog`, `product_details` | home, catalog, product | **intent** | ⚠️ enpilink ext | ⚠️ enpilink ext | shown in Logs drawer |
| Read tool input/output | `useToolInfo` | all | all | — | ✅ | ✅ | ✅ |
| Persisted UI state | `useViewState` | `browse_catalog` | catalog | — | ✅ | ✅ | ✅ |
| Display mode (inline↔fullscreen) | `useDisplayMode` | `my_orders`, `home` | orders, home | — | ✅ | ✅ | ✅ |
| Details modal | `useRequestModal` | `browse_catalog`, `product_details` | catalog, product | — | ✅ | ✅ | ✅ |
| Resize the view | `useRequestSize` | `product_details` | product | — | ✅ | ✅ | ✅ |
| Files: download/upload | `useDownload` / `useFiles` | `my_account` | account | — | degrades to a notice | ✅ real | degrades to a notice |
| User device/locale | `useUser` | `home`, `my_account` | home, account | — | ✅ | ✅ | ✅ |
| Open external URL | `useOpenExternal` | `home`, `my_account`, `product_details` | home, account, product | — | ✅ | ✅ | ✅ |

> **Honesty section — per-runtime interaction support.** enpilink first-classes
> **tool** + **prompt** (from upstream). **notify** + **intent** were added by
> enpilink (M4.5) so all four mcp-ui types exist:
> - **notify** is delivered over the **real** MCP `notifications/message`
>   protocol on the MCP Apps runtime (so a compliant host actually receives it).
>   On the ChatGPT Apps SDK there is no native notify method, so it is an
>   **enpilink extension** (a `window.openai.notify` host hook, else a
>   `postMessage` fallback). `level: "success"` has no syslog equivalent and is
>   coerced to `"info"` on MCP Apps (original level preserved in the payload).
> - **intent** has **no equivalent in either spec** — it is an **enpilink
>   extension on both runtimes**, best-effort, and a host that doesn't route it
>   simply records a log line. It never throws.
> - In the **Console / local playground**, notify and intent appear as entries in the
>   **Logs drawer** (not toasts), and `prompt` is logged only (no model turn
>   runs locally). `tool` executes for real.

## Prerequisites

- Node.js ≥ 22.
- For the Claude demo: Claude with custom-connector / MCP support.

## Install · build · test

> On a fresh checkout run `pnpm install && pnpm build` **before** `tsc` — the
> build generates `.enpilink/views.d.ts` (gitignored), which the typecheck needs
> (otherwise `ViewName` resolves to `never`).

```bash
pnpm install
pnpm -F enpilink-kitchen-sink build      # enpilink build + tsc-alias
pnpm -F enpilink-kitchen-sink typecheck  # tsc --noEmit, 0 errors
pnpm -F enpilink-kitchen-sink test       # vitest — domain + determinism tests
```

## Run locally (Console)

```bash
pnpm -F enpilink-kitchen-sink dev        # pick a free port, e.g. -p 5050
```

Open the printed URL, click a tool's **Run**, and exercise the view. Notify and
intent show up in the **Logs drawer**.

## Connect to Claude

1. From this directory, start a public tunnel:
   ```bash
   pnpm -F enpilink-kitchen-sink dev:tunnel   # or: enpilink dev --tunnel
   ```
   This prints a `https://<hash>.srv.us/mcp` URL (account-free).
2. In Claude → **Settings → Connectors → Custom connector**, add that `/mcp` URL.
3. Paste [`specs/SYSTEM_PROMPT.md`](specs/SYSTEM_PROMPT.md) into the Claude
   project's **custom instructions** (an MCP server can't set the host system
   prompt, so this is how the persona + trigger map are installed).
4. Try a prompt from [`specs/DEMO.md`](specs/DEMO.md), e.g. *"Show me the
   Northwind store"* → the `home` view renders.

## Docs in this app

- [`specs/SYSTEM_PROMPT.md`](specs/SYSTEM_PROMPT.md) — paste-into-Claude persona + per-tool trigger map.
- [`specs/DEMO.md`](specs/DEMO.md) — operator runbook with exact prompts and frozen numbers.
- [`specs/CONTEXT.md`](specs/CONTEXT.md), [`specs/BRAND.md`](specs/BRAND.md), [`specs/ARCHITECTURE.md`](specs/ARCHITECTURE.md), [`specs/PLAN.md`](specs/PLAN.md), [`specs/EXAMPLES.md`](specs/EXAMPLES.md).
