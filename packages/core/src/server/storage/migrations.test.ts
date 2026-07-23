import Database from "better-sqlite3";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import {
  LATEST_MIGRATION_VERSION,
  MIGRATIONS,
  runPostgresMigrations,
  runSqliteMigrations,
} from "./migrations.js";
import type { PgPoolLike } from "./postgres.js";

const ALL_VERSIONS = MIGRATIONS.map((m) => m.version);

describe("sqlite migrations", () => {
  it("applies pending migrations once and is idempotent on a second run", () => {
    const db = new Database(":memory:");
    try {
      const first = runSqliteMigrations(db);
      expect(first).toEqual(ALL_VERSIONS);
      expect(db.pragma("user_version", { simple: true })).toBe(
        LATEST_MIGRATION_VERSION,
      );

      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(tables).toContain("agent_requests");
      expect(tables).toContain("agent_sites");

      // Running again applies nothing — the version guard makes it a no-op.
      const second = runSqliteMigrations(db);
      expect(second).toEqual([]);
      expect(db.pragma("user_version", { simple: true })).toBe(
        LATEST_MIGRATION_VERSION,
      );
    } finally {
      db.close();
    }
  });

  it("is idempotent against an EXISTING db that predates the agent surface", () => {
    const db = new Database(":memory:");
    try {
      // Simulate a real, pre-existing enpilink.db: a legacy `events` table with
      // data and PRAGMA user_version still 0.
      db.exec(
        `CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL);`,
      );
      db.prepare("INSERT INTO events (ts, type) VALUES (?, ?)").run(
        1,
        "tool_call",
      );
      expect(db.pragma("user_version", { simple: true })).toBe(0);

      const applied = runSqliteMigrations(db);
      expect(applied).toEqual(ALL_VERSIONS);

      // The agent table now exists AND the legacy data is untouched.
      const events = db.prepare("SELECT count(*) AS c FROM events").get() as {
        c: number;
      };
      expect(events.c).toBe(1);
      const areq = db
        .prepare("SELECT count(*) AS c FROM agent_requests")
        .get() as { c: number };
      expect(areq.c).toBe(0);

      // A second run against the now-migrated existing DB is a clean no-op.
      expect(runSqliteMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("migration 3 adds served + served_encoding to an existing v2 db, idempotently", () => {
    const db = new Database(":memory:");
    try {
      // Simulate a real DB migrated only up to v2 (agent_requests WITHOUT the
      // M4 served columns; user_version pinned at 2).
      db.exec(MIGRATIONS[0]?.sqlite ?? "");
      db.exec(MIGRATIONS[1]?.sqlite ?? "");
      db.pragma("user_version = 2");
      const before = (
        db.prepare("PRAGMA table_info(agent_requests)").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(before).not.toContain("served");

      // Running the runner applies migrations 3 AND 4 (everything past v2).
      expect(runSqliteMigrations(db)).toEqual([3, 4]);
      const after = (
        db.prepare("PRAGMA table_info(agent_requests)").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(after).toContain("served");
      expect(after).toContain("served_encoding");

      // Idempotent: a second run adds nothing (no duplicate-column error).
      expect(runSqliteMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("migration 4 adds ruleset_version to an existing v3 db, idempotently", () => {
    const db = new Database(":memory:");
    try {
      // Simulate a real DB migrated only up to v3 (no ruleset_version column;
      // user_version pinned at 3).
      db.exec(MIGRATIONS[0]?.sqlite ?? "");
      db.exec(MIGRATIONS[1]?.sqlite ?? "");
      db.exec(MIGRATIONS[2]?.sqlite ?? "");
      db.pragma("user_version = 3");
      const before = (
        db.prepare("PRAGMA table_info(agent_requests)").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(before).not.toContain("ruleset_version");

      // Running the runner applies ONLY migration 4 and adds the column.
      expect(runSqliteMigrations(db)).toEqual([4]);
      const after = (
        db.prepare("PRAGMA table_info(agent_requests)").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(after).toContain("ruleset_version");

      // Idempotent: a second run adds nothing (no duplicate-column error).
      expect(runSqliteMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("postgres migrations (pg-mem)", () => {
  function makePool(): PgPoolLike {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    return new Pool() as unknown as PgPoolLike;
  }

  it("applies once, records versions, and is idempotent", async () => {
    const pool = makePool();
    try {
      const first = await runPostgresMigrations(pool);
      expect(first).toEqual(ALL_VERSIONS);

      const second = await runPostgresMigrations(pool);
      expect(second).toEqual([]);

      // Exactly one schema_migrations row per migration (no dupes on re-run).
      const { rows } = await pool.query<{ version: number | string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(rows.map((r) => Number(r.version))).toEqual(ALL_VERSIONS);
    } finally {
      await pool.end();
    }
  });

  it("migration 3 adds the served columns (selectable after migrating)", async () => {
    const pool = makePool();
    try {
      await runPostgresMigrations(pool);
      // If migration 3 did not run, referencing `served` here would throw.
      const { rows } = await pool.query(
        "SELECT served, served_encoding FROM agent_requests",
      );
      expect(rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it("migration 4 adds ruleset_version (selectable after migrating)", async () => {
    const pool = makePool();
    try {
      await runPostgresMigrations(pool);
      // If migration 4 did not run, referencing `ruleset_version` would throw.
      const { rows } = await pool.query(
        "SELECT ruleset_version FROM agent_requests",
      );
      expect(rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
