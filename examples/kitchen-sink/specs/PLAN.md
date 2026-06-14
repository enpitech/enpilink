# Northwind Kitchen-Sink — Plan

**Goal:** a generic-brand enpilink demo that exercises every framework feature +
all 4 mcp-ui interaction types, with agent-usage docs. Built as repo milestone M5.

## Status: ✅ complete (2026-06-14)

- 9 tools / 9 views, deterministic mock data, all 4 interaction types wired.
- Build (`enpilink build && tsc-alias`) + typecheck + `vitest` green; `/mcp`
  smoke returns all tools with both `structuredContent` and `content`.
- Doc set: README (coverage tables + connect-to-Claude + honesty section),
  SYSTEM_PROMPT, DEMO, CONTEXT, BRAND, ARCHITECTURE, EXAMPLES.
- Playwright visual check: `specs/assets/m5-kitchen-sink.png` (home view +
  notify/intent in the Logs drawer).

## Coverage checklist
- [x] tool (`useCallTool`) · prompt (`useSendFollowUpMessage`) · notify
      (`useNotify`) · intent (`useIntent`)
- [x] useToolInfo, useViewState, useDisplayMode, useRequestModal, useRequestSize,
      useFiles/useDownload, useUser, useOpenExternal
- [x] one tool+view per row; README maps feature → tool → view → interaction →
      per-runtime support; honesty section on notify/intent support
- [x] deterministic (frozen TODAY, FNV-1a ids, no RNG) — tests assert it
- [x] mock-only disclosure; enpilink as plain wordmark; real Enpitech logo badge
