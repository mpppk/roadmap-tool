import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import {
  epicLinks,
  epicMonths,
  epics,
  initiativeLinks,
  initiatives,
  memberMonthAllocations,
  members,
  months,
  quarters,
} from "./db/schema";
import { router } from "./router";

const testSchema = {
  initiatives,
  initiativeLinks,
  epics,
  epicLinks,
  members,
  quarters,
  months,
  epicMonths,
  memberMonthAllocations,
};

type TestDb = BunSQLiteDatabase<typeof testSchema>;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(`
    CREATE TABLE initiatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      CONSTRAINT initiatives_name_trimmed_check CHECK (name = trim(name)),
      CONSTRAINT initiatives_name_not_empty_check CHECK (length(name) > 0),
      CONSTRAINT initiatives_position_check CHECK (position >= 0)
    );
    CREATE UNIQUE INDEX initiatives_name_trim_unique ON initiatives (trim(name));
    CREATE UNIQUE INDEX initiatives_default_unique ON initiatives (is_default) WHERE is_default = 1;
    CREATE TABLE initiative_links (id INTEGER PRIMARY KEY AUTOINCREMENT, initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE, title TEXT NOT NULL, url TEXT NOT NULL, position INTEGER NOT NULL, CONSTRAINT initiative_links_title_not_empty_check CHECK (length(title) > 0), CONSTRAINT initiative_links_url_not_empty_check CHECK (length(url) > 0), CONSTRAINT initiative_links_position_check CHECK (position >= 0), UNIQUE(initiative_id, position), UNIQUE(initiative_id, url));
    INSERT INTO initiatives (name, position, is_default, created_at) VALUES ('未分類', 0, 1, 0);

    CREATE TABLE epics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      initiative_id INTEGER NOT NULL REFERENCES initiatives(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      CONSTRAINT epics_name_trimmed_check CHECK (name = trim(name)),
      CONSTRAINT epics_name_not_empty_check CHECK (length(name) > 0),
      CONSTRAINT epics_position_check CHECK (position >= 0)
    );
    CREATE UNIQUE INDEX epics_name_trim_unique ON epics (trim(name));
    CREATE UNIQUE INDEX epics_initiative_id_position_unique ON epics (initiative_id, position);
    CREATE TABLE epic_links (id INTEGER PRIMARY KEY AUTOINCREMENT, epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE, title TEXT NOT NULL, url TEXT NOT NULL, position INTEGER NOT NULL, CONSTRAINT epic_links_title_not_empty_check CHECK (length(title) > 0), CONSTRAINT epic_links_url_not_empty_check CHECK (length(url) > 0), CONSTRAINT epic_links_position_check CHECK (position >= 0), UNIQUE(epic_id, position), UNIQUE(epic_id, url));

    CREATE TABLE members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      max_capacity REAL,
      created_at INTEGER NOT NULL,
      CONSTRAINT members_name_trimmed_check CHECK (name = trim(name)),
      CONSTRAINT members_name_not_empty_check CHECK (length(name) > 0),
      CONSTRAINT members_max_capacity_check CHECK (max_capacity IS NULL OR (max_capacity > 0 AND max_capacity <= 1))
    );
    CREATE UNIQUE INDEX members_name_trim_unique ON members (trim(name));

    CREATE TABLE quarters (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, quarter INTEGER NOT NULL, UNIQUE(year, quarter));
    CREATE TABLE months (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, month INTEGER NOT NULL, quarter_id INTEGER NOT NULL REFERENCES quarters(id) ON DELETE CASCADE, UNIQUE(year, month), UNIQUE(quarter_id, month));
    CREATE TABLE epic_months (id INTEGER PRIMARY KEY AUTOINCREMENT, epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE, month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE, total_capacity REAL NOT NULL DEFAULT 0, UNIQUE(epic_id, month_id));
    CREATE TABLE member_month_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE, month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, capacity REAL NOT NULL DEFAULT 0, UNIQUE(epic_id, month_id, member_id));
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

async function expectBadRequest(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).toBe("BAD_REQUEST");
    return;
  }
  throw new Error("Expected BAD_REQUEST error");
}

async function createQuarterWithMonths(
  db: TestDb,
  year: number,
  quarter: number,
) {
  const [quarterRow] = await db
    .insert(quarters)
    .values({ year, quarter })
    .returning();
  const startMonth = (quarter - 1) * 3 + 1;
  const monthRows = await db
    .insert(months)
    .values(
      [0, 1, 2].map((offset) => ({
        year,
        month: startMonth + offset,
        quarterId: quarterRow!.id,
      })),
    )
    .returning();
  return {
    quarter: quarterRow!,
    months: monthRows.sort((a, b) => a.month - b.month),
  };
}

async function seedBase(db: TestDb) {
  const initiativeId = 1;
  const [epicA] = await db
    .insert(epics)
    .values({ name: "A", initiativeId, position: 0 })
    .returning();
  const [epicB] = await db
    .insert(epics)
    .values({ name: "B", initiativeId, position: 1 })
    .returning();
  const [epicC] = await db
    .insert(epics)
    .values({ name: "C", initiativeId, position: 2 })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ name: "Alice" })
    .returning();
  const q1 = await createQuarterWithMonths(db, 2026, 1);

  return {
    epicA: epicA!,
    epicB: epicB!,
    epicC: epicC!,
    member: member!,
    quarter: q1.quarter,
    month: q1.months[0]!,
  };
}

async function addAllocation(
  db: TestDb,
  {
    epicId,
    monthId,
    memberId,
    capacity,
  }: {
    epicId: number;
    monthId: number;
    memberId: number;
    capacity: number;
  },
) {
  await db
    .insert(epicMonths)
    .values({ epicId, monthId, totalCapacity: capacity });
  await db
    .insert(memberMonthAllocations)
    .values({ epicId, monthId, memberId, capacity });
}

async function getAllocation(
  db: TestDb,
  epicId: number,
  monthId: number,
  memberId: number,
) {
  const [row] = await db
    .select()
    .from(memberMonthAllocations)
    .where(
      and(
        eq(memberMonthAllocations.epicId, epicId),
        eq(memberMonthAllocations.monthId, monthId),
        eq(memberMonthAllocations.memberId, memberId),
      ),
    );
  return row;
}

async function getEpicMonth(db: TestDb, epicId: number, monthId: number) {
  const [row] = await db
    .select()
    .from(epicMonths)
    .where(and(eq(epicMonths.epicId, epicId), eq(epicMonths.monthId, monthId)));
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

  test("trims epic names before create and rename", async () => {
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    const renameEpic = router.epics.rename.callable({
      context: { db: state.db },
    });

    const created = await createEpic({ name: " Auth " });
    expect(created?.name).toBe("Auth");

    const renamed = await renameEpic({ id: created!.id, name: " Auth v2 " });
    expect(renamed?.name).toBe("Auth v2");
  });

  test("returns typed API errors for duplicate and blank epic names", async () => {
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    await createEpic({ name: "Auth" });

    await expectNameError(
      createEpic({ name: " Auth " }),
      "CONFLICT",
      "DUPLICATE_NAME",
    );
    await expectNameError(
      createEpic({ name: " " }),
      "BAD_REQUEST",
      "BLANK_NAME",
    );
  });

  test("keeps member duplicate checks separate from epic names", async () => {
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    const createMember = router.members.create.callable({
      context: { db: state.db },
    });

    await createEpic({ name: "Auth" });
    const member = await createMember({ name: " Auth " });
    expect(member?.name).toBe("Auth");

    await expectNameError(
      createMember({ name: "Auth" }),
      "CONFLICT",
      "DUPLICATE_NAME",
    );
  });
});

describe("initiatives", () => {
  let state: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    state = createTestDb();
  });

  afterEach(() => {
    state.sqlite.close();
  });

  test("creates, updates, moves, and protects initiatives", async () => {
    const listInitiatives = router.initiatives.list.callable({
      context: { db: state.db },
    });
    const createInitiative = router.initiatives.create.callable({
      context: { db: state.db },
    });
    const renameInitiative = router.initiatives.rename.callable({
      context: { db: state.db },
    });
    const moveInitiative = router.initiatives.move.callable({
      context: { db: state.db },
    });
    const deleteInitiative = router.initiatives.delete.callable({
      context: { db: state.db },
    });

    const initial = await listInitiatives({});
    expect(initial).toHaveLength(1);
    expect(initial[0]?.isDefault).toBe(true);

    const payments = await createInitiative({ name: "Payments" });
    const search = await createInitiative({ name: "Search" });
    await renameInitiative({
      id: payments!.id,
      name: "Payments v2",
      description: "Billing work",
      links: [{ title: "Spec", url: "https://example.com/spec" }],
    });
    await moveInitiative({ id: search!.id, beforeId: payments!.id });

    const moved = await listInitiatives({});
    expect(moved.map((initiative) => initiative.name)).toEqual([
      "未分類",
      "Search",
      "Payments v2",
    ]);
    expect(
      moved.find((initiative) => initiative.id === payments!.id)?.links,
    ).toHaveLength(1);

    await expectBadRequest(deleteInitiative({ id: initial[0]!.id }));
    await deleteInitiative({ id: search!.id });
    expect(
      (await listInitiatives({})).map((initiative) => initiative.name),
    ).toEqual(["未分類", "Payments v2"]);
  });

  test("moves epics between initiatives and rejects deleting non-empty initiatives", async () => {
    const createInitiative = router.initiatives.create.callable({
      context: { db: state.db },
    });
    const deleteInitiative = router.initiatives.delete.callable({
      context: { db: state.db },
    });
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    const moveEpic = router.epics.move.callable({
      context: { db: state.db },
    });

    const initiative = await createInitiative({ name: "Growth" });
    const epicA = await createEpic({ name: "A" });
    const epicB = await createEpic({ name: "B", initiativeId: initiative!.id });

    await moveEpic({
      id: epicA!.id,
      initiativeId: initiative!.id,
      beforeId: epicB!.id,
    });
    const rows = await state.db
      .select()
      .from(epics)
      .where(eq(epics.initiativeId, initiative!.id))
      .orderBy(asc(epics.position), asc(epics.id));
    expect(rows.map((row) => row.name)).toEqual(["A", "B"]);
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
    await expectBadRequest(deleteInitiative({ id: initiative!.id }));
  });
});

describe("epic metadata", () => {
  let state: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    state = createTestDb();
  });

  afterEach(() => {
    state.sqlite.close();
  });

  test("creates, lists, and updates epic metadata with ordered links", async () => {
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    const renameEpic = router.epics.rename.callable({
      context: { db: state.db },
    });
    const listEpics = router.epics.list.callable({
      context: { db: state.db },
    });

    const created = await createEpic({
      name: "Auth",
      description: " Login epic ",
      links: [
        { title: "Spec", url: "https://example.com/spec" },
        { title: "Empty", url: "" },
        { title: "Issue", url: "https://example.com/issue" },
      ],
    });

    expect(created?.description).toBe("Login epic");
    expect(created?.links.map((link) => link.title)).toEqual(["Spec", "Issue"]);

    const renamed = await renameEpic({
      id: created!.id,
      name: " Auth v2 ",
      links: [{ title: "Docs", url: "https://example.com/docs" }],
    });
    expect(renamed?.name).toBe("Auth v2");
    expect(renamed?.description).toBe("Login epic");
    expect(renamed?.links).toHaveLength(1);
    expect(renamed?.links[0]?.position).toBe(0);

    const listed = await listEpics({});
    expect(listed[0]?.links[0]?.title).toBe("Docs");
  });

  test("validates epic metadata links and length limits", async () => {
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });

    await expectBadRequest(
      createEpic({
        name: "Auth",
        links: [{ title: "Bad", url: "ftp://example.com/spec" }],
      }),
    );
    await expectBadRequest(
      createEpic({
        name: "Search",
        links: [
          { title: "A", url: "https://example.com/dup" },
          { title: "B", url: "https://example.com/dup" },
        ],
      }),
    );
    await expectBadRequest(
      createEpic({
        name: "Reports",
        description: "x".repeat(2001),
      }),
    );
    await expectBadRequest(
      createEpic({
        name: "Too many",
        links: Array.from({ length: 21 }, (_, i) => ({
          title: `Link ${i}`,
          url: `https://example.com/${i}`,
        })),
      }),
    );
  });

  test("exports and imports epic metadata csv", async () => {
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    const exportCsv = router.export.epicMetadataCSV.callable({
      context: { db: state.db },
    });
    const importCsv = router.import.epicMetadataCSVImport.callable({
      context: { db: state.db },
    });

    await createEpic({
      name: "Auth",
      description: "Old",
      links: [{ title: "Old link", url: "https://example.com/old" }],
    });

    await importCsv({
      csv: [
        "name,description,links",
        'Auth,New,"[{""title"":""Spec"",""url"":""https://example.com/spec""}]"',
        "Search,,[]",
      ].join("\n"),
    });

    const csv = await exportCsv({});
    expect(csv).toContain("Auth");
    expect(csv).toContain("New");
    expect(csv).toContain("https://example.com/spec");
    expect(csv).toContain("Search");
  });

  test("imports allocation tsv", async () => {
    const createQuarter = router.quarters.create.callable({
      context: { db: state.db },
    });
    const importTsv = router.import.tsvImport.callable({
      context: { db: state.db },
    });
    const listEpics = router.epics.list.callable({
      context: { db: state.db },
    });
    const listMembers = router.members.list.callable({
      context: { db: state.db },
    });

    await createQuarter({ year: 2026, quarter: 2 });

    const result = await importTsv({
      tsv: ["機能\t担当者\tキャパシティ\t月", "Auth\tAlice\t0.5\t2026-04"].join(
        "\n",
      ),
    });

    expect(result.success).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    const epics = await listEpics({});
    expect(epics.some((f) => f.name === "Auth")).toBe(true);

    const members = await listMembers({});
    expect(members.some((m) => m.name === "Alice")).toBe(true);
  });

  test("imports allocation tsv with epic_id and member_id for rename tracking", async () => {
    const createQuarter = router.quarters.create.callable({
      context: { db: state.db },
    });
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    const createMember = router.members.create.callable({
      context: { db: state.db },
    });
    const renameEpic = router.epics.rename.callable({
      context: { db: state.db },
    });
    const renameMember = router.members.rename.callable({
      context: { db: state.db },
    });
    const importTsv = router.import.tsvImport.callable({
      context: { db: state.db },
    });

    await createQuarter({ year: 2026, quarter: 2 });
    const epic = await createEpic({ name: "Auth" });
    const member = await createMember({ name: "Alice" });

    // Rename both before importing
    await renameEpic({ id: epic!.id, name: "Auth v2", links: [] });
    await renameMember({ id: member!.id, name: "Alice Smith" });

    // Import using old names but correct IDs — IDs should win
    const result = await importTsv({
      tsv: [
        "機能\tepic_id\t担当者\tmember_id\tキャパシティ\t月",
        `Auth\t${epic!.id}\tAlice\t${member!.id}\t0.5\t2026-04`,
      ].join("\n"),
    });

    expect(result.success).toBe(1);
    expect(result.errors).toHaveLength(0);

    const allocations = await state.db
      .select()
      .from(memberMonthAllocations)
      .all();
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.capacity).toBe(0.5);
  });

  test("imports allocation csv with epic_id and member_id for rename tracking", async () => {
    const createQuarter = router.quarters.create.callable({
      context: { db: state.db },
    });
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    const createMember = router.members.create.callable({
      context: { db: state.db },
    });
    const renameEpic = router.epics.rename.callable({
      context: { db: state.db },
    });
    const renameMember = router.members.rename.callable({
      context: { db: state.db },
    });
    const importCsv = router.import.csvImport.callable({
      context: { db: state.db },
    });

    await createQuarter({ year: 2026, quarter: 2 });
    const epic = await createEpic({ name: "Search" });
    const member = await createMember({ name: "Bob" });

    await renameEpic({ id: epic!.id, name: "Search v2", links: [] });
    await renameMember({ id: member!.id, name: "Bob Smith" });

    const result = await importCsv({
      csv: [
        "Initiative,機能,epic_id,担当者,member_id,キャパシティ,月",
        `,Search,${epic!.id},Bob,${member!.id},1,2026-04`,
      ].join("\n"),
    });

    expect(result.success).toBe(1);
    expect(result.errors).toHaveLength(0);

    const allocations = await state.db
      .select()
      .from(memberMonthAllocations)
      .all();
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.capacity).toBe(1);
  });

  test("exports allocationCSV with epic_id and member_id columns", async () => {
    const createQuarter = router.quarters.create.callable({
      context: { db: state.db },
    });
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    const createMember = router.members.create.callable({
      context: { db: state.db },
    });
    const exportCsv = router.export.allocationCSV.callable({
      context: { db: state.db },
    });
    const assignMember = router.allocations.assignMember.callable({
      context: { db: state.db },
    });

    await createQuarter({ year: 2026, quarter: 2 });
    const epic = await createEpic({ name: "Auth" });
    const member = await createMember({ name: "Alice" });
    await assignMember({ epicId: epic!.id, memberId: member!.id });

    await router.allocations.updateMemberAllocation.callable({
      context: { db: state.db },
    })({
      epicId: epic!.id,
      memberId: member!.id,
      periodType: "month",
      monthId: (await state.db.select().from(months).all())[0]!.id,
      capacity: 0.5,
    });

    const csv = await exportCsv({});
    const lines = csv.split("\n");
    const header = lines[0]!;
    expect(header).toContain("epic_id");
    expect(header).toContain("member_id");

    const dataLine = lines[1]!;
    const cols = dataLine.split(",");
    const headerCols = header.split(",");
    const epicIdCol = headerCols.indexOf("epic_id");
    const memberIdCol = headerCols.indexOf("member_id");
    expect(Number(cols[epicIdCol])).toBe(epic!.id);
    expect(Number(cols[memberIdCol])).toBe(member!.id);
  });

  test("epicMetadataCSVImport uses epic_id for rename tracking", async () => {
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    const renameEpic = router.epics.rename.callable({
      context: { db: state.db },
    });
    const importCsv = router.import.epicMetadataCSVImport.callable({
      context: { db: state.db },
    });
    const listEpics = router.epics.list.callable({
      context: { db: state.db },
    });

    const epic = await createEpic({ name: "Auth", description: "Old" });
    await renameEpic({ id: epic!.id, name: "Auth v2", links: [] });

    // Import using old name but correct epic_id — ID should win
    await importCsv({
      csv: [
        "initiative,epic_id,name,description,links",
        `,${epic!.id},Auth,New description,[]`,
      ].join("\n"),
    });

    const listed = await listEpics({});
    const updated = listed.find((f) => f.id === epic!.id);
    expect(updated?.description).toBe("New description");
    // Name should not be changed by epicMetadataCSVImport
    expect(updated?.name).toBe("Auth v2");
  });

  test("memberTSVImport append updates name and max_capacity by id", async () => {
    const createMember = router.members.create.callable({
      context: { db: state.db },
    });
    const importTsv = router.import.memberTSVImport.callable({
      context: { db: state.db },
    });
    const listMembers = router.members.list.callable({
      context: { db: state.db },
    });

    const member = await createMember({ name: "Alice" });

    const result = await importTsv({
      tsv: ["id\tname\tmax_capacity", `${member!.id}\tAlice Smith\t0.8`].join(
        "\n",
      ),
      mode: "append",
    });

    expect(result.success).toBe(1);
    expect(result.errors).toHaveLength(0);

    const listed = await listMembers({});
    const updated = listed.find((m) => m.id === member!.id);
    expect(updated?.maxCapacity).toBe(0.8);
    expect(updated?.name).toBe("Alice Smith");
  });

  test("memberTSVImport append updates same-name rows and creates new rows", async () => {
    const createMember = router.members.create.callable({
      context: { db: state.db },
    });
    const importTsv = router.import.memberTSVImport.callable({
      context: { db: state.db },
    });
    const listMembers = router.members.list.callable({
      context: { db: state.db },
    });

    const alice = await createMember({ name: "Alice" });
    const result = await importTsv({
      tsv: ["name\tmax_capacity", "Alice\t0.6", "Bob\t0.7"].join("\n"),
      mode: "append",
    });

    expect(result.success).toBe(2);
    expect(result.errors).toHaveLength(0);

    const listed = await listMembers({});
    expect(listed).toHaveLength(2);
    expect(listed.find((m) => m.id === alice!.id)?.maxCapacity).toBe(0.6);
    expect(listed.find((m) => m.name === "Bob")?.maxCapacity).toBe(0.7);
  });

  test("memberTSVImport append creates missing explicit member_id", async () => {
    const importTsv = router.import.memberTSVImport.callable({
      context: { db: state.db },
    });
    const listMembers = router.members.list.callable({
      context: { db: state.db },
    });

    const result = await importTsv({
      tsv: ["member_id\tname\tmax_capacity", "42\tCharlie\t1"].join("\n"),
      mode: "append",
    });

    expect(result.success).toBe(1);
    expect(result.errors).toHaveLength(0);
    const listed = await listMembers({});
    expect(listed.find((m) => m.id === 42)?.name).toBe("Charlie");
  });

  test("memberTSVImport sync deletes missing members and cascades allocations", async () => {
    const { epicA, member: alice, month } = await seedBase(state.db);
    const [bob] = await state.db
      .insert(members)
      .values({ name: "Bob" })
      .returning();
    await addAllocation(state.db, {
      epicId: epicA.id,
      monthId: month.id,
      memberId: alice.id,
      capacity: 0.4,
    });
    await state.db.insert(memberMonthAllocations).values({
      epicId: epicA.id,
      monthId: month.id,
      memberId: bob!.id,
      capacity: 0.2,
    });

    const importTsv = router.import.memberTSVImport.callable({
      context: { db: state.db },
    });
    const result = await importTsv({
      tsv: ["id\tname\tmax_capacity", `${alice.id}\tAlice Smith\t0.8`].join(
        "\n",
      ),
      mode: "sync",
    });

    expect(result.success).toBe(1);
    expect(result.errors).toHaveLength(0);

    const listed = await state.db.select().from(members).all();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(alice.id);
    expect(listed[0]?.name).toBe("Alice Smith");
    expect(listed[0]?.maxCapacity).toBe(0.8);

    const allocations = await state.db
      .select()
      .from(memberMonthAllocations)
      .all();
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.memberId).toBe(alice.id);
  });

  test("memberTSVImport sync does not mutate on input errors", async () => {
    const createMember = router.members.create.callable({
      context: { db: state.db },
    });
    const importTsv = router.import.memberTSVImport.callable({
      context: { db: state.db },
    });
    const listMembers = router.members.list.callable({
      context: { db: state.db },
    });

    const alice = await createMember({ name: "Alice" });
    const bob = await createMember({ name: "Bob" });

    const result = await importTsv({
      tsv: [
        "id\tname\tmax_capacity",
        `${alice!.id}\tAlice\t0.8`,
        "99\tAlice\t2",
      ].join("\n"),
      mode: "sync",
    });

    expect(result.success).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);

    const listed = await listMembers({});
    expect(listed).toHaveLength(2);
    expect(listed.find((m) => m.id === alice!.id)?.name).toBe("Alice");
    expect(listed.find((m) => m.id === bob!.id)?.name).toBe("Bob");
  });

  test("memberTSVImport sync rejects missing explicit id before deleting same-name member", async () => {
    const { epicA, member: alice, month } = await seedBase(state.db);
    await addAllocation(state.db, {
      epicId: epicA.id,
      monthId: month.id,
      memberId: alice.id,
      capacity: 0.4,
    });

    const importTsv = router.import.memberTSVImport.callable({
      context: { db: state.db },
    });
    const result = await importTsv({
      tsv: ["id\tname\tmax_capacity", "99\tAlice\t0.8"].join("\n"),
      mode: "sync",
    });

    expect(result.success).toBe(0);
    expect(result.errors).toHaveLength(1);

    const listed = await state.db.select().from(members).all();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(alice.id);
    expect(listed[0]?.name).toBe("Alice");

    const allocations = await state.db
      .select()
      .from(memberMonthAllocations)
      .all();
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.memberId).toBe(alice.id);
  });
});

describe("history snapshots", () => {
  let state: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    state = createTestDb();
  });

  afterEach(() => {
    state.sqlite.close();
  });

  test("restores deleted epics, members, quarters, links, and allocations with stable ids", async () => {
    const snapshot = router.history.snapshot.callable({
      context: { db: state.db },
    });
    const restore = router.history.restore.callable({
      context: { db: state.db },
    });
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    const deleteEpic = router.epics.delete.callable({
      context: { db: state.db },
    });
    const createMember = router.members.create.callable({
      context: { db: state.db },
    });
    const deleteMember = router.members.delete.callable({
      context: { db: state.db },
    });
    const setMaxCapacity = router.members.setMaxCapacity.callable({
      context: { db: state.db },
    });
    const createQuarter = router.quarters.create.callable({
      context: { db: state.db },
    });
    const deleteQuarter = router.quarters.delete.callable({
      context: { db: state.db },
    });
    const updateAllocation = router.allocations.updateMemberAllocation.callable(
      {
        context: { db: state.db },
      },
    );

    const epic = await createEpic({
      name: "Auth",
      description: "Login",
      links: [{ title: "Spec", url: "https://example.com/spec" }],
    });
    const member = await createMember({ name: "Alice" });
    await setMaxCapacity({ id: member!.id, maxCapacity: 0.6 });
    const quarter = await createQuarter({ year: 2026, quarter: 1 });
    await updateAllocation({
      epicId: epic!.id,
      memberId: member!.id,
      periodType: "month",
      monthId: quarter!.months[0]!.id,
      capacity: 0.4,
    });

    const before = await snapshot({});
    await deleteEpic({ id: epic!.id });
    await deleteMember({ id: member!.id });
    await deleteQuarter({ id: quarter!.id });
    const afterDelete = await snapshot({});

    await restore({ expected: afterDelete, snapshot: before });

    const restored = await snapshot({});
    expect(restored).toEqual(before);
    expect(restored.epics[0]?.id).toBe(epic!.id);
    expect(restored.epicLinks[0]?.epicId).toBe(epic!.id);
    expect(restored.members[0]?.id).toBe(member!.id);
    expect(restored.members[0]?.maxCapacity).toBe(0.6);
    expect(restored.quarters[0]?.id).toBe(quarter!.id);
    expect(restored.months).toHaveLength(3);
    expect(restored.epicMonths[0]?.totalCapacity).toBeCloseTo(0.4);
    expect(restored.memberMonthAllocations[0]?.capacity).toBeCloseTo(0.4);
  });

  test("rejects restore when current data differs from the expected snapshot", async () => {
    const snapshot = router.history.snapshot.callable({
      context: { db: state.db },
    });
    const restore = router.history.restore.callable({
      context: { db: state.db },
    });
    const createEpic = router.epics.create.callable({
      context: { db: state.db },
    });
    const createMember = router.members.create.callable({
      context: { db: state.db },
    });

    const before = await snapshot({});
    await createEpic({ name: "Auth" });
    const expected = await snapshot({});
    await createMember({ name: "Alice" });

    try {
      await restore({ expected, snapshot: before });
    } catch (error) {
      expect((error as { code?: string }).code).toBe("CONFLICT");
      expect((await snapshot({})).members).toHaveLength(1);
      return;
    }
    throw new Error("Expected CONFLICT restore error");
  });
});

describe("allocation capacity conflicts", () => {
  let sqlite: Database | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  test("previews used elsewhere and assignable monthly capacity", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { epicA, epicB, member, month } = await seedBase(db);
    await addAllocation(db, {
      epicId: epicB.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 0.7,
    });

    const preview = router.allocations.previewMemberAllocation.callable({
      context: { db },
    });
    const result = await preview({
      epicId: epicA.id,
      periodType: "month",
      monthId: month.id,
      memberId: member.id,
      capacity: 0.55,
    });

    expect(result.usedElsewhere).toBeCloseTo(0.7);
    expect(result.assignableCapacity).toBeCloseTo(0.3);
    expect(result.hasConflict).toBe(true);
  });

  test("fits direct monthly allocation within the member limit by default", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { epicA, epicB, member, month } = await seedBase(db);
    await addAllocation(db, {
      epicId: epicB.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 0.7,
    });

    const update = router.allocations.updateMemberAllocation.callable({
      context: { db },
    });
    await update({
      epicId: epicA.id,
      periodType: "month",
      monthId: month.id,
      memberId: member.id,
      capacity: 0.55,
    });

    const alloc = await getAllocation(db, epicA.id, month.id, member.id);
    const fm = await getEpicMonth(db, epicA.id, month.id);
    expect(alloc?.capacity).toBeCloseTo(0.3);
    expect(fm?.totalCapacity).toBeCloseTo(0.3);
  });

  test("allows direct monthly allocation to overflow when requested", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { epicA, epicB, member, month } = await seedBase(db);
    await addAllocation(db, {
      epicId: epicB.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 0.7,
    });

    const update = router.allocations.updateMemberAllocation.callable({
      context: { db },
    });
    await update({
      epicId: epicA.id,
      periodType: "month",
      monthId: month.id,
      memberId: member.id,
      capacity: 0.55,
      capacityConflictResolution: "allowOverflow",
    });

    const alloc = await getAllocation(db, epicA.id, month.id, member.id);
    expect(alloc?.capacity).toBeCloseTo(0.55);
  });

  test("rebalances other monthly epic allocations proportionally", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { epicA, epicB, epicC, member, month } = await seedBase(db);
    await addAllocation(db, {
      epicId: epicB.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 0.4,
    });
    await addAllocation(db, {
      epicId: epicC.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 0.3,
    });

    const update = router.allocations.updateMemberAllocation.callable({
      context: { db },
    });
    const result = await update({
      epicId: epicA.id,
      periodType: "month",
      monthId: month.id,
      memberId: member.id,
      capacity: 0.55,
      capacityConflictResolution: "rebalanceOthersProportionally",
    });

    const allocA = await getAllocation(db, epicA.id, month.id, member.id);
    const allocB = await getAllocation(db, epicB.id, month.id, member.id);
    const allocC = await getAllocation(db, epicC.id, month.id, member.id);
    expect(allocA?.capacity).toBeCloseTo(0.55);
    expect(allocB?.capacity).toBeCloseTo(0.257143);
    expect(allocC?.capacity).toBeCloseTo(0.192857);
    expect(
      (allocA?.capacity ?? 0) +
        (allocB?.capacity ?? 0) +
        (allocC?.capacity ?? 0),
    ).toBeCloseTo(1);
    expect(result.updatedEpics.map((f) => f.epicId).sort()).toEqual([
      epicA.id,
      epicB.id,
      epicC.id,
    ]);
  });

  test("keeps zero allocations when proportional rebalance removes other monthly capacity", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { epicA, epicB, epicC, member, month } = await seedBase(db);
    await addAllocation(db, {
      epicId: epicB.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 0.4,
    });
    await addAllocation(db, {
      epicId: epicC.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 0.3,
    });

    const update = router.allocations.updateMemberAllocation.callable({
      context: { db },
    });
    await update({
      epicId: epicA.id,
      periodType: "month",
      monthId: month.id,
      memberId: member.id,
      capacity: 1,
      capacityConflictResolution: "rebalanceOthersProportionally",
    });

    const allocB = await getAllocation(db, epicB.id, month.id, member.id);
    const allocC = await getAllocation(db, epicC.id, month.id, member.id);
    const fmB = await getEpicMonth(db, epicB.id, month.id);
    const fmC = await getEpicMonth(db, epicC.id, month.id);
    expect(allocB).toBeDefined();
    expect(allocC).toBeDefined();
    expect(allocB?.capacity).toBe(0);
    expect(allocC?.capacity).toBe(0);
    expect(fmB?.totalCapacity).toBe(0);
    expect(fmC?.totalCapacity).toBe(0);
  });

  test("rebalances all allocations proportionally including new one", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { epicA, epicB, member, month } = await seedBase(db);
    await addAllocation(db, {
      epicId: epicB.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 1,
    });

    const update = router.allocations.updateMemberAllocation.callable({
      context: { db },
    });
    const result = await update({
      epicId: epicA.id,
      periodType: "month",
      monthId: month.id,
      memberId: member.id,
      capacity: 1,
      capacityConflictResolution: "rebalanceAllProportionally",
    });

    const allocA = await getAllocation(db, epicA.id, month.id, member.id);
    const allocB = await getAllocation(db, epicB.id, month.id, member.id);
    expect(allocA?.capacity).toBeCloseTo(0.5);
    expect(allocB?.capacity).toBeCloseTo(0.5);
    expect((allocA?.capacity ?? 0) + (allocB?.capacity ?? 0)).toBeCloseTo(1);
    expect(result.updatedEpics.map((f) => f.epicId).sort()).toEqual([
      epicA.id,
      epicB.id,
    ]);
  });

  test("rebalances all allocations proportionally with multiple epics", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { epicA, epicB, epicC, member, month } = await seedBase(db);
    await addAllocation(db, {
      epicId: epicB.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 0.4,
    });
    await addAllocation(db, {
      epicId: epicC.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 0.3,
    });

    const update = router.allocations.updateMemberAllocation.callable({
      context: { db },
    });
    await update({
      epicId: epicA.id,
      periodType: "month",
      monthId: month.id,
      memberId: member.id,
      capacity: 0.5,
      capacityConflictResolution: "rebalanceAllProportionally",
    });

    // total requested = 0.5 + 0.4 + 0.3 = 1.2, scale = 1/1.2 ≈ 0.8333
    const allocA = await getAllocation(db, epicA.id, month.id, member.id);
    const allocB = await getAllocation(db, epicB.id, month.id, member.id);
    const allocC = await getAllocation(db, epicC.id, month.id, member.id);
    expect(allocA?.capacity).toBeCloseTo(0.5 * (1 / 1.2));
    expect(allocB?.capacity).toBeCloseTo(0.4 * (1 / 1.2));
    expect(allocC?.capacity).toBeCloseTo(0.3 * (1 / 1.2));
    expect(
      (allocA?.capacity ?? 0) +
        (allocB?.capacity ?? 0) +
        (allocC?.capacity ?? 0),
    ).toBeCloseTo(1);
  });
});

describe("allocation cap preserving operations", () => {
  let sqlite: Database | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  test("keeps updateTotal assigned capacity within the member monthly limit", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { epicA, epicB, member, month } = await seedBase(db);
    await addAllocation(db, {
      epicId: epicA.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 1,
    });
    await addAllocation(db, {
      epicId: epicB.id,
      monthId: month.id,
      memberId: member.id,
      capacity: 0.5,
    });

    const updateTotal = router.allocations.updateTotal.callable({
      context: { db },
    });
    const result = await updateTotal({
      epicId: epicA.id,
      periodType: "month",
      monthId: month.id,
      totalCapacity: 2,
    });

    const allocA = await getAllocation(db, epicA.id, month.id, member.id);
    expect(allocA?.capacity).toBeCloseTo(0.5);
    expect(result.months[0]?.totalCapacity).toBe(2);
    expect(result.months[0]?.unassignedCapacity).toBeCloseTo(1.5);
  });

  test("keeps moveQuarter assigned capacity within the destination member monthly limit", async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    const { epicA, epicB, member } = await seedBase(db);
    const fromQuarter = await createQuarterWithMonths(db, 2026, 2);
    const toQuarter = await createQuarterWithMonths(db, 2026, 3);
    const fromMonth = fromQuarter.months[0]!;
    const toMonth = toQuarter.months[0]!;
    await addAllocation(db, {
      epicId: epicA.id,
      monthId: fromMonth.id,
      memberId: member.id,
      capacity: 0.8,
    });
    await addAllocation(db, {
      epicId: epicB.id,
      monthId: toMonth.id,
      memberId: member.id,
      capacity: 0.7,
    });

    const moveQuarter = router.allocations.moveQuarter.callable({
      context: { db },
    });
    await moveQuarter({
      epicId: epicA.id,
      fromQuarterId: fromQuarter.quarter.id,
      toQuarterId: toQuarter.quarter.id,
    });

    const allocA = await getAllocation(db, epicA.id, toMonth.id, member.id);
    const fmA = await getEpicMonth(db, epicA.id, toMonth.id);
    expect(allocA?.capacity).toBeCloseTo(0.3);
    expect(fmA?.totalCapacity).toBeCloseTo(0.8);
  });
});
