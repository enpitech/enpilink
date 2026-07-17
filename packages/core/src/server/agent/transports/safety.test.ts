// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "../../server.js";
import type { AgentToolParam } from "../represent.js";
import { assertGetExposable, evaluateGetSafety } from "./safety.js";
import type { GetTransport } from "./types.js";

const flatStringParam: AgentToolParam[] = [
  { name: "q", required: true, type: "string" },
];
const validInput = {
  safe: true as const,
  readOnlyHint: true,
  params: flatStringParam,
};

describe("evaluateGetSafety (pure verdict)", () => {
  it("passes a read-only, public, flat, safe tool", () => {
    expect(evaluateGetSafety(validInput)).toEqual({ ok: true });
    expect(
      evaluateGetSafety({
        ...validInput,
        securitySchemes: [{ type: "noauth" }],
      }),
    ).toEqual({ ok: true });
  });

  it("rejects when `safe` is not the literal true", () => {
    const v = evaluateGetSafety({ ...validInput, safe: false });
    expect(v).toMatchObject({ ok: false });
    expect(v.ok ? "" : v.reason).toMatch(/safe/);
  });

  it("rejects a tool that is not read-only", () => {
    const v = evaluateGetSafety({ ...validInput, readOnlyHint: false });
    expect(v).toMatchObject({ ok: false });
    expect(v.ok ? "" : v.reason).toMatch(/read-only/i);
  });

  it("rejects a destructive tool", () => {
    const v = evaluateGetSafety({ ...validInput, destructiveHint: true });
    expect(v).toMatchObject({ ok: false });
    expect(v.ok ? "" : v.reason).toMatch(/destructive/i);
  });

  it("rejects a tool behind a non-public security scheme", () => {
    const v = evaluateGetSafety({
      ...validInput,
      securitySchemes: [{ type: "oauth2" }],
    });
    expect(v).toMatchObject({ ok: false });
    expect(v.ok ? "" : v.reason).toMatch(/oauth2|auth/i);
  });

  it("rejects a nested-object parameter and names it", () => {
    const v = evaluateGetSafety({
      ...validInput,
      params: [{ name: "filter", required: true, type: "object" }],
    });
    expect(v).toMatchObject({ ok: false });
    expect(v.ok ? "" : v.reason).toMatch(/filter/);
  });
});

describe("assertGetExposable (throws, names the tool)", () => {
  it("throws with the tool name and the reason", () => {
    expect(() =>
      assertGetExposable("delete_thing", {
        safe: true,
        readOnlyHint: false,
        params: [],
      }),
    ).toThrow(/delete_thing/);
  });
});

/**
 * THE HEADLINE: exposing a mutating/authed/destructive tool on an unauthenticated
 * GET must be IMPOSSIBLE — `registerTool` THROWS and the server does not start.
 * Each failure mode is its own case.
 */
describe("registerTool GET safety gate (real McpServer — refuses to start)", () => {
  const handler = async () => ({
    content: "ok",
    structuredContent: { ok: true },
  });
  const srv = () => new McpServer({ name: "t", version: "0.0.0" });
  const get: GetTransport = { path: "x", safe: true };

  it("THROWS for a GET-exposed tool that is not read-only", () => {
    expect(() =>
      srv().registerTool(
        { name: "mutate", inputSchema: { q: z.string() }, transports: { get } },
        handler,
      ),
    ).toThrow(/mutate/);
  });

  it("THROWS for a GET-exposed tool behind a non-public security scheme", () => {
    expect(() =>
      srv().registerTool(
        {
          name: "authed_read",
          inputSchema: { q: z.string() },
          annotations: { readOnlyHint: true },
          securitySchemes: [{ type: "oauth2" }],
          transports: { get },
        },
        handler,
      ),
    ).toThrow(/authed_read/);
  });

  it("THROWS for a destructive GET-exposed tool", () => {
    expect(() =>
      srv().registerTool(
        {
          name: "wipe",
          inputSchema: { q: z.string() },
          annotations: { readOnlyHint: true, destructiveHint: true },
          transports: { get },
        },
        handler,
      ),
    ).toThrow(/wipe/);
  });

  it("THROWS when `safe` is not literally true", () => {
    expect(() =>
      srv().registerTool(
        {
          name: "unasserted",
          inputSchema: { q: z.string() },
          annotations: { readOnlyHint: true },
          // The author did not physically assert safety.
          transports: {
            get: { path: "x", safe: false } as unknown as GetTransport,
          },
        },
        handler,
      ),
    ).toThrow(/unasserted/);
  });

  it("THROWS for a nested-object input parameter", () => {
    expect(() =>
      srv().registerTool(
        {
          name: "nested",
          inputSchema: { filter: z.object({ min: z.number() }) },
          annotations: { readOnlyHint: true },
          transports: { get },
        },
        handler,
      ),
    ).toThrow(/nested/);
  });

  it("does NOT throw for a read-only, public, flat tool", () => {
    expect(() =>
      srv().registerTool(
        {
          name: "search",
          inputSchema: { q: z.string() },
          annotations: { readOnlyHint: true },
          securitySchemes: [{ type: "noauth" }],
          transports: { get: { path: "search", safe: true } },
        },
        handler,
      ),
    ).not.toThrow();
  });

  it("THROWS on a duplicate GET path", () => {
    const server = srv().registerTool(
      {
        name: "a",
        inputSchema: { q: z.string() },
        annotations: { readOnlyHint: true },
        transports: { get: { path: "same", safe: true } },
      },
      handler,
    );
    expect(() =>
      server.registerTool(
        {
          name: "b",
          inputSchema: { q: z.string() },
          annotations: { readOnlyHint: true },
          transports: { get: { path: "same", safe: true } },
        },
        handler,
      ),
    ).toThrow(/same/);
  });
});
