import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  featureQuarters,
  features,
  memberAllocations,
  members,
  quarters,
} from "./schema";

describe("DB schema", () => {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, {
    schema: { features, members, quarters, featureQuarters, memberAllocations },
  });

  beforeAll(() => {
    sqlite.exec(`
      CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE quarters (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, quarter INTEGER NOT NULL, UNIQUE(year, quarter));
      CREATE TABLE feature_quarters (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE, quarter_id INTEGER NOT NULL REFERENCES quarters(id) ON DELETE CASCADE, total_person_months REAL NOT NULL DEFAULT 0, UNIQUE(feature_id, quarter_id));
      CREATE TABLE member_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE, quarter_id INTEGER NOT NULL REFERENCES quarters(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, person_months REAL NOT NULL DEFAULT 0, UNIQUE(feature_id, quarter_id, member_id));
    `);
  });

  afterAll(() => {
    sqlite.close();
  });

  test("can insert and query a feature", async () => {
    const [inserted] = await db
      .insert(features)
      .values({ name: "Auth", createdAt: new Date() })
      .returning();
    expect(inserted?.name).toBe("Auth");
  });

  test("can insert a member", async () => {
    const [m] = await db
      .insert(members)
      .values({ name: "Alice", createdAt: new Date() })
      .returning();
    expect(m?.name).toBe("Alice");
  });

  test("can insert quarter and feature_quarter allocation", async () => {
    const [f] = await db
      .insert(features)
      .values({ name: "Dashboard", createdAt: new Date() })
      .returning();
    const [q] = await db
      .insert(quarters)
      .values({ year: 2025, quarter: 1 })
      .returning();
    const [fq] = await db
      .insert(featureQuarters)
      .values({ featureId: f!.id, quarterId: q!.id, totalPersonMonths: 2.0 })
      .returning();
    expect(fq?.totalPersonMonths).toBe(2.0);
  });

  test("can insert member allocation", async () => {
    const [f] = await db
      .insert(features)
      .values({ name: "Search", createdAt: new Date() })
      .returning();
    const [q] = await db
      .insert(quarters)
      .values({ year: 2025, quarter: 2 })
      .returning();
    const [m] = await db
      .insert(members)
      .values({ name: "Bob", createdAt: new Date() })
      .returning();
    await db
      .insert(featureQuarters)
      .values({ featureId: f!.id, quarterId: q!.id, totalPersonMonths: 1.0 });
    const [alloc] = await db
      .insert(memberAllocations)
      .values({
        featureId: f!.id,
        quarterId: q!.id,
        memberId: m!.id,
        personMonths: 0.5,
      })
      .returning();
    expect(alloc?.personMonths).toBe(0.5);
  });
});
