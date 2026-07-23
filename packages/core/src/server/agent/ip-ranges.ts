/**
 * The OPTIONAL IP confidence tier (M2) — additive, feature-flagged, and fully
 * separable from the classifier. The detection engine (`detect.ts`) works
 * completely without it; this only ever UPGRADES confidence.
 *
 * Principle (settled, non-negotiable): fingerprint the shape FIRST, name with the
 * UA, and use IP only where a vendor publishes a list. IP lists are fragile and
 * incomplete — Meta publishes NONE yet is ~52% of AI crawler traffic; CLIs run on
 * developer IPs, browser agents on consumer IPs — so a missing list simply means
 * "no IP tier for this one", never a downgrade.
 *
 * What it does:
 * - Fetches the published JSON IP lists (OpenAI, Google, Anthropic, Perplexity)
 *   on a DAILY cache. Never vendored into the build; fetched at runtime only when
 *   the `agent.verifyIpRanges` flag is on.
 * - A synchronous, non-blocking {@link IpRangeVerifier.verify}: it matches the
 *   client IP against whatever is CURRENTLY loaded (a longest-prefix membership
 *   test over parsed CIDRs). {@link IpRangeVerifier.ensureFresh} kicks a
 *   background refresh if stale — the request path NEVER awaits a network fetch.
 *
 * How the caller uses the verdict (in `express-middleware.ts`, on the RAW IP,
 * before it is hashed and discarded):
 * - UA claims a vendor AND the IP matches its published range → upgrade to
 *   `ip-verified`.
 * - UA claims a vendor whose IP is expected to be a vendor range but the IP does
 *   NOT match → a `spoof` (kept at `ua-only`, flagged).
 * - No list / not yet loaded → `unknown`; fall back to shape. Never a spoof.
 *
 * Only the VERDICT is stored, never the raw IP.
 */

/**
 * The vendors that publish an IP-range list we can verify against. A single
 * source for both the {@link Vendor} type and the ruleset's zod enum
 * (`ruleset/schema.ts` imports this), so the two never drift.
 */
export const VENDORS = ["openai", "google", "anthropic", "perplexity"] as const;

/** A vendor that publishes an IP-range list we can verify against. */
export type Vendor = (typeof VENDORS)[number];

/** The result of an IP membership check for a vendor. */
export type IpVerdict = "match" | "miss" | "unknown";

/**
 * Map a detected family to the vendor whose published IP list can verify it —
 * and ONLY for families expected to originate from that vendor's ranges (bulk
 * crawlers + vendor-hosted fetchers). Families that legitimately run OFF the
 * vendor's network return null so an IP miss is never mistaken for a spoof:
 * `claude-code` (a CLI on a DEVELOPER's IP) and any on-device browser agent
 * (a CONSUMER IP) are intentionally absent.
 */
export function vendorForFamily(family: string | null): Vendor | null {
  switch (family) {
    case "gptbot":
    case "chatgpt-user":
    case "oai-searchbot":
      return "openai";
    case "googlebot":
    case "gemini":
      return "google";
    case "claudebot":
    case "claude-user":
    case "claude-web":
      return "anthropic";
    case "perplexitybot":
    case "perplexity-user":
      return "perplexity";
    default:
      return null;
  }
}

/** The published list URLs per vendor. Fetched at runtime, never vendored. */
export const DEFAULT_VENDOR_LISTS: Record<Vendor, readonly string[]> = {
  openai: [
    "https://openai.com/gptbot.json",
    "https://openai.com/chatgpt-user.json",
    "https://openai.com/searchbot.json",
  ],
  google: [
    "https://developers.google.com/static/crawling/ipranges/googlebot.json",
    "https://developers.google.com/static/crawling/ipranges/special-crawlers.json",
    "https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json",
  ],
  anthropic: ["https://claude.com/crawling/bots.json"],
  perplexity: [
    "https://www.perplexity.ai/perplexitybot.json",
    "https://www.perplexity.ai/perplexity-user.json",
  ],
};

const DAY_MS = 86_400_000;

interface Prefix4 {
  base: number;
  bits: number;
}
interface Prefix6 {
  base: bigint;
  bits: number;
}
interface VendorTable {
  v4: Prefix4[];
  v6: Prefix6[];
}

const V4_CIDR_RE = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const V6_CIDR_RE = /^[0-9a-fA-F:]+\/\d{1,3}$/;

/** Parse an IPv4 dotted quad to an unsigned 32-bit integer, or null. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) {
      return null;
    }
    const n = Number(p);
    if (n > 255) {
      return null;
    }
    out = (out * 256 + n) >>> 0;
  }
  return out >>> 0;
}

/** Parse an IPv6 address to a 128-bit BigInt, or null. Handles `::` expansion. */
export function ipv6ToBigInt(ip: string): bigint | null {
  const addr = ip.trim();
  if (addr === "" || !addr.includes(":")) {
    return null;
  }
  const halves = addr.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const tail =
    halves.length === 2
      ? halves[1] === ""
        ? []
        : (halves[1] as string).split(":")
      : [];
  const groups: string[] = [];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) {
      return null;
    }
    groups.push(...head, ...Array(fill).fill("0"), ...tail);
  } else {
    groups.push(...head);
  }
  if (groups.length !== 8) {
    return null;
  }
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
      return null;
    }
    out = (out << 16n) + BigInt(Number.parseInt(g, 16));
  }
  return out;
}

/**
 * Normalise a client IP. Strips a zone id and, for an IPv4-mapped IPv6 address
 * (`::ffff:1.2.3.4`), returns the embedded IPv4. Returns `{ v4 }` or `{ v6 }`.
 */
export function parseClientIp(
  raw: string,
): { v4: number } | { v6: bigint } | null {
  let ip = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const zone = ip.indexOf("%");
  if (zone !== -1) {
    ip = ip.slice(0, zone);
  }
  const mapped = ip.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i);
  if (mapped) {
    const v4 = ipv4ToInt(mapped[1] as string);
    return v4 === null ? null : { v4 };
  }
  if (ip.includes(":")) {
    const v6 = ipv6ToBigInt(ip);
    return v6 === null ? null : { v6 };
  }
  const v4 = ipv4ToInt(ip);
  return v4 === null ? null : { v4 };
}

function parseCidr4(cidr: string): Prefix4 | null {
  const slash = cidr.indexOf("/");
  const base = ipv4ToInt(cidr.slice(0, slash));
  const bits = Number(cidr.slice(slash + 1));
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return null;
  }
  return { base, bits };
}

function parseCidr6(cidr: string): Prefix6 | null {
  const slash = cidr.indexOf("/");
  const base = ipv6ToBigInt(cidr.slice(0, slash));
  const bits = Number(cidr.slice(slash + 1));
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 128) {
    return null;
  }
  return { base, bits };
}

function inPrefix4(ip: number, p: Prefix4): boolean {
  if (p.bits === 0) {
    return true;
  }
  const mask = p.bits === 32 ? 0xffffffff : (0xffffffff << (32 - p.bits)) >>> 0;
  return (ip & mask) >>> 0 === (p.base & mask) >>> 0;
}

function inPrefix6(ip: bigint, p: Prefix6): boolean {
  if (p.bits === 0) {
    return true;
  }
  const mask = ((1n << BigInt(p.bits)) - 1n) << BigInt(128 - p.bits);
  return (ip & mask) === (p.base & mask);
}

/**
 * Recursively collect every CIDR string in an arbitrary parsed JSON value. This
 * is deliberately format-agnostic: OpenAI/Google publish
 * `{ prefixes: [{ ipv4Prefix }, { ipv6Prefix }] }`, while Anthropic's list shape
 * is undocumented — walking for CIDR-shaped strings handles all of them.
 */
export function collectCidrs(json: unknown, out: string[] = []): string[] {
  if (typeof json === "string") {
    const s = json.trim();
    if (V4_CIDR_RE.test(s) || (s.includes(":") && V6_CIDR_RE.test(s))) {
      out.push(s);
    }
  } else if (Array.isArray(json)) {
    for (const v of json) {
      collectCidrs(v, out);
    }
  } else if (json && typeof json === "object") {
    for (const v of Object.values(json)) {
      collectCidrs(v, out);
    }
  }
  return out;
}

function buildTable(cidrs: readonly string[]): VendorTable {
  const v4: Prefix4[] = [];
  const v6: Prefix6[] = [];
  for (const c of cidrs) {
    if (c.includes(":")) {
      const p = parseCidr6(c);
      if (p) {
        v6.push(p);
      }
    } else {
      const p = parseCidr4(c);
      if (p) {
        v4.push(p);
      }
    }
  }
  return { v4, v6 };
}

/** Fetch + parse JSON from a URL. Injectable so tests never hit the network. */
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetchJson: JsonFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} → ${res.status}`);
  }
  return res.json();
};

/** Options for {@link IpRangeVerifier}. */
export interface IpRangeVerifierOptions {
  /** How JSON lists are fetched. Defaults to global `fetch`. */
  fetchJson?: JsonFetcher;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Cache TTL in ms before a background refresh. Defaults to 24h. */
  ttlMs?: number;
  /** Per-vendor list URLs. Defaults to {@link DEFAULT_VENDOR_LISTS}. */
  vendorLists?: Record<Vendor, readonly string[]>;
}

/**
 * Verifies a client IP against vendors' published IP ranges, with a daily cache.
 *
 * `verify()` is synchronous and reads only what is currently loaded (so it never
 * blocks a request). `ensureFresh()` triggers a fire-and-forget refresh when a
 * vendor's table is stale; the first few requests for a vendor see `unknown`
 * until its list lands, then get real verdicts. All fetch/parse errors are
 * swallowed — the IP tier degrades to `unknown`, never to an exception.
 */
export class IpRangeVerifier {
  private readonly fetchJson: JsonFetcher;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly vendorLists: Record<Vendor, readonly string[]>;

  private readonly tables = new Map<Vendor, VendorTable>();
  private readonly loadedAt = new Map<Vendor, number>();
  private readonly inflight = new Map<Vendor, Promise<void>>();

  constructor(opts: IpRangeVerifierOptions = {}) {
    this.fetchJson = opts.fetchJson ?? defaultFetchJson;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DAY_MS;
    this.vendorLists = opts.vendorLists ?? DEFAULT_VENDOR_LISTS;
  }

  /**
   * Kick a background refresh of a vendor's table if it is missing or stale.
   * Non-blocking: returns immediately; the refresh resolves later. Idempotent
   * while a refresh is in flight.
   */
  ensureFresh(vendor: Vendor): void {
    const at = this.loadedAt.get(vendor);
    const fresh = at !== undefined && this.now() - at < this.ttlMs;
    if (fresh || this.inflight.has(vendor)) {
      return;
    }
    const p = this.refresh(vendor).finally(() => {
      this.inflight.delete(vendor);
    });
    // Never let a rejection surface as an unhandled rejection.
    p.catch(() => {});
    this.inflight.set(vendor, p);
  }

  /** Await a vendor refresh (used by tests). Errors are swallowed. */
  async refresh(vendor: Vendor): Promise<void> {
    const urls = this.vendorLists[vendor] ?? [];
    const cidrs: string[] = [];
    for (const url of urls) {
      try {
        const json = await this.fetchJson(url);
        collectCidrs(json, cidrs);
      } catch {
        // A failed/absent list contributes nothing; other URLs still count.
      }
    }
    // Only publish a table when we actually parsed at least one prefix, so a
    // total failure leaves the vendor at `unknown` rather than a false `miss`.
    if (cidrs.length > 0) {
      this.tables.set(vendor, buildTable(cidrs));
      this.loadedAt.set(vendor, this.now());
    } else if (!this.tables.has(vendor)) {
      // Mark the attempt so we don't hammer a dead URL every request; the table
      // stays absent (→ unknown) until the TTL elapses and we retry.
      this.loadedAt.set(vendor, this.now());
    }
  }

  /**
   * Check `ip` against `vendor`'s currently-loaded ranges. Synchronous, never
   * throws. `unknown` when the list isn't loaded (or has no prefixes of the
   * request's IP version); `match`/`miss` otherwise.
   */
  verify(vendor: Vendor, ip: string): IpVerdict {
    const table = this.tables.get(vendor);
    if (!table) {
      return "unknown";
    }
    const parsed = parseClientIp(ip);
    if (!parsed) {
      return "unknown";
    }
    if ("v4" in parsed) {
      if (table.v4.length === 0) {
        return "unknown";
      }
      return table.v4.some((p) => inPrefix4(parsed.v4, p)) ? "match" : "miss";
    }
    if (table.v6.length === 0) {
      return "unknown";
    }
    return table.v6.some((p) => inPrefix6(parsed.v6, p)) ? "match" : "miss";
  }
}
