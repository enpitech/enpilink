// @vitest-environment node
import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { setAgentCaptureGate } from "../capture-gate.js";
import type { AgentGetAffordance } from "../represent.js";
import { installAgentResponseTransform } from "../response-transform.js";
import { installAgentRouting } from "../route.js";

/**
 * The M7 standard-signal declaration must ship through BOTH represent() callers —
 * the M3.5 trailing 404-rescue AND the M6 SPA-replace — because both build the
 * representation from the same generator. It appears ONLY when the GET transport
 * is on (never advertise an endpoint that would 404).
 */

const searchAff: AgentGetAffordance = {
  urlPath: "/agent/search",
  name: "search_catalog",
  description: "Search the catalog.",
  queryParam: "q",
  params: [{ name: "q", required: true, type: "string" }],
};

const CHATGPT_HTML = {
  "User-Agent": "Mozilla/5.0; compatible; ChatGPT-User/1.0",
  Accept: "text/html",
};

function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; contentType: string }> {
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
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function assertStandardSignals(html: string): void {
  expect(html).toContain('"@type": "SearchAction"');
  expect(html).toContain('rel="search"');
  expect(html).toContain("/agent/opensearch.xml");
}

async function listen(app: express.Express): Promise<{
  server: http.Server;
  port: number;
}> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  return { server, port: (server.address() as { port: number }).port };
}

describe("GET affordance declaration threads through both serve paths", () => {
  let server: http.Server;

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setAgentCaptureGate({ enabled: false, sampleRate: 1 });
  });

  it("appears in the 404-RESCUE representation", async () => {
    const app = express();
    installAgentRouting(app, {
      getTools: () => [],
      getSiteInfo: () => ({ title: "Acme" }),
      getServerName: () => "srv",
      getGetAffordances: () => [searchAff],
    });
    const listening = await listen(app);
    server = listening.server;
    setAgentCaptureGate({
      enabled: false,
      sampleRate: 1,
      serve: true,
      getTransport: true,
    });

    const res = await rawGet(listening.port, "/nope", CHATGPT_HTML);
    expect(res.status).toBe(200);
    assertStandardSignals(res.body);
  });

  it("appears in the SPA-REPLACE representation", async () => {
    const app = express();
    installAgentResponseTransform(app, {
      getTools: () => [],
      getSiteInfo: () => ({ title: "Acme" }),
      getServerName: () => "srv",
      getGetAffordances: () => [searchAff],
    });
    app.get("/", (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send('<!doctype html><div id="app"></div>');
    });
    const listening = await listen(app);
    server = listening.server;
    setAgentCaptureGate({
      enabled: false,
      sampleRate: 1,
      spa: true,
      getTransport: true,
    });

    const res = await rawGet(listening.port, "/", CHATGPT_HTML);
    expect(res.status).toBe(200);
    assertStandardSignals(res.body);
  });

  it("does NOT advertise the affordance when the GET transport is OFF", async () => {
    const app = express();
    installAgentRouting(app, {
      getTools: () => [],
      getSiteInfo: () => ({ title: "Acme" }),
      getServerName: () => "srv",
      getGetAffordances: () => [searchAff],
    });
    const listening = await listen(app);
    server = listening.server;
    // serve on, but getTransport OFF → no affordance signals.
    setAgentCaptureGate({
      enabled: false,
      sampleRate: 1,
      serve: true,
      getTransport: false,
    });

    const res = await rawGet(listening.port, "/nope", CHATGPT_HTML);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("SearchAction");
    expect(res.body).not.toContain("/agent/opensearch.xml");
  });
});
