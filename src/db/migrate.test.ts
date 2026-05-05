import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrate";

function createOldSchemaDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE __migrations (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      name   TEXT NOT NULL UNIQUE,
      ran_at INTEGER NOT NULL
    );
    INSERT INTO __migrations (name, ran_at) VALUES ('0000_needy_shocker', 0);

    CREATE TABLE features (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX features_name_unique ON features (name);

    CREATE TABLE members (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX members_name_unique ON members (name);

    CREATE TABLE quarters (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      year integer NOT NULL,
      quarter integer NOT NULL
    );
    CREATE UNIQUE INDEX quarters_year_quarter_unique ON quarters (year, quarter);

    CREATE TABLE feature_quarters (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      feature_id integer NOT NULL,
      quarter_id integer NOT NULL,
      total_capacity real DEFAULT 0 NOT NULL,
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE cascade,
      FOREIGN KEY (quarter_id) REFERENCES quarters(id) ON DELETE cascade
    );
    CREATE UNIQUE INDEX feature_quarters_feature_id_quarter_id_unique ON feature_quarters (feature_id, quarter_id);

    CREATE TABLE member_allocations (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      feature_id integer NOT NULL,
      quarter_id integer NOT NULL,
      member_id integer NOT NULL,
      capacity real DEFAULT 0 NOT NULL,
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE cascade,
      FOREIGN KEY (quarter_id) REFERENCES quarters(id) ON DELETE cascade,
      FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE cascade
    );
    CREATE UNIQUE INDEX member_allocations_feature_id_quarter_id_member_id_unique ON member_allocations (feature_id, quarter_id, member_id);
  `);
  return sqlite;
}

function expectSqliteError(fn: () => void, code: string) {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected SQLite error ${code}`);
}

describe("DB migrations", () => {
  let sqlite: Database;

  beforeEach(() => {
    sqlite = createOldSchemaDb();
  });

  afterEach(() => {
    sqlite.close();
  });

  test("normalizes existing duplicate and blank feature/member names", () => {
    const now = Date.now();
    const insertFeature = sqlite.prepare(
      "INSERT INTO features (name, created_at) VALUES (?, ?)",
    );
    insertFeature.run("Auth", now);
    insertFeature.run(" Auth ", now);
    insertFeature.run("Auth-2", now);
    insertFeature.run(" Auth-2 ", now);
    insertFeature.run("   ", now);

    const insertMember = sqlite.prepare(
      "INSERT INTO members (name, created_at) VALUES (?, ?)",
    );
    insertMember.run("Alice", now);
    insertMember.run(" Alice ", now);
    insertMember.run("Member", now);
    insertMember.run(" ", now);

    runMigrations(sqlite);

    const featureNames = sqlite
      .prepare<{ name: string }, []>("SELECT name FROM features ORDER BY id")
      .all()
      .map((row) => row.name);
    const memberNames = sqlite
      .prepare<{ name: string }, []>("SELECT name FROM members ORDER BY id")
      .all()
      .map((row) => row.name);
    const applied = sqlite
      .prepare<{ name: string }, []>(
        "SELECT name FROM __migrations ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(featureNames).toEqual([
      "Auth",
      "Auth-3",
      "Auth-2",
      "Auth-2-2",
      "Feature",
    ]);
    expect(memberNames).toEqual(["Alice", "Alice-2", "Member", "Member-2"]);
    expect(applied).toContain("0001_enforce_trimmed_unique_names");
  });

  test("adds trimmed unique and check constraints", () => {
    const now = Date.now();
    sqlite
      .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
      .run("Auth", now);

    runMigrations(sqlite);

    expectSqliteError(() => {
      sqlite
        .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
        .run("Auth", now);
    }, "SQLITE_CONSTRAINT_UNIQUE");

    expectSqliteError(() => {
      sqlite
        .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
        .run(" Auth ", now);
    }, "SQLITE_CONSTRAINT_CHECK");

    sqlite
      .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
      .run("auth", now);
    sqlite
      .prepare("INSERT INTO members (name, created_at) VALUES (?, ?)")
      .run("Auth", now);
  });
});
