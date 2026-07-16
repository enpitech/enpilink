import { describe, expect, it } from "vitest";
import type { HeaderPair } from "../storage/types.js";
import { classify, deriveSignals } from "./detect.js";

/**
 * The REAL captured header sets from HOW-AGENTS-READ-PAGES §2 (probe.parklug.de).
 * Order + casing are load-bearing — a title-cased `Sec-Ch-Ua` is Claude's
 * disguise tell, so these fixtures preserve the wire casing verbatim.
 */

// Gemini web — 5 headers, UA is the bare word "Google", no Sec-Fetch/hints.
const GEMINI: HeaderPair[] = [
  ["Accept", "*/*"],
  ["User-Agent", "Google"],
  ["Accept-Encoding", "gzip, deflate, br"],
  ["Host", "probe.parklug.de"],
  ["Connection", "keep-alive"],
];

// ChatGPT-User — declares itself, no Sec-Fetch, leaks X-Envoy-*.
const CHATGPT_USER: HeaderPair[] = [
  [
    "User-Agent",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0",
  ],
  [
    "Accept",
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif",
  ],
  ["Accept-Language", "en-US,en;q=0.9"],
  ["Accept-Encoding", "gzip, br"],
  ["X-Envoy-Expected-Rq-Timeout-Ms", "15000"],
  ["X-Request-Id", "cd54a3fc-4a8b-40f9-bfde-8c59925202ec"],
  ["Host", "probe.parklug.de"],
  ["Connection", "keep-alive"],
];

// Claude Code (CLI) — 5 headers, asks for MARKDOWN FIRST, declares claude-code.
const CLAUDE_CODE: HeaderPair[] = [
  ["Accept", "text/markdown, text/html, */*"],
  [
    "User-Agent",
    "Claude-User (claude-code/2.1.207; +https://support.anthropic.com/)",
  ],
  ["Accept-Encoding", "gzip, compress, deflate, br"],
  ["Host", "probe.parklug.de"],
  ["Connection", "keep-alive"],
];

// Claude web/desktop chat — disguised as Chrome-on-Linux, TITLE-CASED hints.
const CLAUDE_WEB: HeaderPair[] = [
  [
    "Accept",
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif",
  ],
  [
    "User-Agent",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  ],
  ["Cache-Control", "no-cache"],
  ["Pragma", "no-cache"],
  ["Sec-Ch-Ua-Mobile", "?0"],
  ["Sec-Ch-Ua-Platform", "Linux"],
  [
    "Sec-Ch-Ua",
    '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
  ],
  ["Sec-Fetch-Site", "none"],
  ["Sec-Fetch-Mode", "navigate"],
  ["Sec-Fetch-User", "?1"],
  ["Sec-Fetch-Dest", "document"],
  ["Accept-Encoding", "zstd,gzip,deflate,br"],
  ["Accept-Language", "en-US,en;q=0.9"],
  ["Host", "probe.parklug.de"],
  ["Connection", "keep-alive"],
];

// GPTBot — a bulk crawler.
const GPTBOT: HeaderPair[] = [
  [
    "User-Agent",
    "Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  ],
  ["Accept", "*/*"],
  ["Accept-Encoding", "gzip, deflate, br"],
  ["Host", "probe.parklug.de"],
  ["Connection", "keep-alive"],
];

// A real human Chrome on macOS — LOWERCASE client hints, full Sec-Fetch.
const REAL_CHROME: HeaderPair[] = [
  ["Host", "probe.parklug.de"],
  ["Connection", "keep-alive"],
  [
    "sec-ch-ua",
    '"Google Chrome";v="149", "Not;A=Brand";v="24", "Chromium";v="149"',
  ],
  ["sec-ch-ua-mobile", "?0"],
  ["sec-ch-ua-platform", '"macOS"'],
  ["Upgrade-Insecure-Requests", "1"],
  [
    "User-Agent",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  ],
  [
    "Accept",
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  ],
  ["Sec-Fetch-Site", "none"],
  ["Sec-Fetch-Mode", "navigate"],
  ["Sec-Fetch-User", "?1"],
  ["Sec-Fetch-Dest", "document"],
  ["Accept-Encoding", "gzip, deflate, br, zstd"],
  ["Accept-Language", "en-US,en;q=0.9,de;q=0.8"],
];

describe("classify — the real captured agents (HOW-AGENTS-READ-PAGES §2)", () => {
  const cases: Array<{
    name: string;
    headers: HeaderPair[];
    family: string | null;
    class: string;
    confidence: string;
  }> = [
    {
      name: "ChatGPT-User",
      headers: CHATGPT_USER,
      family: "chatgpt-user",
      class: "chat-fetcher",
      confidence: "ua+shape",
    },
    {
      name: "Gemini web",
      headers: GEMINI,
      family: "gemini",
      class: "chat-fetcher",
      confidence: "ua+shape",
    },
    {
      name: "Claude web (disguised as Chrome)",
      headers: CLAUDE_WEB,
      family: "claude-web",
      class: "chat-fetcher",
      confidence: "shape",
    },
    {
      name: "Claude Code (CLI)",
      headers: CLAUDE_CODE,
      family: "claude-code",
      class: "cli",
      confidence: "ua-only",
    },
    {
      name: "GPTBot",
      headers: GPTBOT,
      family: "gptbot",
      class: "crawler",
      confidence: "ua-only",
    },
    {
      name: "real human Chrome",
      headers: REAL_CHROME,
      family: null,
      class: "human-or-browser",
      confidence: "shape",
    },
  ];

  for (const c of cases) {
    it(`classifies ${c.name} → ${c.family}/${c.class}/${c.confidence}`, () => {
      const d = classify(c.headers);
      expect(d.family).toBe(c.family);
      expect(d.class).toBe(c.class);
      expect(d.confidence).toBe(c.confidence);
    });
  }
});

describe("classify — the title-cased client-hints tell (the marquee signal)", () => {
  it("catches Claude's Chrome disguise by title-cased Sec-Ch-Ua*, not the UA", () => {
    const d = classify(CLAUDE_WEB);
    expect(d.family).toBe("claude-web");
    expect(d.confidence).toBe("shape");
    expect(d.signals.titleCasedClientHints).toBe(true);
    // Corroborating tells are all recorded on the fingerprint.
    expect(d.signals.noCacheOnNav).toBe(true);
    expect(d.signals.zstdFirst).toBe(true);
    expect(d.signals.platformClaim).toBe("Linux");
  });

  it("the SAME shape with LOWERCASE hints is a real browser (human-or-browser)", () => {
    // Identical to Claude's disguise but for the client-hint CASING → the
    // classification flips. This is the whole point of reading req.rawHeaders.
    const lowercased: HeaderPair[] = CLAUDE_WEB.map(([k, v]) =>
      k.startsWith("Sec-Ch-Ua") ? [k.toLowerCase(), v] : [k, v],
    );
    const d = classify(lowercased);
    expect(d.signals.titleCasedClientHints).toBe(false);
    expect(d.class).toBe("human-or-browser");
    expect(d.family).toBeNull();
  });
});

describe("classify — plain HTTP clients + edge cases", () => {
  it("names a curl client as a tool", () => {
    const d = classify([
      ["User-Agent", "curl/8.7.1"],
      ["Accept", "*/*"],
      ["Host", "x"],
    ]);
    expect(d.family).toBe("curl");
    expect(d.class).toBe("tool");
    expect(d.confidence).toBe("ua-only");
  });

  it("names python-requests as a tool", () => {
    const d = classify([
      ["User-Agent", "python-requests/2.32.3"],
      ["Host", "x"],
    ]);
    expect(d.family).toBe("python-requests");
    expect(d.class).toBe("tool");
  });

  it("a real Firefox (Sec-Fetch, no client hints) is human-or-browser", () => {
    const d = classify([
      [
        "User-Agent",
        "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
      ],
      [
        "Accept",
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ],
      ["Accept-Language", "en-US,en;q=0.5"],
      ["Accept-Encoding", "gzip, deflate, br"],
      ["Sec-Fetch-Dest", "document"],
      ["Sec-Fetch-Mode", "navigate"],
      ["Sec-Fetch-Site", "none"],
      ["Sec-Fetch-User", "?1"],
      ["Host", "x"],
      ["Connection", "keep-alive"],
    ]);
    expect(d.class).toBe("human-or-browser");
    expect(d.signals.hasSecFetch).toBe(true);
    expect(d.signals.hasClientHints).toBe(false);
  });

  it("an unnamed non-browser (no Sec-Fetch) is unknown/shape — surfaced for the corpus", () => {
    const d = classify([
      ["Accept", "*/*"],
      ["Host", "x"],
    ]);
    expect(d.family).toBeNull();
    expect(d.class).toBe("unknown");
    expect(d.confidence).toBe("shape");
    expect(d.signals.hasSecFetch).toBe(false);
  });

  it("no headers at all → unknown/none", () => {
    const d = classify([]);
    expect(d.class).toBe("unknown");
    expect(d.confidence).toBe("none");
  });

  it("distinguishes Googlebot (crawler) from Gemini (chat-fetcher)", () => {
    const googlebot = classify([
      [
        "User-Agent",
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      ],
      ["Accept", "*/*"],
      ["Host", "x"],
    ]);
    expect(googlebot.family).toBe("googlebot");
    expect(googlebot.class).toBe("crawler");
    expect(classify(GEMINI).class).toBe("chat-fetcher");
  });

  it("Claude Code's UA carries claude-code AND Claude-User → names the CLI", () => {
    const d = classify(CLAUDE_CODE);
    expect(d.family).toBe("claude-code");
    expect(d.class).toBe("cli");
    expect(d.signals.wantsMarkdown).toBe(true);
  });
});

describe("deriveSignals — the reusable fingerprint primitives", () => {
  it("flags an envoy header and a platform/UA contradiction", () => {
    const s = deriveSignals(
      [
        ["User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
        ["Sec-Ch-Ua-Platform", "Windows"],
        ["X-Envoy-Expected-Rq-Timeout-Ms", "15000"],
      ],
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    expect(s.envoy).toBe(true);
    expect(s.platformContradictsUa).toBe(true);
  });

  it("does not flag a contradiction when platform matches the UA", () => {
    const s = deriveSignals(
      CLAUDE_WEB,
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    );
    // Claude claims Linux with an X11; Linux UA — consistent (the tell is the
    // casing, not the platform).
    expect(s.platformContradictsUa).toBe(false);
  });
});
