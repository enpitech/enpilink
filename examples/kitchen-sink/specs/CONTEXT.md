# Northwind Kitchen-Sink — Context

## What this is
A **generic-brand demo MCP App** built with enpilink, whose purpose is to
exercise **every framework feature and all four mcp-ui interaction types** in one
small app. It doubles as the not-empty starter a developer can copy and edit.

"Northwind" is a fictional coffee/tea store (English, LTR). The brand is
deliberately neutral — the point is the framework, not the store. The framework
attribution is always **enpitech** ("Built with enpilink · powered by Enpitech").

## Mock-only ground rules
- All data is fake: customer `NW-CUST-001` (Ada Merchant), products `NW-P-1xx`,
  orders `NW-ORD-5xxx`. No real PII, no real money.
- **Deterministic:** a frozen `TODAY = 2026-06-14`, no `Math.random`, no
  `new Date()` in domain code, stable FNV-1a-derived ids. Re-running a tool gives
  identical output — demos and tests reproduce.
- The sign-in OTP is always `000000` (a clearly-fake auth beat for the
  agent-usage story).

## The four mcp-ui interaction types (and how honest the support is)
enpilink first-classes **tool** + **prompt** (from upstream skybridge) and added
**notify** + **intent** in M4.5 so all four exist:
- **tool** (`useCallTool`) — real on both runtimes; emulator executes it.
- **prompt** (`useSendFollowUpMessage`) — real on both; emulator logs only.
- **notify** (`useNotify`) — **real** MCP `notifications/message` on the MCP Apps
  runtime; an **enpilink extension** on the ChatGPT Apps SDK. `success`→`info` on
  MCP Apps.
- **intent** (`useIntent`) — **enpilink extension on both** runtimes (no spec
  equivalent); best-effort, never throws.
- Emulator surfaces notify + intent in the **Logs drawer**, not as toasts.

This app exercises all four plus the host-capability hooks (useToolInfo,
useViewState, useDisplayMode, useRequestModal, useRequestSize, useFiles/useDownload,
useUser, useOpenExternal). See `README.md` for the full coverage table.
