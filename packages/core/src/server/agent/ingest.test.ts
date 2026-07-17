import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../storage/memory.js";
import type { AgentRequestRecord, StorageAdapter } from "../storage/types.js";
import { installAgentIngest, MAX_INGEST_BATCH } from "./ingest.js";

/** One valid wire record. */
function rec(path: string): AgentRequestRecord {
  return {
    ts: 1_700_000_000_000,
    siteId: "default",
    method: "GET",
    path,
    status: 200,
    outcome: "resolved",
    httpVersion: "",
    headers: [["user-agent", "GPTBot/1.0"]],
    agentFamily: "gptbot",
    agentClass: "crawler",
    confidence: "ua-only",
    meta: { edge: true },
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

interface MountOpts {
  storage: StorageAdapter | null;
  token?: string;
}

async function mount(opts: MountOpts): Promise<string> {
  const app = express();
  app.use(express.json());
  installAgentIngest(app, {
    getStorage: () => opts.storage,
    getToken: () => opts.token,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  });
  return `http://127.0.0.1:${port}/__enpilink/agents/ingest`;
}

function post(
  url: string,
  body: unknown,
  token?: string,
): Promise<globalThis.Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("beacon sink — the guard model", () => {
  it("is DISABLED (404) when no token is configured — never an open write endpoint", async () => {
    const storage = new MemoryStorageAdapter();
    const url = await mount({ storage });
    const res = await post(url, { records: [rec("/a")] });
    expect(res.status).toBe(404);
  });

  it("rejects a missing bearer token with 401", async () => {
    const storage = new MemoryStorageAdapter();
    const url = await mount({ storage, token: "s3cret" });
    const res = await post(url, { records: [rec("/a")] });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a wrong bearer token with 401", async () => {
    const storage = new MemoryStorageAdapter();
    const url = await mount({ storage, token: "s3cret" });
    const res = await post(url, { records: [rec("/a")] }, "wrong-token");
    expect(res.status).toBe(401);
  });

  it("accepts a valid batch with the right token and persists it", async () => {
    const storage = new MemoryStorageAdapter();
    const url = await mount({ storage, token: "s3cret" });
    const res = await post(url, { records: [rec("/a"), rec("/b")] }, "s3cret");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2 });
    // Give the fire-and-forget write a tick to land.
    await new Promise((r) => setTimeout(r, 20));
    const rows = await storage.queryAgentRequests?.({});
    expect(rows?.map((r) => r.path).sort()).toEqual(["/a", "/b"]);
    expect(rows?.[0]?.agentFamily).toBe("gptbot");
  });
});

describe("beacon sink — validation", () => {
  it("rejects a bad-shaped batch with 400 (zod)", async () => {
    const storage = new MemoryStorageAdapter();
    const url = await mount({ storage, token: "s3cret" });
    // `status` is a string, `outcome` is not a valid class.
    const bad = {
      records: [
        {
          ts: 1,
          siteId: "default",
          method: "GET",
          path: "/a",
          status: "nope",
          outcome: "banana",
          httpVersion: "",
          headers: [],
        },
      ],
    };
    const res = await post(url, bad, "s3cret");
    expect(res.status).toBe(400);
  });

  it("rejects a batch over the size cap with 413", async () => {
    const storage = new MemoryStorageAdapter();
    const url = await mount({ storage, token: "s3cret" });
    const records = Array.from({ length: MAX_INGEST_BATCH + 1 }, (_, i) =>
      rec(`/p${i}`),
    );
    const res = await post(url, { records }, "s3cret");
    expect(res.status).toBe(413);
  });

  it("strips unknown top-level fields instead of persisting them", async () => {
    const storage = new MemoryStorageAdapter();
    const url = await mount({ storage, token: "s3cret" });
    const smuggled = { ...rec("/a"), evil: "DROP TABLE" } as Record<
      string,
      unknown
    >;
    const res = await post(url, { records: [smuggled] }, "s3cret");
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const rows = await storage.queryAgentRequests?.({});
    expect(rows?.[0]).not.toHaveProperty("evil");
  });
});

describe("beacon sink — degrade gracefully", () => {
  it("returns 200 { enabled:false } when there is no storage (never 500)", async () => {
    const url = await mount({ storage: null, token: "s3cret" });
    const res = await post(url, { records: [rec("/a")] }, "s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, accepted: 0 });
  });
});
