import { describe, expect, it, vi } from "vitest";
import type { AgentRequestRecord } from "../../storage/types.js";
import {
  D1CaptureSink,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  ensureD1Schema,
} from "./d1.js";

/** A prepared statement that records its bound params. */
class FakeStatement implements D1PreparedStatementLike {
  bound: unknown[] = [];
  constructor(
    readonly sql: string,
    private readonly onBind: (s: FakeStatement) => void,
  ) {}
  bind(...values: unknown[]): D1PreparedStatementLike {
    const s = new FakeStatement(this.sql, this.onBind);
    s.bound = values;
    this.onBind(s);
    return s;
  }
  async run(): Promise<unknown> {
    return {};
  }
}

/** An in-memory D1 double capturing prepared/bound statements + batches. */
class FakeD1 implements D1DatabaseLike {
  readonly prepared: FakeStatement[] = [];
  readonly bound: FakeStatement[] = [];
  readonly batches: D1PreparedStatementLike[][] = [];
  prepare(query: string): D1PreparedStatementLike {
    const s = new FakeStatement(query, (b) => this.bound.push(b));
    this.prepared.push(s);
    return s;
  }
  async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
    this.batches.push(statements);
    return statements.map(() => ({}));
  }
}

function rec(over: Partial<AgentRequestRecord> = {}): AgentRequestRecord {
  return {
    ts: 1000,
    siteId: "default",
    method: "GET",
    path: "/x",
    status: 404,
    outcome: "dead_end",
    httpVersion: "",
    headers: [["User-Agent", "GPTBot"]],
    agentFamily: "gptbot",
    agentClass: "crawler",
    confidence: "ua-only",
    rulesetVersion: "v1",
    ...over,
  };
}

describe("D1CaptureSink", () => {
  it("batch-inserts records with params matching the sqlite column order", async () => {
    const db = new FakeD1();
    const sink = new D1CaptureSink({ db });
    await sink.write([rec(), rec({ path: "/y" })]);

    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    const first = db.bound[0]?.bound;
    // Positional order per INSERT_SQL / agentRequestParams.
    expect(first?.[0]).toBe(1000); // ts
    expect(first?.[1]).toBe("default"); // site_id
    expect(first?.[2]).toBe("GET"); // method
    expect(first?.[3]).toBe("/x"); // path
    expect(first?.[4]).toBe(404); // status
    expect(first?.[5]).toBe("dead_end"); // outcome
    expect(first?.[7]).toBe(JSON.stringify([["User-Agent", "GPTBot"]])); // headers
    expect(first?.[12]).toBe("gptbot"); // agent_family
    expect(first?.[13]).toBe("crawler"); // agent_class
    expect(first?.[14]).toBe("ua-only"); // confidence
    expect(first?.[20]).toBe("v1"); // ruleset_version
  });

  it("is a no-op for an empty batch", async () => {
    const db = new FakeD1();
    await new D1CaptureSink({ db }).write([]);
    expect(db.batches).toHaveLength(0);
  });

  it("is best-effort: a D1 failure is swallowed and reported, never thrown", async () => {
    const onError = vi.fn();
    const db: D1DatabaseLike = {
      prepare: () =>
        ({
          bind: () => ({ run: async () => ({}) }) as D1PreparedStatementLike,
          run: async () => ({}),
        }) as D1PreparedStatementLike,
      batch: async () => {
        throw new Error("d1 down");
      },
    };
    const sink = new D1CaptureSink({ db, onError });
    await expect(sink.write([rec()])).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("ensureD1Schema creates the tables in one batch", async () => {
    const db = new FakeD1();
    await ensureD1Schema(db);
    expect(db.batches).toHaveLength(1);
    const stmts = db.prepared.map((s) => s.sql).join("\n");
    expect(stmts).toContain("CREATE TABLE IF NOT EXISTS agent_requests");
    expect(stmts).toContain("CREATE TABLE IF NOT EXISTS agent_sites");
  });
});
