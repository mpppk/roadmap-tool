import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  featureQuarters,
  features,
  memberAllocations,
  members,
  quarters,
} from "./db/schema";
import { router } from "./router";

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

async function expectNameError(
  promise: Promise<unknown>,
  code: "CONFLICT" | "BAD_REQUEST",
  dataCode: "DUPLICATE_NAME" | "BLANK_NAME",
) {
  try {
    await promise;
  } catch (error) {
    const record = error as {
      code?: string;
      data?: { code?: string };
      message?: string;
    };
    expect(record.code).toBe(code);
    expect(record.data?.code).toBe(dataCode);
    expect(typeof record.message).toBe("string");
    return;
  }
  throw new Error(`Expected ${code} name error`);
}

describe("router name validation", () => {
  let state: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    state = createTestDb();
  });

  afterEach(() => {
    state.sqlite.close();
  });

  test("trims feature names before create and rename", async () => {
    const createFeature = router.features.create.callable({
      context: { db: state.db },
    });
    const renameFeature = router.features.rename.callable({
      context: { db: state.db },
    });

    const created = await createFeature({ name: " Auth " });
    expect(created?.name).toBe("Auth");

    const renamed = await renameFeature({ id: created!.id, name: " Auth v2 " });
    expect(renamed?.name).toBe("Auth v2");
  });

  test("returns typed API errors for duplicate and blank feature names", async () => {
    const createFeature = router.features.create.callable({
      context: { db: state.db },
    });
    await createFeature({ name: "Auth" });

    await expectNameError(
      createFeature({ name: " Auth " }),
      "CONFLICT",
      "DUPLICATE_NAME",
    );
    await expectNameError(
      createFeature({ name: " " }),
      "BAD_REQUEST",
      "BLANK_NAME",
    );
  });

  test("keeps member duplicate checks separate from feature names", async () => {
    const createFeature = router.features.create.callable({
      context: { db: state.db },
    });
    const createMember = router.members.create.callable({
      context: { db: state.db },
    });

    await createFeature({ name: "Auth" });
    const member = await createMember({ name: " Auth " });
    expect(member?.name).toBe("Auth");

    await expectNameError(
      createMember({ name: "Auth" }),
      "CONFLICT",
      "DUPLICATE_NAME",
    );
  });
});
