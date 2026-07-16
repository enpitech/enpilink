import { describe, expect, it } from "vitest";
import {
  collectCidrs,
  IpRangeVerifier,
  ipv4ToInt,
  ipv6ToBigInt,
  type JsonFetcher,
  parseClientIp,
  type Vendor,
  vendorForFamily,
} from "./ip-ranges.js";

describe("vendorForFamily", () => {
  it("maps vendor crawlers/fetchers to their published-list vendor", () => {
    expect(vendorForFamily("gptbot")).toBe("openai");
    expect(vendorForFamily("chatgpt-user")).toBe("openai");
    expect(vendorForFamily("gemini")).toBe("google");
    expect(vendorForFamily("googlebot")).toBe("google");
    expect(vendorForFamily("claude-web")).toBe("anthropic");
    expect(vendorForFamily("perplexity-user")).toBe("perplexity");
  });

  it("returns null for families that legitimately run OFF the vendor network", () => {
    // A CLI runs on a DEVELOPER's IP — an IP miss must NEVER read as a spoof.
    expect(vendorForFamily("claude-code")).toBeNull();
    expect(vendorForFamily(null)).toBeNull();
    expect(vendorForFamily("curl")).toBeNull();
  });
});

describe("IP parsing", () => {
  it("parses IPv4 and rejects malformed input", () => {
    expect(ipv4ToInt("52.153.130.71")).toBe(
      52 * 2 ** 24 + 153 * 2 ** 16 + 130 * 2 ** 8 + 71,
    );
    expect(ipv4ToInt("256.0.0.1")).toBeNull();
    expect(ipv4ToInt("1.2.3")).toBeNull();
  });

  it("parses IPv6 with :: expansion", () => {
    expect(ipv6ToBigInt("::1")).toBe(1n);
    expect(ipv6ToBigInt("2001:db8::")).toBe(0x20010db8n << 96n);
    expect(ipv6ToBigInt("not-an-ip")).toBeNull();
  });

  it("normalises IPv4-mapped IPv6 and bracket/zone forms", () => {
    const mapped = parseClientIp("::ffff:52.153.130.71");
    expect(mapped).toEqual({ v4: ipv4ToInt("52.153.130.71") });
    expect(parseClientIp("[2001:db8::1]")).toEqual({
      v6: ipv6ToBigInt("2001:db8::1"),
    });
    expect(parseClientIp("fe80::1%en0")).toEqual({
      v6: ipv6ToBigInt("fe80::1"),
    });
  });
});

describe("collectCidrs — format-agnostic extraction", () => {
  it("pulls CIDRs out of the OpenAI/Google prefixes shape", () => {
    const json = {
      creationTime: "2026-07-11",
      prefixes: [
        { ipv4Prefix: "52.153.130.64/28" },
        { ipv6Prefix: "2600:1f18::/32" },
      ],
    };
    expect(collectCidrs(json).sort()).toEqual([
      "2600:1f18::/32",
      "52.153.130.64/28",
    ]);
  });

  it("pulls CIDRs out of a bare-array shape too", () => {
    expect(collectCidrs(["1.2.3.0/24", "nope", "4.5.6.0/24"]).sort()).toEqual([
      "1.2.3.0/24",
      "4.5.6.0/24",
    ]);
  });
});

/** A fetcher that serves canned JSON per URL — never hits the network. */
function stubFetcher(byUrl: Record<string, unknown>): JsonFetcher {
  return async (url) => {
    if (url in byUrl) {
      return byUrl[url];
    }
    throw new Error(`404 ${url}`);
  };
}

const OPENAI_URL = "https://openai.com/chatgpt-user.json";
const lists: Record<Vendor, readonly string[]> = {
  openai: [OPENAI_URL],
  google: [],
  anthropic: [],
  perplexity: [],
};

describe("IpRangeVerifier", () => {
  it("returns unknown until the list loads, then match/miss", async () => {
    const verifier = new IpRangeVerifier({
      vendorLists: lists,
      fetchJson: stubFetcher({
        [OPENAI_URL]: { prefixes: [{ ipv4Prefix: "52.153.130.64/28" }] },
      }),
    });

    // Nothing loaded yet.
    expect(verifier.verify("openai", "52.153.130.71")).toBe("unknown");

    await verifier.refresh("openai");

    // In range → match (this is the ChatGPT-User verification from the probe).
    expect(verifier.verify("openai", "52.153.130.71")).toBe("match");
    // Out of range → miss (the spoof case: right UA, wrong IP).
    expect(verifier.verify("openai", "8.8.8.8")).toBe("miss");
  });

  it("returns unknown for a vendor whose list is empty/absent (e.g. Meta)", async () => {
    const verifier = new IpRangeVerifier({
      vendorLists: lists,
      fetchJson: stubFetcher({}),
    });
    await verifier.refresh("google");
    expect(verifier.verify("google", "8.8.8.8")).toBe("unknown");
  });

  it("verifies an IPv6 client against an IPv6 prefix", async () => {
    const verifier = new IpRangeVerifier({
      vendorLists: { ...lists, openai: [OPENAI_URL] },
      fetchJson: stubFetcher({
        [OPENAI_URL]: { prefixes: [{ ipv6Prefix: "2600:1f18::/32" }] },
      }),
    });
    await verifier.refresh("openai");
    expect(verifier.verify("openai", "2600:1f18:0:1::5")).toBe("match");
    expect(verifier.verify("openai", "2001:db8::1")).toBe("miss");
  });

  it("caches per the TTL and does not re-fetch while fresh", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const verifier = new IpRangeVerifier({
      vendorLists: lists,
      now: () => clock,
      ttlMs: 1000,
      fetchJson: async (url) => {
        calls++;
        return url === OPENAI_URL
          ? { prefixes: [{ ipv4Prefix: "52.153.130.64/28" }] }
          : {};
      },
    });

    verifier.ensureFresh("openai");
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);

    // Still fresh → no new fetch.
    verifier.ensureFresh("openai");
    expect(calls).toBe(1);

    // Past the TTL → a background refresh fires.
    clock += 2000;
    verifier.ensureFresh("openai");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });

  it("swallows fetch errors and stays at unknown", async () => {
    const verifier = new IpRangeVerifier({
      vendorLists: lists,
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    await expect(verifier.refresh("openai")).resolves.toBeUndefined();
    expect(verifier.verify("openai", "52.153.130.71")).toBe("unknown");
  });
});
