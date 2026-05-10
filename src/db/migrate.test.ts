import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrate";

function createOldSchemaDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
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
      .prepare<{ name: string }, []>("SELECT name FROM epics ORDER BY id")
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
    expect(applied).toContain("0002_enforce_trimmed_unique_names");
  });

  test("adds trimmed unique and check constraints", () => {
    const now = Date.now();
    sqlite
      .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
      .run("Auth", now);

    runMigrations(sqlite);
    const defaultInitiative = sqlite
      .prepare<{ id: number; name: string; is_default: number }, []>(
        "SELECT id, name, is_default FROM initiatives WHERE is_default = 1",
      )
      .get();
    expect(defaultInitiative?.name).toBe("未分類");

    expectSqliteError(() => {
      sqlite
        .prepare(
          "INSERT INTO epics (name, initiative_id, position, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("Auth", defaultInitiative!.id, 1, now);
    }, "SQLITE_CONSTRAINT_UNIQUE");

    expectSqliteError(() => {
      sqlite
        .prepare(
          "INSERT INTO epics (name, initiative_id, position, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(" Auth ", defaultInitiative!.id, 1, now);
    }, "SQLITE_CONSTRAINT_CHECK");

    sqlite
      .prepare(
        "INSERT INTO epics (name, initiative_id, position, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("auth", defaultInitiative!.id, 1, now);
    sqlite
      .prepare("INSERT INTO members (name, created_at) VALUES (?, ?)")
      .run("Auth", now);
  });

  test("adds feature metadata columns and links table", () => {
    const now = Date.now();
    sqlite
      .prepare("INSERT INTO features (name, created_at) VALUES (?, ?)")
      .run("Auth", now);

    runMigrations(sqlite);

    const feature = sqlite
      .prepare<
        {
          id: number;
          description: string | null;
          initiative_id: number;
          position: number;
        },
        []
      >(
        "SELECT id, description, initiative_id, position FROM epics WHERE name = 'Auth'",
      )
      .get();
    expect(feature?.description).toBeNull();
    expect(feature?.initiative_id).toBeGreaterThan(0);
    expect(feature?.position).toBe(0);

    sqlite
      .prepare(
        "INSERT INTO epic_links (epic_id, title, url, position) VALUES (?, ?, ?, ?)",
      )
      .run(feature!.id, "Spec", "https://example.com/spec", 0);

    const linkCount = sqlite
      .prepare<{ count: number }, []>(
        "SELECT count(*) AS count FROM epic_links",
      )
      .get();
    expect(linkCount?.count).toBe(1);

    sqlite.prepare("DELETE FROM epics WHERE id = ?").run(feature!.id);
    const remainingLinks = sqlite
      .prepare<{ count: number }, []>(
        "SELECT count(*) AS count FROM epic_links",
      )
      .get();
    expect(remainingLinks?.count).toBe(0);
  });

  test("fixes broken FK references from the rename migration", () => {
    // Simulate the broken DB state produced by the old ALTER TABLE RENAME approach
    // in 0006_rename_epic_to_initiative.
    const sqlite2 = new Database(":memory:");
    sqlite2.exec("PRAGMA foreign_keys = OFF;");
    const now = Date.now();
    sqlite2.exec(`
      CREATE TABLE __migrations (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        name   TEXT NOT NULL UNIQUE,
        ran_at INTEGER NOT NULL
      );
      INSERT INTO __migrations (name, ran_at) VALUES
        ('0000_needy_shocker', ${now}),
        ('0001_monthly_capacity', ${now}),
        ('0002_enforce_trimmed_unique_names', ${now}),
        ('0003_member_max_capacity', ${now}),
        ('0004_feature_metadata', ${now}),
        ('0005_epics', ${now}),
        ('0006_rename_epic_to_initiative', ${now});

      CREATE TABLE quarters (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, quarter INTEGER NOT NULL, UNIQUE(year,quarter));
      CREATE TABLE months (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, month INTEGER NOT NULL, quarter_id INTEGER NOT NULL REFERENCES quarters(id) ON DELETE CASCADE, UNIQUE(year,month), UNIQUE(quarter_id,month));
      CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, max_capacity REAL, created_at INTEGER NOT NULL, CONSTRAINT members_name_trimmed_check CHECK (name=trim(name)), CONSTRAINT members_name_not_empty_check CHECK (length(name)>0));
      CREATE UNIQUE INDEX members_name_trim_unique ON members (trim(name));

      -- Broken initiatives (was epics, renamed with ALTER TABLE RENAME TO)
      CREATE TABLE "initiatives" (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        CONSTRAINT epics_name_trimmed_check CHECK (name = trim(name)),
        CONSTRAINT epics_name_not_empty_check CHECK (length(name) > 0),
        CONSTRAINT epics_position_check CHECK (position >= 0)
      );
      CREATE UNIQUE INDEX epics_name_trim_unique ON initiatives (trim(name));
      CREATE UNIQUE INDEX epics_default_unique ON initiatives (is_default) WHERE is_default = 1;
      INSERT INTO initiatives (name, position, is_default, created_at) VALUES ('未分類', 0, 1, ${now});

      -- Broken initiative_links: FK references epics(id) instead of initiatives(id)
      CREATE TABLE "initiative_links" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        initiative_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        title TEXT NOT NULL, url TEXT NOT NULL, position INTEGER NOT NULL,
        CONSTRAINT epic_links_title_not_empty_check CHECK (length(title) > 0),
        CONSTRAINT epic_links_url_not_empty_check CHECK (length(url) > 0),
        CONSTRAINT epic_links_position_check CHECK (position >= 0),
        UNIQUE(initiative_id, position), UNIQUE(initiative_id, url)
      );

      -- Broken epics: FK references epics(id) (self!) instead of initiatives(id)
      CREATE TABLE "epics" (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        initiative_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        CONSTRAINT features_name_trimmed_check CHECK (name = trim(name)),
        CONSTRAINT features_name_not_empty_check CHECK (length(name) > 0),
        CONSTRAINT features_position_check CHECK (position >= 0)
      );
      CREATE UNIQUE INDEX features_name_trim_unique ON epics (trim(name));
      CREATE UNIQUE INDEX features_epic_id_position_unique ON epics (initiative_id, position);
      INSERT INTO epics (name, initiative_id, position, created_at) VALUES ('EpicA', 1, 0, ${now});

      -- Broken epic_links: FK references features(id) (non-existent) instead of epics(id)
      CREATE TABLE "epic_links" (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        epic_id INTEGER NOT NULL,
        title TEXT NOT NULL, url TEXT NOT NULL, position INTEGER NOT NULL,
        CONSTRAINT feature_links_title_not_empty_check CHECK (length(title) > 0),
        CONSTRAINT feature_links_url_not_empty_check CHECK (length(url) > 0),
        CONSTRAINT feature_links_position_check CHECK (position >= 0),
        FOREIGN KEY (epic_id) REFERENCES \`features\`(\`id\`) ON DELETE cascade,
        UNIQUE(epic_id, position), UNIQUE(epic_id, url)
      );

      -- Broken epic_months: FK references features(id) instead of epics(id)
      CREATE TABLE "epic_months" (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        epic_id INTEGER NOT NULL,
        month_id INTEGER NOT NULL,
        total_capacity REAL NOT NULL DEFAULT 0,
        FOREIGN KEY (epic_id) REFERENCES \`features\`(\`id\`) ON DELETE cascade,
        FOREIGN KEY (month_id) REFERENCES months(id) ON DELETE cascade
      );
      CREATE UNIQUE INDEX feature_months_feature_id_month_id_unique ON epic_months (epic_id, month_id);

      -- Broken member_month_allocations: FK references features(id) instead of epics(id)
      CREATE TABLE member_month_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        epic_id INTEGER NOT NULL,
        month_id INTEGER NOT NULL,
        member_id INTEGER NOT NULL,
        capacity REAL NOT NULL DEFAULT 0,
        FOREIGN KEY (epic_id) REFERENCES \`features\`(\`id\`) ON DELETE cascade,
        FOREIGN KEY (month_id) REFERENCES months(id) ON DELETE cascade,
        FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE cascade
      );
      CREATE UNIQUE INDEX member_month_allocations_feature_id_month_id_member_id_unique
        ON member_month_allocations (epic_id, month_id, member_id);
    `);

    runMigrations(sqlite2);

    sqlite2.exec("PRAGMA foreign_keys = ON;");

    // After fix, inserting an epic with initiative_id=1 should succeed
    expect(() => {
      sqlite2
        .prepare(
          "INSERT INTO epics (name, initiative_id, position, created_at) VALUES ('NewEpic', 1, 1, ?)",
        )
        .run(now);
    }).not.toThrow();

    // initiative_links FK should reference initiatives correctly
    expect(() => {
      sqlite2
        .prepare(
          "INSERT INTO initiative_links (initiative_id, title, url, position) VALUES (1, 'Link', 'https://example.com', 0)",
        )
        .run();
    }).not.toThrow();

    // No FK violations
    const violations = sqlite2.prepare("PRAGMA foreign_key_check").all();
    expect(violations).toHaveLength(0);

    sqlite2.close();
  });
});
