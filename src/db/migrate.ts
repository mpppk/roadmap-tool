import type { Database } from "bun:sqlite";
import migration0000 from "../../drizzle/0000_needy_shocker.sql" with { type: "text" };

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  { name: "0000_needy_shocker", sql: migration0000 },
];

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

    for (const stmt of migration.sql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) sqlite.exec(s);
    }

    insert.run(migration.name, Date.now());
  }
}
