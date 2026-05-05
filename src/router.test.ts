import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import {
  featureQuarters,
  features,
  memberAllocations,
  members,
  quarters,
} from "./db/schema";
import { router } from "./router";

const testSchema = {
  features,
  members,
  quarters,
  featureQuarters,
  memberAllocations,
};

type TestDb = BunSQLiteDatabase<typeof testSchema>;

function createTestDb() {
  const sqlite = new Database(":memory:");
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
  return {
    sqlite,
    db: drizzle(sqlite, { schema: testSchema }),
  };
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

async function seedBase(db: TestDb) {
  const [featureA] = await db
    .insert(features)
    .values({ name: "A" })
    .returning();
  const [featureB] = await db
    .insert(features)
    .values({ name: "B" })
    .returning();
  const [featureC] = await db
    .insert(features)
    .values({ name: "C" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ name: "Alice" })
    .returning();
  const [quarter] = await db
    .insert(quarters)
    .values({ year: 2026, quarter: 1 })
    .returning();

  return {
    featureA: featureA!,
    featureB: featureB!,
    featureC: featureC!,
    member: member!,
    quarter: quarter!,
  };
}

async function addAllocation(
  db: TestDb,
  {
    featureId,
    quarterId,
    memberId,
    capacity,
  }: {
    featureId: number;
    quarterId: number;
    memberId: number;
    capacity: number;
  },
) {
  await db
    .insert(featureQuarters)
    .values({ featureId, quarterId, totalCapacity: capacity });
  await db
    .insert(memberAllocations)
    .values({ featureId, quarterId, memberId, capacity });
}

async function getAllocation(
  db: TestDb,
  featureId: number,
  quarterId: number,
  memberId: number,
) {
  const [row] = await db
    .select()
    .from(memberAllocations)
    .where(
      and(
        eq(memberAllocations.featureId, featureId),
        eq(memberAllocations.quarterId, quarterId),
        eq(memberAllocations.memberId, memberId),
      ),
    );
  return row;
}

async function getFeatureQuarter(
  db: TestDb,
  featureId: number,
  quarterId: number,
) {
  const [row] = await db
    .select()
    .from(featureQuarters)
    .where(
      and(
        eq(featureQuarters.featureId, featureId),
        eq(featureQuarters.quarterId, quarterId),
      ),
    );
  return row;
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

describe("allocation capacity conflicts", () => {
  let sqlite: Database | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  test("previews used elsewhere and assignable capacity", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { featureA, featureB, member, quarter } = await seedBase(db);
    await addAllocation(db, {
      featureId: featureB.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 0.7,
    });

    const preview = router.allocations.previewMemberAllocation.callable({
      context: { db },
    });
    const result = await preview({
      featureId: featureA.id,
      quarterId: quarter.id,
      memberId: member.id,
    });

    expect(result.usedElsewhere).toBeCloseTo(0.7);
    expect(result.assignableCapacity).toBeCloseTo(0.3);
  });

  test("fits direct allocation within the member limit by default", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { featureA, featureB, member, quarter } = await seedBase(db);
    await addAllocation(db, {
      featureId: featureB.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 0.7,
    });

    const update = router.allocations.updateMemberAllocation.callable({
      context: { db },
    });
    await update({
      featureId: featureA.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 0.55,
    });

    const alloc = await getAllocation(db, featureA.id, quarter.id, member.id);
    const fq = await getFeatureQuarter(db, featureA.id, quarter.id);
    expect(alloc?.capacity).toBeCloseTo(0.3);
    expect(fq?.totalCapacity).toBeCloseTo(0.3);
  });

  test("allows direct allocation to overflow when requested", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { featureA, featureB, member, quarter } = await seedBase(db);
    await addAllocation(db, {
      featureId: featureB.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 0.7,
    });

    const update = router.allocations.updateMemberAllocation.callable({
      context: { db },
    });
    await update({
      featureId: featureA.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 0.55,
      capacityConflictResolution: "allowOverflow",
    });

    const alloc = await getAllocation(db, featureA.id, quarter.id, member.id);
    expect(alloc?.capacity).toBeCloseTo(0.55);
  });

  test("rebalances other features proportionally", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { featureA, featureB, featureC, member, quarter } =
      await seedBase(db);
    await addAllocation(db, {
      featureId: featureB.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 0.4,
    });
    await addAllocation(db, {
      featureId: featureC.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 0.3,
    });

    const update = router.allocations.updateMemberAllocation.callable({
      context: { db },
    });
    const result = await update({
      featureId: featureA.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 0.55,
      capacityConflictResolution: "rebalanceOthersProportionally",
    });

    const allocA = await getAllocation(db, featureA.id, quarter.id, member.id);
    const allocB = await getAllocation(db, featureB.id, quarter.id, member.id);
    const allocC = await getAllocation(db, featureC.id, quarter.id, member.id);
    expect(allocA?.capacity).toBeCloseTo(0.55);
    expect(allocB?.capacity).toBeCloseTo(0.257143);
    expect(allocC?.capacity).toBeCloseTo(0.192857);
    expect(
      (allocA?.capacity ?? 0) +
        (allocB?.capacity ?? 0) +
        (allocC?.capacity ?? 0),
    ).toBeCloseTo(1);
    expect(result.updatedQuarters.map((q) => q.featureId).sort()).toEqual([
      featureA.id,
      featureB.id,
      featureC.id,
    ]);
  });

  test("keeps zero allocations when proportional rebalance removes other capacity", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { featureA, featureB, featureC, member, quarter } =
      await seedBase(db);
    await addAllocation(db, {
      featureId: featureB.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 0.4,
    });
    await addAllocation(db, {
      featureId: featureC.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 0.3,
    });

    const update = router.allocations.updateMemberAllocation.callable({
      context: { db },
    });
    await update({
      featureId: featureA.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 1,
      capacityConflictResolution: "rebalanceOthersProportionally",
    });

    const allocB = await getAllocation(db, featureB.id, quarter.id, member.id);
    const allocC = await getAllocation(db, featureC.id, quarter.id, member.id);
    const fqB = await getFeatureQuarter(db, featureB.id, quarter.id);
    const fqC = await getFeatureQuarter(db, featureC.id, quarter.id);
    expect(allocB).toBeDefined();
    expect(allocC).toBeDefined();
    expect(allocB?.capacity).toBe(0);
    expect(allocC?.capacity).toBe(0);
    expect(fqB?.totalCapacity).toBe(0);
    expect(fqC?.totalCapacity).toBe(0);
  });
});

describe("allocation cap preserving operations", () => {
  let sqlite: Database | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  test("keeps updateTotal assigned capacity within the member limit", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { featureA, featureB, member, quarter } = await seedBase(db);
    await addAllocation(db, {
      featureId: featureA.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 1,
    });
    await addAllocation(db, {
      featureId: featureB.id,
      quarterId: quarter.id,
      memberId: member.id,
      capacity: 0.5,
    });

    const updateTotal = router.allocations.updateTotal.callable({
      context: { db },
    });
    const result = await updateTotal({
      featureId: featureA.id,
      quarterId: quarter.id,
      totalCapacity: 2,
    });

    const allocA = await getAllocation(db, featureA.id, quarter.id, member.id);
    expect(allocA?.capacity).toBeCloseTo(0.5);
    expect(result.totalCapacity).toBe(2);
    expect(result.unassignedCapacity).toBeCloseTo(1.5);
  });

  test("keeps moveQuarter assigned capacity within the destination member limit", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { featureA, featureB, member } = await seedBase(db);
    const [fromQuarter] = await db
      .insert(quarters)
      .values({ year: 2026, quarter: 2 })
      .returning();
    const [toQuarter] = await db
      .insert(quarters)
      .values({ year: 2026, quarter: 3 })
      .returning();
    await addAllocation(db, {
      featureId: featureA.id,
      quarterId: fromQuarter!.id,
      memberId: member.id,
      capacity: 0.8,
    });
    await addAllocation(db, {
      featureId: featureB.id,
      quarterId: toQuarter!.id,
      memberId: member.id,
      capacity: 0.7,
    });

    const moveQuarter = router.allocations.moveQuarter.callable({
      context: { db },
    });
    await moveQuarter({
      featureId: featureA.id,
      fromQuarterId: fromQuarter!.id,
      toQuarterId: toQuarter!.id,
    });

    const allocA = await getAllocation(
      db,
      featureA.id,
      toQuarter!.id,
      member.id,
    );
    const fqA = await getFeatureQuarter(db, featureA.id, toQuarter!.id);
    expect(allocA?.capacity).toBeCloseTo(0.3);
    expect(fqA?.totalCapacity).toBeCloseTo(0.8);
  });
});
