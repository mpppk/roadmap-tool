import type { Database } from "bun:sqlite";
import migration0000 from "../../drizzle/0000_needy_shocker.sql" with {
  type: "text",
};
import migration0001 from "../../drizzle/0001_monthly_capacity.sql" with {
  type: "text",
};
import migration0003 from "../../drizzle/0003_member_max_capacity.sql" with {
  type: "text",
};
import migration0004 from "../../drizzle/0004_feature_metadata.sql" with {
  type: "text",
};
import migration0008 from "../../drizzle/0008_member_position.sql" with {
  type: "text",
};
import { trimSqliteSpaces } from "../name-errors";

type Migration = {
  name: string;
  sql?: string;
  up?: (sqlite: Database) => void;
  transaction?: boolean;
};

type NameRow = {
  id: number;
  name: string;
  created_at: number;
};

const MIGRATIONS: Migration[] = [
  { name: "0000_needy_shocker", sql: migration0000 },
  { name: "0001_monthly_capacity", sql: migration0001 },
  {
    name: "0002_enforce_trimmed_unique_names",
    up: enforceTrimmedUniqueNames,
    transaction: false,
  },
  { name: "0003_member_max_capacity", sql: migration0003 },
  { name: "0004_feature_metadata", sql: migration0004 },
  {
    name: "0005_epics",
    up: addEpics,
    transaction: false,
  },
  {
    name: "0006_rename_epic_to_initiative",
    up: renameEpicToInitiative,
    transaction: false,
  },
  {
    name: "0007_fix_fk_references",
    up: fixFkReferences,
    transaction: false,
  },
  { name: "0008_member_position", sql: migration0008 },
];

function normalizedNameRows(
  rows: NameRow[],
  fallbackBaseName: string,
): NameRow[] {
  const baseNames = rows.map((row) => {
    const trimmed = trimSqliteSpaces(row.name);
    return trimmed.length > 0 ? trimmed : fallbackBaseName;
  });
  const counts = new Map<string, number>();
  for (const baseName of baseNames) {
    counts.set(baseName, (counts.get(baseName) ?? 0) + 1);
  }

  const reservedBaseNames = new Set(baseNames);

  const used = new Set<string>();
  return rows.map((row, index) => {
    const baseName = baseNames[index]!;
    let name = baseName;
    if (used.has(name)) {
      for (let suffix = 2; ; suffix += 1) {
        const candidate = `${baseName}-${suffix}`;
        if (!used.has(candidate) && !reservedBaseNames.has(candidate)) {
          name = candidate;
          break;
        }
      }
    }
    used.add(name);
    return { ...row, name };
  });
}

function rebuildNameTable(
  sqlite: Database,
  tableName: "features" | "members",
  fallbackBaseName: "Feature" | "Member",
): void {
  const rows = sqlite
    .prepare<NameRow, []>(
      `SELECT id, name, created_at FROM ${tableName} ORDER BY id`,
    )
    .all();
  const normalizedRows = normalizedNameRows(rows, fallbackBaseName);
  const newTableName = `${tableName}__new`;
  const oldUniqueIndexName = `${tableName}_name_unique`;
  const trimUniqueIndexName = `${tableName}_name_trim_unique`;
  const trimmedCheckName = `${tableName}_name_trimmed_check`;
  const notEmptyCheckName = `${tableName}_name_not_empty_check`;

  sqlite.exec(`DROP INDEX IF EXISTS ${oldUniqueIndexName}`);
  sqlite.exec(`DROP INDEX IF EXISTS ${trimUniqueIndexName}`);
  sqlite.exec(`DROP TABLE IF EXISTS ${newTableName}`);
  sqlite.exec(`
    CREATE TABLE ${newTableName} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CONSTRAINT ${trimmedCheckName} CHECK (name = trim(name)),
      CONSTRAINT ${notEmptyCheckName} CHECK (length(name) > 0)
    )
  `);

  const insert = sqlite.prepare(
    `INSERT INTO ${newTableName} (id, name, created_at) VALUES (?, ?, ?)`,
  );
  for (const row of normalizedRows) {
    insert.run(row.id, row.name, row.created_at);
  }

  sqlite.exec(`DROP TABLE ${tableName}`);
  sqlite.exec(`ALTER TABLE ${newTableName} RENAME TO ${tableName}`);
  sqlite.exec(
    `CREATE UNIQUE INDEX ${trimUniqueIndexName} ON ${tableName} (trim(name))`,
  );
}

function enforceTrimmedUniqueNames(sqlite: Database): void {
  const pragma = sqlite
    .prepare<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
    .get();
  const foreignKeysEnabled = pragma?.foreign_keys === 1;

  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite.exec("BEGIN");
  try {
    rebuildNameTable(sqlite, "features", "Feature");
    rebuildNameTable(sqlite, "members", "Member");
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  } finally {
    sqlite.exec(`PRAGMA foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`);
  }
}

function addEpics(sqlite: Database): void {
  const pragma = sqlite
    .prepare<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
    .get();
  const foreignKeysEnabled = pragma?.foreign_keys === 1;
  const now = Date.now();

  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite.exec("BEGIN");
  try {
    sqlite.exec(`
      CREATE TABLE epics (
        id          INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        position    INTEGER NOT NULL DEFAULT 0,
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        CONSTRAINT epics_name_trimmed_check CHECK (name = trim(name)),
        CONSTRAINT epics_name_not_empty_check CHECK (length(name) > 0),
        CONSTRAINT epics_position_check CHECK (position >= 0)
      );
      CREATE UNIQUE INDEX epics_name_trim_unique ON epics (trim(name));
      CREATE UNIQUE INDEX epics_default_unique ON epics (is_default) WHERE is_default = 1;

      CREATE TABLE epic_links (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        epic_id  INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        title    TEXT NOT NULL,
        url      TEXT NOT NULL,
        position INTEGER NOT NULL,
        CONSTRAINT epic_links_title_not_empty_check CHECK (length(title) > 0),
        CONSTRAINT epic_links_url_not_empty_check CHECK (length(url) > 0),
        CONSTRAINT epic_links_position_check CHECK (position >= 0),
        UNIQUE(epic_id, position),
        UNIQUE(epic_id, url)
      );
    `);

    const defaultEpic = sqlite
      .prepare<{ id: number }, [string, number, number, number]>(
        "INSERT INTO epics (name, position, is_default, created_at) VALUES (?, ?, ?, ?) RETURNING id",
      )
      .get("未分類", 0, 1, now);
    if (!defaultEpic) throw new Error("Failed to create default Epic");

    sqlite.exec(`
      DROP INDEX IF EXISTS features_name_unique;
      DROP INDEX IF EXISTS features_name_trim_unique;
      DROP TABLE IF EXISTS features__new;
      CREATE TABLE features__new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        epic_id     INTEGER NOT NULL REFERENCES epics(id) ON DELETE RESTRICT,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        CONSTRAINT features_name_trimmed_check CHECK (name = trim(name)),
        CONSTRAINT features_name_not_empty_check CHECK (length(name) > 0),
        CONSTRAINT features_position_check CHECK (position >= 0)
      );
    `);

    const rows = sqlite
      .prepare<
        {
          id: number;
          name: string;
          description: string | null;
          created_at: number;
        },
        []
      >("SELECT id, name, description, created_at FROM features ORDER BY id")
      .all();
    const insert = sqlite.prepare(
      "INSERT INTO features__new (id, name, description, epic_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    rows.forEach((row, index) => {
      insert.run(
        row.id,
        row.name,
        row.description,
        defaultEpic.id,
        index,
        row.created_at,
      );
    });

    sqlite.exec(`
      DROP TABLE features;
      ALTER TABLE features__new RENAME TO features;
      CREATE UNIQUE INDEX features_name_trim_unique ON features (trim(name));
      CREATE UNIQUE INDEX features_epic_id_position_unique ON features (epic_id, position);
    `);

    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  } finally {
    sqlite.exec(`PRAGMA foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`);
  }
}

function renameEpicToInitiative(sqlite: Database): void {
  const pragma = sqlite
    .prepare<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
    .get();
  const foreignKeysEnabled = pragma?.foreign_keys === 1;

  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite.exec("BEGIN");
  try {
    // Rename epics (old "Epic" / grouping concept) → initiatives
    // Drop old epics indexes before rename to free up their names for later use
    sqlite.exec(`
      DROP INDEX IF EXISTS epics_name_trim_unique;
      DROP INDEX IF EXISTS epics_default_unique;
      ALTER TABLE epics RENAME TO initiatives;
      CREATE UNIQUE INDEX initiatives_name_trim_unique ON initiatives (trim(name));
    `);
    // Rename epic_links → initiative_links and update FK to reference initiatives
    sqlite.exec(`
      CREATE TABLE initiative_links (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        initiative_id   INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        url             TEXT NOT NULL,
        position        INTEGER NOT NULL,
        CONSTRAINT initiative_links_title_not_empty_check CHECK (length(title) > 0),
        CONSTRAINT initiative_links_url_not_empty_check CHECK (length(url) > 0),
        CONSTRAINT initiative_links_position_check CHECK (position >= 0),
        UNIQUE(initiative_id, position),
        UNIQUE(initiative_id, url)
      );
      INSERT INTO initiative_links (id, initiative_id, title, url, position)
        SELECT id, epic_id, title, url, position FROM epic_links;
      DROP TABLE epic_links;
    `);

    // Rename features (old "Feature" / item concept) → epics, updating initiative_id FK
    sqlite.exec(`
      DROP INDEX IF EXISTS features_name_trim_unique;
      DROP INDEX IF EXISTS features_epic_id_position_unique;
      CREATE TABLE epics (
        id            INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name          TEXT NOT NULL,
        description   TEXT,
        initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE RESTRICT,
        position      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        CONSTRAINT epics_name_trimmed_check CHECK (name = trim(name)),
        CONSTRAINT epics_name_not_empty_check CHECK (length(name) > 0),
        CONSTRAINT epics_position_check CHECK (position >= 0)
      );
      INSERT INTO epics (id, name, description, initiative_id, position, created_at)
        SELECT id, name, description, epic_id, position, created_at FROM features;
      DROP TABLE features;
      CREATE UNIQUE INDEX epics_name_trim_unique ON epics (trim(name));
      CREATE UNIQUE INDEX epics_initiative_id_position_unique ON epics (initiative_id, position);
    `);

    // Rename feature_links → epic_links, updating FK to reference epics
    sqlite.exec(`
      CREATE TABLE epic_links (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        epic_id  INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        title    TEXT NOT NULL,
        url      TEXT NOT NULL,
        position INTEGER NOT NULL,
        CONSTRAINT epic_links_title_not_empty_check CHECK (length(title) > 0),
        CONSTRAINT epic_links_url_not_empty_check CHECK (length(url) > 0),
        CONSTRAINT epic_links_position_check CHECK (position >= 0),
        UNIQUE(epic_id, position),
        UNIQUE(epic_id, url)
      );
      INSERT INTO epic_links (id, epic_id, title, url, position)
        SELECT id, feature_id, title, url, position FROM feature_links;
      DROP TABLE feature_links;
    `);

    // Rename feature_months → epic_months, updating FK to reference epics
    sqlite.exec(`
      DROP INDEX IF EXISTS feature_months_feature_id_month_id_unique;
      CREATE TABLE epic_months (
        id             INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        epic_id        INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        month_id       INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
        total_capacity REAL DEFAULT 0 NOT NULL
      );
      INSERT INTO epic_months (id, epic_id, month_id, total_capacity)
        SELECT id, feature_id, month_id, total_capacity FROM feature_months;
      DROP TABLE feature_months;
      CREATE UNIQUE INDEX epic_months_epic_id_month_id_unique ON epic_months (epic_id, month_id);
    `);

    // Rebuild member_month_allocations with FK referencing epics
    sqlite.exec(`
      DROP INDEX IF EXISTS member_month_allocations_feature_id_month_id_member_id_unique;
      CREATE TABLE member_month_allocations__new (
        id       INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        epic_id  INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        capacity REAL DEFAULT 0 NOT NULL
      );
      INSERT INTO member_month_allocations__new (id, epic_id, month_id, member_id, capacity)
        SELECT id, feature_id, month_id, member_id, capacity FROM member_month_allocations;
      DROP TABLE member_month_allocations;
      ALTER TABLE member_month_allocations__new RENAME TO member_month_allocations;
      CREATE UNIQUE INDEX member_month_allocations_epic_id_month_id_member_id_unique
        ON member_month_allocations (epic_id, month_id, member_id);
    `);

    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  } finally {
    sqlite.exec(`PRAGMA foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`);
  }
}

function runSqlMigration(sqlite: Database, sql: string): void {
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) sqlite.exec(s);
  }
}

function runMigration(sqlite: Database, migration: Migration): void {
  if (migration.transaction === false) {
    if (migration.sql) runSqlMigration(sqlite, migration.sql);
    migration.up?.(sqlite);
    return;
  }

  sqlite.exec("BEGIN");
  try {
    if (migration.sql) runSqlMigration(sqlite, migration.sql);
    migration.up?.(sqlite);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Migration 0007: Fix incorrect FK references left by the 0006 migration.
 *
 * The 0006_rename_epic_to_initiative migration was sometimes applied using an
 * older version of the migration code that used ALTER TABLE RENAME TO instead
 * of the CREATE+INSERT+DROP approach. This left FK references pointing to the
 * wrong tables:
 *   - epics.initiative_id → REFERENCES epics(id) [self-ref!] instead of initiatives(id)
 *   - initiative_links.initiative_id → REFERENCES epics(id) instead of initiatives(id)
 *   - epic_links.epic_id → REFERENCES features(id) [non-existent] instead of epics(id)
 *   - epic_months.epic_id → REFERENCES features(id) [non-existent] instead of epics(id)
 *   - member_month_allocations.epic_id → REFERENCES features(id) [non-existent] instead of epics(id)
 *
 * This migration detects and rebuilds affected tables so FK constraints are correct.
 */
function fixFkReferences(sqlite: Database): void {
  const pragma = sqlite
    .prepare<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
    .get();
  const foreignKeysEnabled = pragma?.foreign_keys === 1;

  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite.exec("BEGIN");
  try {
    // Check if epics table has broken self-referential FK (initiative_id → epics)
    // by inspecting the stored CREATE TABLE SQL in sqlite_master.
    const epicsInfo = sqlite
      .prepare<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get("epics");

    if (epicsInfo?.sql?.includes("REFERENCES epics(id)")) {
      // Rebuild epics with correct FK → initiatives(id)
      sqlite.exec(`
        DROP INDEX IF EXISTS features_name_trim_unique;
        DROP INDEX IF EXISTS epics_name_trim_unique;
        DROP INDEX IF EXISTS features_epic_id_position_unique;
        DROP INDEX IF EXISTS epics_initiative_id_position_unique;
        DROP TABLE IF EXISTS epics__fix;
        CREATE TABLE epics__fix (
          id            INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          name          TEXT NOT NULL,
          description   TEXT,
          initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE RESTRICT,
          position      INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL,
          CONSTRAINT epics_name_trimmed_check CHECK (name = trim(name)),
          CONSTRAINT epics_name_not_empty_check CHECK (length(name) > 0),
          CONSTRAINT epics_position_check CHECK (position >= 0)
        );
        INSERT INTO epics__fix SELECT * FROM epics;
        DROP TABLE epics;
        ALTER TABLE epics__fix RENAME TO epics;
        CREATE UNIQUE INDEX epics_name_trim_unique ON epics (trim(name));
        CREATE UNIQUE INDEX epics_initiative_id_position_unique ON epics (initiative_id, position);
      `);
    }

    // Check if initiative_links has broken FK (initiative_id → epics instead of initiatives)
    const initLinksInfo = sqlite
      .prepare<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get("initiative_links");

    if (initLinksInfo?.sql?.includes("REFERENCES epics(id)")) {
      sqlite.exec(`
        DROP TABLE IF EXISTS initiative_links__fix;
        CREATE TABLE initiative_links__fix (
          id            INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
          title         TEXT NOT NULL,
          url           TEXT NOT NULL,
          position      INTEGER NOT NULL,
          CONSTRAINT initiative_links_title_not_empty_check CHECK (length(title) > 0),
          CONSTRAINT initiative_links_url_not_empty_check CHECK (length(url) > 0),
          CONSTRAINT initiative_links_position_check CHECK (position >= 0),
          UNIQUE(initiative_id, position),
          UNIQUE(initiative_id, url)
        );
        INSERT INTO initiative_links__fix SELECT * FROM initiative_links;
        DROP TABLE initiative_links;
        ALTER TABLE initiative_links__fix RENAME TO initiative_links;
      `);
    }

    // Check if epic_links has broken FK (epic_id → features instead of epics)
    const epicLinksInfo = sqlite
      .prepare<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get("epic_links");

    if (epicLinksInfo?.sql?.includes("REFERENCES `features`")) {
      sqlite.exec(`
        DROP INDEX IF EXISTS feature_links_feature_id_position_unique;
        DROP INDEX IF EXISTS feature_links_feature_id_url_unique;
        DROP INDEX IF EXISTS epic_links_epic_id_position_unique;
        DROP INDEX IF EXISTS epic_links_epic_id_url_unique;
        DROP TABLE IF EXISTS epic_links__fix;
        CREATE TABLE epic_links__fix (
          id       INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          epic_id  INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
          title    TEXT NOT NULL,
          url      TEXT NOT NULL,
          position INTEGER NOT NULL,
          CONSTRAINT epic_links_title_not_empty_check CHECK (length(title) > 0),
          CONSTRAINT epic_links_url_not_empty_check CHECK (length(url) > 0),
          CONSTRAINT epic_links_position_check CHECK (position >= 0),
          UNIQUE(epic_id, position),
          UNIQUE(epic_id, url)
        );
        INSERT INTO epic_links__fix SELECT * FROM epic_links;
        DROP TABLE epic_links;
        ALTER TABLE epic_links__fix RENAME TO epic_links;
      `);
    }

    // Check if epic_months has broken FK (epic_id → features instead of epics)
    const epicMonthsInfo = sqlite
      .prepare<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get("epic_months");

    if (epicMonthsInfo?.sql?.includes("REFERENCES `features`")) {
      sqlite.exec(`
        DROP INDEX IF EXISTS feature_months_feature_id_month_id_unique;
        DROP INDEX IF EXISTS epic_months_epic_id_month_id_unique;
        DROP TABLE IF EXISTS epic_months__fix;
        CREATE TABLE epic_months__fix (
          id             INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          epic_id        INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
          month_id       INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
          total_capacity REAL NOT NULL DEFAULT 0
        );
        INSERT INTO epic_months__fix SELECT * FROM epic_months;
        DROP TABLE epic_months;
        ALTER TABLE epic_months__fix RENAME TO epic_months;
        CREATE UNIQUE INDEX epic_months_epic_id_month_id_unique ON epic_months (epic_id, month_id);
      `);
    }

    // Check if member_month_allocations has broken FK (epic_id → features instead of epics)
    const mmaInfo = sqlite
      .prepare<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get("member_month_allocations");

    if (mmaInfo?.sql?.includes("REFERENCES `features`")) {
      sqlite.exec(`
        DROP INDEX IF EXISTS member_month_allocations_feature_id_month_id_member_id_unique;
        DROP INDEX IF EXISTS member_month_allocations_epic_id_month_id_member_id_unique;
        DROP TABLE IF EXISTS member_month_allocations__fix;
        CREATE TABLE member_month_allocations__fix (
          id        INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          epic_id   INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
          month_id  INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
          member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          capacity  REAL NOT NULL DEFAULT 0
        );
        INSERT INTO member_month_allocations__fix SELECT * FROM member_month_allocations;
        DROP TABLE member_month_allocations;
        ALTER TABLE member_month_allocations__fix RENAME TO member_month_allocations;
        CREATE UNIQUE INDEX member_month_allocations_epic_id_month_id_member_id_unique
          ON member_month_allocations (epic_id, month_id, member_id);
      `);
    }

    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  } finally {
    sqlite.exec(`PRAGMA foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`);
  }
}

export function runMigrations(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __migrations (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      name   TEXT NOT NULL UNIQUE,
      ran_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    sqlite
      .prepare<{ name: string }, []>("SELECT name FROM __migrations")
      .all()
      .map((r) => r.name),
  );

  const insert = sqlite.prepare(
    "INSERT INTO __migrations (name, ran_at) VALUES (?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;

    runMigration(sqlite, migration);

    insert.run(migration.name, Date.now());
  }
}
