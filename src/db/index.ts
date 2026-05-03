import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { runMigrations } from "./migrate";
import * as schema from "./schema";

const dbPath = process.env.ROADMAP_DB ?? "./db.sqlite";
const sqlite = new Database(dbPath);
sqlite.exec("PRAGMA journal_mode = WAL;");
runMigrations(sqlite);

export const db = drizzle(sqlite, { schema });
