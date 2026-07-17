// @vitest-environment node
import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setAgentCaptureGate } from "../capture-gate.js";
import { extractToolParams } from "../represent.js";
import { installAgentGetTransport } from "./get-router.js";
import type { GetExposedTool } from "./types.js";

function makeSearchTool(): GetExposedTool {
  const shape = { q: z.string(), limit: z.number().max(50).optional() };
  return {
    name: "search",
    path: "search",
    description: "Search the catalog.",
    inputSchema: shape,
    params: extractToolParams(shape),
    queryParam: "q",
    execute: async (args) => {
      const q = String(args.q ?? "");
      return {
        content: [
          { type: "text", text: `# Results for ${q}\n\n- Cobalt Blue Mug` },
        ],
        structuredContent: { query: q, results: ["Cobalt Blue Mug"] },
      };
    },
  };
}

interface RawResponse {
  status: number;
  body: string;
  contentType: string;
  headers: http.IncomingHttpHeaders;
}

function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            contentType: String(res.headers["content-type"] ?? ""),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("installAgentGetTransport (end-to-end)", () => {
  let server: http.Server;
  let port: number;
  let tool: GetExposedTool;

  beforeEach(async () => {
    tool = makeSearchTool();
    const app = express();
    installAgentGetTransport(app, { getExposedTools: () => [tool] });
    // A non-agent route to prove non-matching paths fall through untouched.
    app.get("/other", (_req, res) => res.status(200).send("OTHER"));

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;

    setAgentCaptureGate({
      enabled: false,
      sampleRate: 1,
      getTransport: true,
      getRateLimit: 60,
      getRateBurst: 10,
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
  });

  it("runs a read-only tool from a query string and returns markdown — no handshake", async () => {
    const res = await rawGet(port, "/agent/search?q=blue");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/markdown");
    expect(res.body).toContain("Results for blue");
    expect(res.body).toContain("Cobalt Blue Mug");
  });

  it("returns JSON on `Accept: application/json`", async () => {
    const res = await rawGet(port, "/agent/search?q=blue", {
      Accept: "application/json",
    });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({
      query: "blue",
      results: ["Cobalt Blue Mug"],
    });
  });

  it("returns a 400 with a descriptive body for a bad/missing arg", async () => {
    const res = await rawGet(port, "/agent/search"); // missing required q
    expect(res.status).toBe(400);
    expect(res.contentType).toContain("text/markdown");
    expect(res.body).toContain("# Bad request");
    expect(res.body).toContain("GET /agent/search?q={string}");
    expect(res.body.toLowerCase()).not.toContain("you must");
  });

  it("rate-limits and returns 429 with Retry-After when hammered", async () => {
    setAgentCaptureGate({
      enabled: false,
      sampleRate: 1,
      getTransport: true,
      getRateLimit: 60,
      getRateBurst: 1,
    });
    const first = await rawGet(port, "/agent/search?q=x");
    expect(first.status).toBe(200);
    const second = await rawGet(port, "/agent/search?q=x");
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect(second.body).toContain("Too many requests");
  });

  it("serves the OpenSearch description document", async () => {
    const res = await rawGet(port, "/agent/opensearch.xml");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("opensearchdescription");
    expect(res.body).toContain("q={searchTerms}");
  });

  it("falls through (no interception) when the transport is off", async () => {
    setAgentCaptureGate({ enabled: false, sampleRate: 1, getTransport: false });
    const res = await rawGet(port, "/agent/search?q=blue");
    expect(res.status).toBe(404);
  });

  it("falls through for an unknown /agent path and a non-agent route", async () => {
    const unknown = await rawGet(port, "/agent/nope");
    expect(unknown.status).toBe(404);
    const other = await rawGet(port, "/other");
    expect(other.status).toBe(200);
    expect(other.body).toBe("OTHER");
  });
});
