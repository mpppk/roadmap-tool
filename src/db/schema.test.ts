import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  epicLinks,
  epics,
  featureLinks,
  featureMonths,
  features,
  memberMonthAllocations,
  members,
  months,
  quarters,
} from "./schema";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, {
    schema: {
      epics,
      epicLinks,
      features,
      featureLinks,
      members,
      quarters,
      months,
      featureMonths,
      memberMonthAllocations,
    },
  });

  sqlite.exec(`
    CREATE TABLE epics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      CONSTRAINT epics_name_trimmed_check CHECK (name = trim(name)),
      CONSTRAINT epics_name_not_empty_check CHECK (length(name) > 0),
      CONSTRAINT epics_position_check CHECK (position >= 0)
    );
    CREATE UNIQUE INDEX epics_name_trim_unique ON epics (trim(name));
    CREATE UNIQUE INDEX epics_default_unique ON epics (is_default) WHERE is_default = 1;
    CREATE TABLE epic_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      position INTEGER NOT NULL,
      CONSTRAINT epic_links_title_not_empty_check CHECK (length(title) > 0),
      CONSTRAINT epic_links_url_not_empty_check CHECK (length(url) > 0),
      CONSTRAINT epic_links_position_check CHECK (position >= 0),
      UNIQUE(epic_id, position),
      UNIQUE(epic_id, url)
    );
    INSERT INTO epics (name, position, is_default, created_at) VALUES ('未分類', 0, 1, 0);

    CREATE TABLE features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      CONSTRAINT features_name_trimmed_check CHECK (name = trim(name)),
      CONSTRAINT features_name_not_empty_check CHECK (length(name) > 0),
      CONSTRAINT features_position_check CHECK (position >= 0)
    );
    CREATE UNIQUE INDEX features_name_trim_unique ON features (trim(name));
    CREATE UNIQUE INDEX features_epic_id_position_unique ON features (epic_id, position);

    CREATE TABLE feature_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      position INTEGER NOT NULL,
      CONSTRAINT feature_links_title_not_empty_check CHECK (length(title) > 0),
      CONSTRAINT feature_links_url_not_empty_check CHECK (length(url) > 0),
      CONSTRAINT feature_links_position_check CHECK (position >= 0),
      UNIQUE(feature_id, position),
      UNIQUE(feature_id, url)
    );

    CREATE TABLE members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      max_capacity REAL,
      created_at INTEGER NOT NULL,
      CONSTRAINT members_name_trimmed_check CHECK (name = trim(name)),
      CONSTRAINT members_name_not_empty_check CHECK (length(name) > 0),
      CONSTRAINT members_max_capacity_check CHECK (max_capacity IS NULL OR (max_capacity > 0 AND max_capacity <= 1))
    );
    CREATE UNIQUE INDEX members_name_trim_unique ON members (trim(name));

    CREATE TABLE quarters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      quarter INTEGER NOT NULL,
      UNIQUE(year, quarter)
    );
    CREATE TABLE months (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      quarter_id INTEGER NOT NULL REFERENCES quarters(id) ON DELETE CASCADE,
      UNIQUE(year, month),
      UNIQUE(quarter_id, month)
    );
    CREATE TABLE feature_months (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
      total_capacity REAL NOT NULL DEFAULT 0,
      UNIQUE(feature_id, month_id)
    );
    CREATE TABLE member_month_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      capacity REAL NOT NULL DEFAULT 0,
      UNIQUE(feature_id, month_id, member_id)
    );
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
      .values({
        name: "Auth",
        description: "Login and session management",
        epicId: 1,
        position: 0,
        createdAt: new Date(),
      })
      .returning();
    expect(inserted?.name).toBe("Auth");
    expect(inserted?.description).toBe("Login and session management");
  });

  test("can insert ordered feature links and rejects duplicate urls", async () => {
    const [feature] = await state.db
      .insert(features)
      .values({ name: "Auth", epicId: 1, position: 0, createdAt: new Date() })
      .returning();
    const [link] = await state.db
      .insert(featureLinks)
      .values({
        featureId: feature!.id,
        title: "Spec",
        url: "https://example.com/spec",
        position: 0,
      })
      .returning();
    expect(link?.title).toBe("Spec");

    expectSqliteError(() => {
      state.sqlite
        .prepare(
          "INSERT INTO feature_links (feature_id, title, url, position) VALUES (?, ?, ?, ?)",
        )
        .run(feature!.id, "Spec duplicate", "https://example.com/spec", 1);
    }, "SQLITE_CONSTRAINT_UNIQUE");
  });

  test("can insert a member", async () => {
    const [m] = await state.db
      .insert(members)
      .values({ name: "Alice", createdAt: new Date() })
      .returning();
    expect(m?.name).toBe("Alice");
  });

  test("can insert month and feature_month allocation", async () => {
    const [f] = await state.db
      .insert(features)
      .values({
        name: "Dashboard",
        epicId: 1,
        position: 0,
        createdAt: new Date(),
      })
      .returning();
    const [q] = await state.db
      .insert(quarters)
      .values({ year: 2025, quarter: 1 })
      .returning();
    const [month] = await state.db
      .insert(months)
      .values({ year: 2025, month: 1, quarterId: q!.id })
      .returning();
    const [fm] = await state.db
      .insert(featureMonths)
      .values({ featureId: f!.id, monthId: month!.id, totalCapacity: 2.0 })
      .returning();
    expect(fm?.totalCapacity).toBe(2.0);
  });

  test("can insert member month allocation", async () => {
    const [f] = await state.db
      .insert(features)
      .values({ name: "Search", epicId: 1, position: 0, createdAt: new Date() })
      .returning();
    const [q] = await state.db
      .insert(quarters)
      .values({ year: 2025, quarter: 2 })
      .returning();
    const [month] = await state.db
      .insert(months)
      .values({ year: 2025, month: 4, quarterId: q!.id })
      .returning();
    const [m] = await state.db
      .insert(members)
      .values({ name: "Bob", createdAt: new Date() })
      .returning();
    await state.db
      .insert(featureMonths)
      .values({ featureId: f!.id, monthId: month!.id, totalCapacity: 1.0 });
    const [alloc] = await state.db
      .insert(memberMonthAllocations)
      .values({
        featureId: f!.id,
        monthId: month!.id,
        memberId: m!.id,
        capacity: 0.5,
      })
      .returning();
    expect(alloc?.capacity).toBe(0.5);
  });

  test("rejects duplicate, untrimmed, and blank names at DB level", () => {
    const now = Date.now();
    state.sqlite
      .prepare(
        "INSERT INTO features (name, epic_id, position, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("Auth", 1, 0, now);
    state.sqlite
      .prepare("INSERT INTO members (name, created_at) VALUES (?, ?)")
      .run("Alice", now);

    expectSqliteError(() => {
      state.sqlite
        .prepare(
          "INSERT INTO features (name, epic_id, position, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("Auth", 1, 1, now);
    }, "SQLITE_CONSTRAINT_UNIQUE");

    expectSqliteError(() => {
      state.sqlite
        .prepare(
          "INSERT INTO features (name, epic_id, position, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(" Auth ", 1, 1, now);
    }, "SQLITE_CONSTRAINT_CHECK");

    expectSqliteError(() => {
      state.sqlite
        .prepare(
          "INSERT INTO features (name, epic_id, position, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("", 1, 1, now);
    }, "SQLITE_CONSTRAINT_CHECK");

    expectSqliteError(() => {
      state.sqlite
        .prepare("INSERT INTO members (name, created_at) VALUES (?, ?)")
        .run(" Alice ", now);
    }, "SQLITE_CONSTRAINT_CHECK");
  });

  test("members max_capacity: accepts null, valid fractions, and rejects invalid values", () => {
    const now = Date.now();
    state.sqlite
      .prepare("INSERT INTO members (name, created_at) VALUES (?, ?)")
      .run("Alice", now);
    state.sqlite
      .prepare(
        "INSERT INTO members (name, max_capacity, created_at) VALUES (?, ?, ?)",
      )
      .run("Bob", 0.8, now);
    state.sqlite
      .prepare(
        "INSERT INTO members (name, max_capacity, created_at) VALUES (?, ?, ?)",
      )
      .run("Carol", 1.0, now);

    expectSqliteError(() => {
      state.sqlite
        .prepare(
          "INSERT INTO members (name, max_capacity, created_at) VALUES (?, ?, ?)",
        )
        .run("Dave", 0, now);
    }, "SQLITE_CONSTRAINT_CHECK");

    expectSqliteError(() => {
      state.sqlite
        .prepare(
          "INSERT INTO members (name, max_capacity, created_at) VALUES (?, ?, ?)",
        )
        .run("Eve", 1.1, now);
    }, "SQLITE_CONSTRAINT_CHECK");

    expectSqliteError(() => {
      state.sqlite
        .prepare(
          "INSERT INTO members (name, max_capacity, created_at) VALUES (?, ?, ?)",
        )
        .run("Frank", -0.5, now);
    }, "SQLITE_CONSTRAINT_CHECK");
  });

  test("allows case differences and feature/member cross-resource name matches", () => {
    state.sqlite
      .prepare(
        "INSERT INTO features (name, epic_id, position, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("Auth", 1, 0, Date.now());
    state.sqlite
      .prepare(
        "INSERT INTO features (name, epic_id, position, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("auth", 1, 1, Date.now());
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
