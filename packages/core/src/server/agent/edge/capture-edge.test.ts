import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INITIAL_RULESET } from "../ruleset/initial.js";
import {
  buildEdgeRecord,
  edgeHeaderPairs,
  hashIpEdge,
  resolveEdgeClientIp,
} from "./capture-edge.js";

/**
 * Edge capture core (M8). These exercise the SAME pure detection/record core the
 * Node path uses, but driven from a Web `Request` — and they pin the documented
 * fidelity differences (lowercased headers, no HTTP version, unknown status).
 */

function req(
  url: string,
  method: string,
  headers: Record<string, string>,
): Request {
  return new Request(url, { method, headers });
}

describe("resolveEdgeClientIp", () => {
  it("prefers CF-Connecting-IP", () => {
    const h = new Headers({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "10.0.0.1, 10.0.0.2",
    });
    expect(resolveEdgeClientIp(h)).toBe("203.0.113.7");
  });

  it("takes the FIRST hop of X-Forwarded-For (the client, not the proxies)", () => {
    const h = new Headers({ "x-forwarded-for": "198.51.100.5, 10.0.0.1" });
    expect(resolveEdgeClientIp(h)).toBe("198.51.100.5");
  });

  it("returns null when no IP header is present", () => {
    expect(resolveEdgeClientIp(new Headers({ accept: "*/*" }))).toBeNull();
  });
});

describe("hashIpEdge", () => {
  it("is byte-compatible with the Node createHash(salt:ip) discipline", async () => {
    const ip = "203.0.113.7";
    const salt = "per-site-salt-abc";
    const edge = await hashIpEdge(ip, salt);
    const node = createHash("sha256")
      .update(salt)
      .update(":")
      .update(ip)
      .digest("hex");
    // Same salt ⇒ same hash across runtimes, so edge + Node rows are joinable.
    expect(edge).toBe(node);
    // Never the raw IP.
    expect(edge).not.toContain(ip);
    expect(edge).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("edgeHeaderPairs", () => {
  it("lowercases header names (the documented casing loss vs req.rawHeaders)", () => {
    const h = new Headers({ "Sec-CH-UA": '"Chromium"', Accept: "*/*" });
    const pairs = edgeHeaderPairs(h);
    const names = pairs.map(([n]) => n);
    // Web Headers lowercases — the title-cased disguise tell is gone here.
    expect(names).toContain("sec-ch-ua");
    expect(names).not.toContain("Sec-CH-UA");
  });
});

describe("buildEdgeRecord", () => {
  it("classifies a named UA agent identically to the Node path", async () => {
    const request = req("https://acme.com/pricing", "GET", {
      "user-agent":
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0",
      accept: "text/html",
      "x-forwarded-for": "198.51.100.5",
    });
    const rec = await buildEdgeRecord(
      request,
      { status: 200, ts: 1000, ms: 3 },
      { siteId: "default", ipSalt: "salt", ruleset: INITIAL_RULESET },
    );
    expect(rec.method).toBe("GET");
    expect(rec.path).toBe("/pricing");
    expect(rec.agentFamily).toBe("chatgpt-user");
    expect(rec.agentClass).toBe("chat-fetcher");
    expect(rec.status).toBe(200);
    expect(rec.outcome).toBe("resolved");
    expect(rec.ua).toContain("ChatGPT-User");
    // Marks the capture point so a consumer can tell edge rows apart.
    expect(rec.meta?.edge).toBe(true);
    // No HTTP version at the edge.
    expect(rec.httpVersion).toBe("");
  });

  it("hashes the IP and NEVER stores it raw", async () => {
    const ip = "198.51.100.5";
    const request = req("https://acme.com/", "GET", {
      "user-agent": "GPTBot/1.0",
      "cf-connecting-ip": ip,
    });
    const rec = await buildEdgeRecord(
      request,
      { status: 200, ts: 1, ms: 0 },
      { siteId: "s1", ipSalt: "salty" },
    );
    expect(rec.ipHash).toBe(await hashIpEdge(ip, "salty"));
    expect(JSON.stringify(rec)).not.toContain(ip);
    // The IP-bearing header NAME is kept (presence is a fingerprint signal) but
    // its VALUE is redacted — no raw IP ever lands in the stored fingerprint.
    const cf = rec.headers.find(([n]) => n === "cf-connecting-ip");
    expect(cf).toEqual(["cf-connecting-ip", "[redacted]"]);
  });

  it("omits the IP hash entirely when no salt is provided (never raw)", async () => {
    const request = req("https://acme.com/", "GET", {
      "user-agent": "GPTBot/1.0",
      "cf-connecting-ip": "198.51.100.5",
    });
    const rec = await buildEdgeRecord(
      request,
      { status: 200, ts: 1, ms: 0 },
      { siteId: "s1" },
    );
    expect(rec.ipHash).toBeUndefined();
  });

  it("records a 404 as a dead_end", async () => {
    const request = req("https://acme.com/missing", "GET", {
      "user-agent": "Claude-User/1.0",
    });
    const rec = await buildEdgeRecord(
      request,
      { status: 404, ts: 1, ms: 0 },
      { siteId: "default", ruleset: INITIAL_RULESET },
    );
    expect(rec.outcome).toBe("dead_end");
    expect(rec.agentClass).toBe("chat-fetcher");
  });

  it("marks an unknown (pass-through) status honestly — resolved placeholder + statusUnknown", async () => {
    const request = req("https://acme.com/x", "GET", {
      "user-agent": "GPTBot/1.0",
    });
    const rec = await buildEdgeRecord(
      request,
      { status: 0, ts: 1, ms: 0 },
      { siteId: "default" },
    );
    // status 0 is not a real HTTP status; we flag it so the dashboard never
    // reads it as a genuine resolve.
    expect(rec.meta?.statusUnknown).toBe(true);
    expect(rec.status).toBe(0);
  });

  it("does NOT catch Claude's title-cased disguise at the edge (documented fidelity loss)", async () => {
    // A real title-cased `Sec-Ch-Ua` would name claude-web on the Node path; via
    // a Web Headers object it is lowercased, so the disguise tell is lost and the
    // request falls through to human-or-browser by shape.
    const request = req("https://acme.com/", "GET", {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "sec-ch-ua": '"Chromium";v="141"',
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    });
    const rec = await buildEdgeRecord(
      request,
      { status: 200, ts: 1, ms: 0 },
      { siteId: "default", ruleset: INITIAL_RULESET },
    );
    expect(rec.agentClass).toBe("human-or-browser");
    expect(rec.agentFamily).toBeUndefined();
  });
});
