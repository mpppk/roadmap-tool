import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  featureQuarters,
  features,
  memberAllocations,
  members,
  quarters,
} from "./schema";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, {
    schema: { features, members, quarters, featureQuarters, memberAllocations },
  });

  sqlite.exec(`
    CREATE TABLE features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CONSTRAINT features_name_trimmed_check CHECK (name = trim(name)),
      CONSTRAINT features_name_not_empty_check CHECK (length(name) > 0)
    );
    CREATE UNIQUE INDEX features_name_trim_unique ON features (trim(name));

    CREATE TABLE members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CONSTRAINT members_name_trimmed_check CHECK (name = trim(name)),
      CONSTRAINT members_name_not_empty_check CHECK (length(name) > 0)
    );
    CREATE UNIQUE INDEX members_name_trim_unique ON members (trim(name));

    CREATE TABLE quarters (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, quarter INTEGER NOT NULL, UNIQUE(year, quarter));
    CREATE TABLE feature_quarters (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE, quarter_id INTEGER NOT NULL REFERENCES quarters(id) ON DELETE CASCADE, total_capacity REAL NOT NULL DEFAULT 0, UNIQUE(feature_id, quarter_id));
    CREATE TABLE member_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE, quarter_id INTEGER NOT NULL REFERENCES quarters(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, capacity REAL NOT NULL DEFAULT 0, UNIQUE(feature_id, quarter_id, member_id));
  `);

  return { sqlite, db };
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

describe("DB schema", () => {
  let state: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    state = createTestDb();
  });

  afterEach(() => {
    state.sqlite.close();
  });

  test("can insert and query a feature", async () => {
    const [inserted] = await state.db
      .insert(features)
      .values({ name: "Auth", createdAt: new Date() })
      .returning();
    expect(inserted?.name).toBe("Auth");
  });

  test("can insert a member", async () => {
    const [m] = await state.db
      .insert(members)
      .values({ name: "Alice", createdAt: new Date() })
      .returning();
    expect(m?.name).toBe("Alice");
  });

  test("can insert quarter and feature_quarter allocation", async () => {
    const [f] = await state.db
      .insert(features)
      .values({ name: "Dashboard", createdAt: new Date() })
      .returning();
    const [q] = await state.db
      .insert(quarters)
      .values({ year: 2025, quarter: 1 })
      .returning();
    const [fq] = await state.db
      .insert(featureQuarters)
      .values({ featureId: f!.id, quarterId: q!.id, totalCapacity: 2.0 })
      .returning();
    expect(fq?.totalCapacity).toBe(2.0);
  });

  test("can insert member allocation", async () => {
    const [f] = await state.db
      .insert(features)
      .values({ name: "Search", createdAt: new Date() })
      .returning();
    const [q] = await state.db
      .insert(quarters)
      .values({ year: 2025, quarter: 2 })
      .returning();
    const [m] = await state.db
      .insert(members)
      .values({ name: "Bob", createdAt: new Date() })
      .returning();
    await state.db
      .insert(featureQuarters)
      .values({ featureId: f!.id, quarterId: q!.id, totalCapacity: 1.0 });
    const [alloc] = await state.db
      .insert(memberAllocations)
      .values({
        featureId: f!.id,
        quarterId: q!.id,
        memberId: m!.id,
        capacity: 0.5,
      })
      .returning();
    expect(alloc?.capacity).toBe(0.5);
  });

  test("rejects duplicate, untrimmed, and blank feature names at DB level", () => {
    state.sqlite
      .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
      .run("Auth", Date.now());

    expectSqliteError(() => {
      state.sqlite
        .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
        .run("Auth", Date.now());
    }, "SQLITE_CONSTRAINT_UNIQUE");

    expectSqliteError(() => {
      state.sqlite
        .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
        .run(" Auth ", Date.now());
    }, "SQLITE_CONSTRAINT_CHECK");

    expectSqliteError(() => {
      state.sqlite
        .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
        .run("", Date.now());
    }, "SQLITE_CONSTRAINT_CHECK");
  });

  test("allows case differences and feature/member cross-resource name matches", () => {
    state.sqlite
      .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
      .run("Auth", Date.now());
    state.sqlite
      .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
      .run("auth", Date.now());
    state.sqlite
      .prepare("INSERT INTO members (name, created_at) VALUES (?, ?)")
      .run("Auth", Date.now());

    const featureNames = state.sqlite
      .prepare<{ name: string }, []>("SELECT name FROM features ORDER BY id")
      .all()
      .map((row) => row.name);
    const memberNames = state.sqlite
      .prepare<{ name: string }, []>("SELECT name FROM members ORDER BY id")
      .all()
      .map((row) => row.name);

    expect(featureNames).toEqual(["Auth", "auth"]);
    expect(memberNames).toEqual(["Auth"]);
  });
});
