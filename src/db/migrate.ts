import type { Database } from "bun:sqlite";
import migration0000 from "../../drizzle/0000_needy_shocker.sql" with {
  type: "text",
};
import migration0001 from "../../drizzle/0001_monthly_capacity.sql" with {
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
