import type {
  AgentClass,
  AgentConfidence,
  HeaderPair,
} from "../storage/types.js";

/**
 * The agent detection engine (M2) — fingerprint FIRST, User-Agent only to NAME
 * the client, IP only as an optional confidence tier (handled by the caller, see
 * `ip-ranges.ts`).
 *
 * This module is a PURE function of plain data — no Node, no clock, no crypto, no
 * I/O — exactly like `capture.ts`. That is what makes it trivially testable
 * against the real captured header sets (HOW-AGENTS-READ-PAGES §2) and reusable
 * from a future edge/Next adapter.
 *
 * WHY SHAPE FIRST (the settled, non-negotiable principle):
 * - There is no attack surface — the content is public, read-only, and already
 *   scrapeable — so nothing needs to be *proven* before serving. Rate limiting
 *   handles compute; identity is not a gate.
 * - IP lists are fragile and fundamentally incomplete: Meta publishes NONE yet is
 *   ~52% of AI crawler traffic; browser agents run on consumer IPs, CLIs on
 *   developer IPs. No list can ever cover them.
 * - The SHAPE of a request (which headers, in what order, with what casing)
 *   separates *not-a-browser* from *a-browser* with high confidence, maintains no
 *   external state, and GENERALISES to agents nobody has named yet.
 *
 * Every rule below is grounded in a request we actually captured on
 * `probe.parklug.de` (see HOW-AGENTS-READ-PAGES §2/§3). This is a typed, tested
 * hardening of the reference `classify()` in `specs/…/probe/probe.mjs`.
 *
 * The confidence is always EXPOSED, never hidden ({@link AgentConfidence}): a
 * verified-IP hit and an unverified UA string must never be reported as equal.
 */

/**
 * The derived fingerprint of a request — the reusable primitives every rule is
 * built from. Recorded alongside the classification so the dashboard can surface
 * an unrecognised client by its shape ("340 requests from a client we don't know
 * — here is its fingerprint"), which is how the supported-agents corpus grows.
 */
export interface DetectionSignals {
  /** Number of header pairs on the request. */
  headerCount: number;
  /** Any `Sec-Fetch-*` header present. Its ABSENCE means "not a browser". */
  hasSecFetch: boolean;
  /** Any `Sec-Ch-Ua*` client-hint header present (case-insensitive). */
  hasClientHints: boolean;
  /**
   * Any client-hint header sent TITLE-CASED (`Sec-Ch-Ua`, not `sec-ch-ua`). Real
   * Chrome emits these lowercase; an HTTP library that title-cases them is not
   * Chrome, whatever its UA claims. THE single best disguise tell we found.
   */
  titleCasedClientHints: boolean;
  /** Any `X-Envoy-*` header present → vendor proxy infrastructure (ChatGPT leaks this). */
  envoy: boolean;
  /** `Accept` prefers/allows `text/markdown` (only Claude Code asks for it). */
  wantsMarkdown: boolean;
  /**
   * Both `Cache-Control` and `Pragma` present on a navigation — Claude's fetcher
   * sends `no-cache`/`no-cache`; a real Chrome navigation does not.
   */
  noCacheOnNav: boolean;
  /**
   * `Accept-Encoding` lists `zstd` FIRST with no spaces (`zstd,gzip,deflate,br`)
   * — Claude's shape; Chrome sends `gzip, deflate, br, zstd` (spaces, zstd last).
   */
  zstdFirst: boolean;
  /** First ~64 chars of the `Accept` value (for the corpus view). */
  accept: string;
  /** The raw `Accept-Encoding` value (for the corpus view). */
  acceptEncoding: string;
  /** The `Sec-Ch-Ua-Platform` claim (e.g. `Linux`, `"macOS"`), or null. */
  platformClaim: string | null;
  /**
   * The platform claim CONTRADICTS the UA's OS token (e.g. `Sec-Ch-Ua-Platform:
   * Windows` with a `Macintosh` UA). A disagreement is a tell.
   */
  platformContradictsUa: boolean;
}

/**
 * A classification verdict. `family` NAMES the client where the UA gives us a
 * name (or null); `class` is the behavioural taxonomy that predicts behaviour;
 * `confidence` is exposed honestly; `signals` is the derived fingerprint.
 */
export interface Detection {
  /** Named vendor/client (`gptbot`, `chatgpt-user`, `claude-web`, …), or null. */
  family: string | null;
  /** Behavioural taxonomy class. */
  class: AgentClass;
  /** How much to trust this — never hidden. */
  confidence: AgentConfidence;
  /** The derived fingerprint primitives. */
  signals: DetectionSignals;
}

/** Lowercase a header name once. */
function lower(name: string): string {
  return name.toLowerCase();
}

/**
 * Map a UA string to the OS it claims, or null. Used to cross-check the
 * `Sec-Ch-Ua-Platform` client-hint claim (a disagreement is a disguise tell).
 */
function osFromUa(ua: string): string | null {
  if (/android/i.test(ua)) {
    return "android";
  }
  if (/iphone|ipad|\bios\b/i.test(ua)) {
    return "ios";
  }
  if (/windows nt/i.test(ua)) {
    return "windows";
  }
  if (/mac os x|macintosh/i.test(ua)) {
    return "macos";
  }
  if (/\blinux\b/i.test(ua)) {
    return "linux";
  }
  return null;
}

/** Normalise a `Sec-Ch-Ua-Platform` value (strip quotes/case) to an OS token. */
function normPlatform(raw: string): string | null {
  const v = raw.replace(/["']/g, "").trim().toLowerCase();
  if (v === "") {
    return null;
  }
  if (v.startsWith("mac")) {
    return "macos";
  }
  if (v.startsWith("windows")) {
    return "windows";
  }
  if (v.startsWith("android")) {
    return "android";
  }
  if (v === "ios") {
    return "ios";
  }
  if (v.startsWith("linux")) {
    return "linux";
  }
  return null;
}

/** Derive the reusable fingerprint primitives from the raw header pairs. */
export function deriveSignals(
  pairs: readonly HeaderPair[],
  ua: string,
): DetectionSignals {
  let hasSecFetch = false;
  let hasClientHints = false;
  let titleCasedClientHints = false;
  let envoy = false;
  const values: Record<string, string> = {};
  for (const [name, value] of pairs) {
    if (/^sec-fetch-/i.test(name)) {
      hasSecFetch = true;
    }
    if (/^sec-ch-ua/i.test(name)) {
      hasClientHints = true;
      // Real Chrome sends client hints LOWERCASE; a title-cased variant (`Sec-`)
      // is an HTTP library pretending to be Chrome — the marquee disguise tell.
      if (/^Sec-Ch-Ua/.test(name)) {
        titleCasedClientHints = true;
      }
    }
    if (/^x-envoy/i.test(name)) {
      envoy = true;
    }
    const lk = lower(name);
    if (!(lk in values)) {
      values[lk] = value;
    }
  }

  const accept = values.accept ?? "";
  const acceptEncoding = values["accept-encoding"] ?? "";
  const platformClaim = values["sec-ch-ua-platform"] ?? null;
  const uaOs = osFromUa(ua);
  const claimedOs = platformClaim ? normPlatform(platformClaim) : null;

  return {
    headerCount: pairs.length,
    hasSecFetch,
    hasClientHints,
    titleCasedClientHints,
    envoy,
    wantsMarkdown: /text\/markdown/i.test(accept),
    noCacheOnNav: "cache-control" in values && "pragma" in values,
    zstdFirst: /^\s*zstd\b/i.test(acceptEncoding),
    accept: accept.slice(0, 64),
    acceptEncoding,
    platformClaim,
    platformContradictsUa:
      uaOs !== null && claimedOs !== null && uaOs !== claimedOs,
  };
}

/** UA substrings that mark a plain, self-declaring HTTP client / scraper. */
const HTTP_CLIENT_RE =
  /curl|wget|python-requests|python-httpx|aiohttp|libwww|okhttp|java\/|Go-http-client|axios|node-fetch|got |undici|scrapy/i;

/**
 * Classify a request from its header pairs (shape first, UA to name). Pure and
 * total: same inputs → same {@link Detection}, no side effects. `ua` may be
 * passed explicitly; when omitted it is read from the pairs. The optional IP
 * confidence tier is NOT applied here (it needs the raw client IP + a network
 * cache) — the caller upgrades `confidence` to `ip-verified` / flags a spoof; see
 * `express-middleware.ts` + `ip-ranges.ts`.
 */
export function classify(pairs: readonly HeaderPair[], ua?: string): Detection {
  const signals = deriveSignals(pairs, ua ?? headerUa(pairs));
  const uaStr = (ua ?? headerUa(pairs)).trim();
  const det = (
    family: string | null,
    cls: AgentClass,
    confidence: AgentConfidence,
  ): Detection => ({ family, class: cls, confidence, signals });

  // ── NAME IT (UA) ───────────────────────────────────────────────────────────
  // A vendor whose SHAPE we captured and confirmed (`ChatGPT-User`, Gemini) earns
  // `ua+shape` only while the shape actually corroborates the claim (no
  // `Sec-Fetch-*`); everything else named purely by an easily-spoofable UA string
  // stays `ua-only`. The IP tier (caller) can upgrade a matching vendor to
  // `ip-verified`.

  // ChatGPT web (chat) — declares `ChatGPT-User/1.0`; 16 headers, no Sec-Fetch,
  // leaks `X-Envoy-*`. A one-shot fetcher.
  if (/ChatGPT-User/i.test(uaStr)) {
    return det(
      "chatgpt-user",
      "chat-fetcher",
      signals.hasSecFetch ? "ua-only" : "ua+shape",
    );
  }
  // OpenAI crawlers — bulk, self-declaring, spoofable UA.
  if (/GPTBot/i.test(uaStr)) {
    return det("gptbot", "crawler", "ua-only");
  }
  if (/OAI-SearchBot/i.test(uaStr)) {
    return det("oai-searchbot", "crawler", "ua-only");
  }
  // Gemini web (chat) — the ENTIRE User-Agent is the word `Google`; 5 headers,
  // `Accept: */*`, no Sec-Fetch. A one-shot fetcher.
  if (/^Google$/i.test(uaStr)) {
    return det(
      "gemini",
      "chat-fetcher",
      !signals.hasSecFetch && signals.headerCount <= 6 ? "ua+shape" : "ua-only",
    );
  }
  // Googlebot — a search-indexing crawler. M3 MUST always serve it the normal
  // page (the cloaking guardrail); naming it here is what lets M3 enforce that.
  if (/Googlebot/i.test(uaStr)) {
    return det("googlebot", "crawler", "ua-only");
  }
  // Claude Code (CLI) — UA carries BOTH `claude-code` and `Claude-User`; match
  // the CLI marker FIRST so it names as `claude-code`, not the chat fetcher.
  if (/claude-code/i.test(uaStr)) {
    return det("claude-code", "cli", "ua-only");
  }
  if (/ClaudeBot/i.test(uaStr)) {
    return det("claudebot", "crawler", "ua-only");
  }
  if (/Claude-User/i.test(uaStr)) {
    return det("claude-user", "chat-fetcher", "ua-only");
  }
  if (/Perplexity/i.test(uaStr)) {
    const isUser = /Perplexity-User/i.test(uaStr);
    return det(
      isUser ? "perplexity-user" : "perplexitybot",
      isUser ? "chat-fetcher" : "crawler",
      "ua-only",
    );
  }
  if (/Bytespider/i.test(uaStr)) {
    return det("bytespider", "crawler", "ua-only");
  }
  if (/meta-external/i.test(uaStr)) {
    return det("meta", "crawler", "ua-only");
  }
  if (HTTP_CLIENT_RE.test(uaStr)) {
    return det(httpClientName(uaStr), "tool", "ua-only");
  }

  // ── SHAPE ONLY (no vendor name, or a disguised one) ──────────────────────────

  // Claude web/desktop chat DISGUISES itself as Chrome on Linux — no "Claude" in
  // the UA. Tell: title-cased `Sec-Ch-Ua*` with a Chrome UA (real Chrome is
  // lowercase). Corroborated by `Cache-Control`+`Pragma`, `zstd`-first encoding,
  // and a `Linux` platform claim (all recorded in `signals`). SHAPE, not UA.
  if (signals.titleCasedClientHints && /Chrome/i.test(uaStr)) {
    return det("claude-web", "chat-fetcher", "shape");
  }
  // Title-cased client hints without a Chrome UA: still an HTTP library posing as
  // a browser, but we can't name it — surface it for the corpus.
  if (signals.titleCasedClientHints) {
    return det(null, "unknown", "shape");
  }
  // Behind Envoy but the UA didn't name it → vendor infrastructure, unnamed.
  if (signals.envoy) {
    return det(null, "unknown", "shape");
  }
  // Full browser shape (Sec-Fetch present, hints lowercase). A real browser — a
  // HUMAN or an on-device browser agent. They are byte-for-byte indistinguishable
  // and we DO NOT pretend to separate them.
  if (signals.hasSecFetch) {
    return det(null, "human-or-browser", "shape");
  }
  // No `Sec-Fetch-*` at all → NOT a browser (high confidence, zero maintenance).
  // Catches Gemini/ChatGPT-User/Claude Code by shape even if the UA changed, plus
  // every unnamed curl/python scraper. Unnamed → surface it for the corpus.
  if (signals.headerCount > 0) {
    return det(null, "unknown", "shape");
  }
  // Nothing to go on (no headers).
  return det(null, "unknown", "none");
}

/** Read the (case-insensitive) `User-Agent` value from raw pairs, or "". */
function headerUa(pairs: readonly HeaderPair[]): string {
  for (const [k, v] of pairs) {
    if (lower(k) === "user-agent") {
      return v;
    }
  }
  return "";
}

/** A short, safe family name for a plain HTTP client (`curl`, `python-requests`). */
function httpClientName(ua: string): string {
  const token = ua.trim().split(/[\s/]/)[0] ?? "";
  const cleaned = token.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return cleaned === "" ? "http-client" : cleaned;
}
