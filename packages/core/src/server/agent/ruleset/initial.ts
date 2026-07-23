import { DEFAULT_VENDOR_LISTS } from "../ip-ranges.js";
import { parseRuleset } from "./schema.js";
import type { Ruleset } from "./types.js";

/**
 * THE INITIAL RULESET — today's hardcoded `detect.ts` + `ip-ranges.ts` rules,
 * extracted verbatim into DATA (D1).
 *
 * Purpose, and ONLY purpose:
 * 1. **Test fixture.** Every `classify()` behaviour test loads this and asserts
 *    the SAME family/class/confidence the old hardcoded classifier produced — the
 *    behaviour-preserving proof.
 * 2. **The seed for D3's first CDN artifact.** D3's publish pipeline starts from
 *    this content, versions it, and serves it. D2's client fetches THAT artifact.
 *
 * It is **NOT a runtime fallback.** The classifier never reaches for it, and the
 * holder never defaults to it (the no-baseline decision). With no ruleset loaded,
 * classification is `pending`.
 *
 * Passed through {@link parseRuleset} at import so any authoring drift from the
 * schema (a bad regex, a stray field) throws loudly here rather than misbehaving
 * at classification time. This import is off the hot path (tests + the seed only).
 */
const RAW = {
  // A stable sentinel version. D3 assigns real versions to published artifacts.
  version: "initial-2026-07",

  // ── UA-naming rules, IN ORDER (first match wins) ───────────────────────────
  // Ported one-for-one from `detect.ts`'s UA cascade. Order matters: the two
  // Perplexity rules replace the old inline sub-branch (the more specific
  // `Perplexity-User` first); `claude-code` precedes `Claude-User` so the CLI is
  // named before the chat fetcher (the CLI UA carries both tokens).
  uaPatterns: [
    {
      id: "chatgpt-user",
      pattern: "ChatGPT-User",
      family: "chatgpt-user",
      class: "chat-fetcher",
      confidence: "ua-only",
      // `hasSecFetch ? ua-only : ua+shape` — the shape corroborates when a
      // browser tell (`Sec-Fetch-*`) is absent.
      corroboration: { confidence: "ua+shape", requireNoSecFetch: true },
    },
    {
      id: "gptbot",
      pattern: "GPTBot",
      family: "gptbot",
      class: "crawler",
      confidence: "ua-only",
    },
    {
      id: "oai-searchbot",
      pattern: "OAI-SearchBot",
      family: "oai-searchbot",
      class: "crawler",
      confidence: "ua-only",
    },
    {
      id: "gemini",
      // The entire UA is the bare word "Google".
      pattern: "^Google$",
      family: "gemini",
      class: "chat-fetcher",
      confidence: "ua-only",
      // `!hasSecFetch && headerCount <= 6 ? ua+shape : ua-only`.
      corroboration: {
        confidence: "ua+shape",
        requireNoSecFetch: true,
        maxHeaderCount: 6,
      },
    },
    {
      id: "googlebot",
      pattern: "Googlebot",
      family: "googlebot",
      class: "crawler",
      confidence: "ua-only",
    },
    {
      id: "claude-code",
      pattern: "claude-code",
      family: "claude-code",
      class: "cli",
      confidence: "ua-only",
    },
    {
      id: "claudebot",
      pattern: "ClaudeBot",
      family: "claudebot",
      class: "crawler",
      confidence: "ua-only",
    },
    {
      id: "claude-user",
      pattern: "Claude-User",
      family: "claude-user",
      class: "chat-fetcher",
      confidence: "ua-only",
    },
    {
      id: "perplexity-user",
      pattern: "Perplexity-User",
      family: "perplexity-user",
      class: "chat-fetcher",
      confidence: "ua-only",
    },
    {
      id: "perplexitybot",
      pattern: "Perplexity",
      family: "perplexitybot",
      class: "crawler",
      confidence: "ua-only",
    },
    {
      id: "bytespider",
      pattern: "Bytespider",
      family: "bytespider",
      class: "crawler",
      confidence: "ua-only",
    },
    {
      id: "meta",
      pattern: "meta-external",
      family: "meta",
      class: "crawler",
      confidence: "ua-only",
    },
    {
      id: "http-client",
      // A plain, self-declaring HTTP client / scraper. The family is derived from
      // the leading UA token (the `httpClientName` method).
      pattern:
        "curl|wget|python-requests|python-httpx|aiohttp|libwww|okhttp|java\\/|Go-http-client|axios|node-fetch|got |undici|scrapy",
      family: null,
      familyFrom: "ua-token",
      class: "tool",
      confidence: "ua-only",
    },
  ],

  // ── SHAPE rules, IN ORDER (after every UA rule fails) ──────────────────────
  // Ported one-for-one from `detect.ts`'s shape cascade. The `always` catch-all
  // is last; classification is total.
  shapeRules: [
    {
      // Claude web/desktop disguised as Chrome — title-cased `Sec-Ch-Ua*` on a
      // Chrome UA (real Chrome sends them lowercase). SHAPE, not UA.
      id: "claude-web-disguise",
      when: "title-cased-hints-and-ua",
      uaPattern: "Chrome",
      uaFlags: "i",
      family: "claude-web",
      class: "chat-fetcher",
      confidence: "shape",
    },
    {
      // Title-cased hints without a Chrome UA — an HTTP library posing as a
      // browser, unnamed. Surface for the corpus.
      id: "title-cased-unnamed",
      when: "title-cased-hints",
      family: null,
      class: "unknown",
      confidence: "shape",
    },
    {
      // Behind Envoy but the UA didn't name it → vendor infrastructure, unnamed.
      id: "envoy-unnamed",
      when: "envoy",
      family: null,
      class: "unknown",
      confidence: "shape",
    },
    {
      // Full browser shape (Sec-Fetch present) — a human OR an on-device browser
      // agent, byte-for-byte indistinguishable.
      id: "browser-shape",
      when: "has-sec-fetch",
      family: null,
      class: "human-or-browser",
      confidence: "shape",
    },
    {
      // No `Sec-Fetch-*` but some headers → NOT a browser; unnamed scraper.
      id: "non-browser-unnamed",
      when: "has-headers",
      family: null,
      class: "unknown",
      confidence: "shape",
    },
    {
      // Nothing to go on (no headers).
      id: "empty",
      when: "always",
      family: null,
      class: "unknown",
      confidence: "none",
    },
  ],

  // ── IP-range tier DATA (ported from `ip-ranges.ts`) ────────────────────────
  ipRanges: {
    // The published-list URLs the verifier fetches at runtime (never vendored).
    vendorLists: DEFAULT_VENDOR_LISTS,
    // `vendorForFamily`, as data — only families expected to originate from a
    // vendor's ranges (crawlers + vendor-hosted fetchers). Off-network families
    // (`claude-code` on a dev IP, browser agents on consumer IPs) are absent, so
    // an IP miss is never mistaken for a spoof.
    familyToVendor: {
      gptbot: "openai",
      "chatgpt-user": "openai",
      "oai-searchbot": "openai",
      googlebot: "google",
      gemini: "google",
      claudebot: "anthropic",
      "claude-user": "anthropic",
      "claude-web": "anthropic",
      perplexitybot: "perplexity",
      "perplexity-user": "perplexity",
    },
  },
} as const;

/**
 * The initial ruleset — validated + normalised (regex `flags` defaulted to `"i"`)
 * at import. Exported for tests + as D3's seed; NEVER the runtime fallback.
 */
export const INITIAL_RULESET: Ruleset = parseRuleset(RAW);
