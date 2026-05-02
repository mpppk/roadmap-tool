import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { items, roadmaps } from "./schema";

describe("DB schema", () => {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema: { roadmaps, items } });

  beforeAll(() => {
    migrate(db, { migrationsFolder: "./drizzle" });
  });

  afterAll(() => {
    sqlite.close();
  });

  test("can insert and query a roadmap", async () => {
    const [inserted] = await db
      .insert(roadmaps)
      .values({ title: "Q3 Roadmap", description: "Goals for Q3" })
      .returning();
    expect(inserted?.title).toBe("Q3 Roadmap");
    expect(inserted?.description).toBe("Goals for Q3");
  });

  test("can insert an item linked to a roadmap", async () => {
    const [roadmap] = await db
      .insert(roadmaps)
      .values({ title: "Test Roadmap" })
      .returning();
    const [item] = await db
      .insert(items)
      .values({ roadmapId: roadmap!.id, title: "First milestone" })
      .returning();
    expect(item?.roadmapId).toBe(roadmap!.id);
    expect(item?.status).toBe("planned");
  });
});
