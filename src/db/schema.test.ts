import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  featureMonths,
  features,
  memberMonthAllocations,
  members,
  months,
  quarters,
} from "./schema";

describe("DB schema", () => {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, {
    schema: {
      features,
      members,
      quarters,
      months,
      featureMonths,
      memberMonthAllocations,
    },
  });

  beforeAll(() => {
    sqlite.exec(`
      CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE quarters (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, quarter INTEGER NOT NULL, UNIQUE(year, quarter));
      CREATE TABLE months (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, month INTEGER NOT NULL, quarter_id INTEGER NOT NULL REFERENCES quarters(id) ON DELETE CASCADE, UNIQUE(year, month), UNIQUE(quarter_id, month));
      CREATE TABLE feature_months (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE, month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE, total_capacity REAL NOT NULL DEFAULT 0, UNIQUE(feature_id, month_id));
      CREATE TABLE member_month_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE, month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, capacity REAL NOT NULL DEFAULT 0, UNIQUE(feature_id, month_id, member_id));
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

  test("can insert month and feature_month allocation", async () => {
    const [f] = await db
      .insert(features)
      .values({ name: "Dashboard", createdAt: new Date() })
      .returning();
    const [q] = await db
      .insert(quarters)
      .values({ year: 2025, quarter: 1 })
      .returning();
    const [month] = await db
      .insert(months)
      .values({ year: 2025, month: 1, quarterId: q!.id })
      .returning();
    const [fm] = await db
      .insert(featureMonths)
      .values({ featureId: f!.id, monthId: month!.id, totalCapacity: 2.0 })
      .returning();
    expect(fm?.totalCapacity).toBe(2.0);
  });

  test("can insert member month allocation", async () => {
    const [f] = await db
      .insert(features)
      .values({ name: "Search", createdAt: new Date() })
      .returning();
    const [q] = await db
      .insert(quarters)
      .values({ year: 2025, quarter: 2 })
      .returning();
    const [month] = await db
      .insert(months)
      .values({ year: 2025, month: 4, quarterId: q!.id })
      .returning();
    const [m] = await db
      .insert(members)
      .values({ name: "Bob", createdAt: new Date() })
      .returning();
    await db
      .insert(featureMonths)
      .values({ featureId: f!.id, monthId: month!.id, totalCapacity: 1.0 });
    const [alloc] = await db
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
});
