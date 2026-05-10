import { ORPCError, os } from "@orpc/server";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import * as z from "zod";
import type { db as DbType } from "./db/index";
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
import {
  NAME_ERROR_MESSAGES,
  type NameErrorCode,
  type NameResource,
  trimSqliteSpaces,
} from "./name-errors";

type Context = { db: typeof DbType };
const o = os.$context<Context>();
const capacityConflictResolutionSchema = z.enum([
  "fitWithinLimit",
  "allowOverflow",
  "rebalanceOthersProportionally",
  "rebalanceAllProportionally",
]);

const snapshotInitiativeSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  position: z.number().int(),
  isDefault: z.boolean(),
});
const snapshotEpicSchema = z.object({
  id: z.number().int(),
  initiativeId: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  position: z.number().int(),
  createdAt: z.number().int(),
});
const snapshotEpicLinkSchema = z.object({
  id: z.number().int(),
  epicId: z.number().int(),
  title: z.string(),
  url: z.string(),
  position: z.number().int(),
});
const snapshotMemberSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  maxCapacity: z.number().nullable(),
  createdAt: z.number().int(),
});
const snapshotQuarterSchema = z.object({
  id: z.number().int(),
  year: z.number().int(),
  quarter: z.number().int(),
});
const snapshotMonthSchema = z.object({
  id: z.number().int(),
  year: z.number().int(),
  month: z.number().int(),
  quarterId: z.number().int(),
});
const snapshotEpicMonthSchema = z.object({
  id: z.number().int(),
  epicId: z.number().int(),
  monthId: z.number().int(),
  totalCapacity: z.number(),
});
const snapshotMemberMonthAllocationSchema = z.object({
  id: z.number().int(),
  epicId: z.number().int(),
  monthId: z.number().int(),
  memberId: z.number().int(),
  capacity: z.number(),
});
const roadmapSnapshotSchema = z.object({
  initiatives: z.array(snapshotInitiativeSchema),
  epics: z.array(snapshotEpicSchema),
  epicLinks: z.array(snapshotEpicLinkSchema),
  members: z.array(snapshotMemberSchema),
  quarters: z.array(snapshotQuarterSchema),
  months: z.array(snapshotMonthSchema),
  epicMonths: z.array(snapshotEpicMonthSchema),
  memberMonthAllocations: z.array(snapshotMemberMonthAllocationSchema),
});

type RoadmapSnapshot = z.infer<typeof roadmapSnapshotSchema>;

const DESCRIPTION_MAX_LENGTH = 2000;
const FEATURE_LINK_TITLE_MAX_LENGTH = 100;
const FEATURE_LINK_URL_MAX_LENGTH = 2048;
const FEATURE_LINK_MAX_COUNT = 20;

const featureLinkInputSchema = z.object({
  title: z.string(),
  url: z.string(),
});

type NormalizedFeatureLinkInput = {
  title: string;
  url: string;
  position: number;
};

type EpicRowRecord = typeof epics.$inferSelect;
type InitiativeRowRecord = typeof initiatives.$inferSelect;

type SQLiteConstraintError = {
  code?: string;
  message?: string;
};

function normalizeNameInput(name: string, resource: NameResource): string {
  const normalized = trimSqliteSpaces(name);
  if (normalized.length === 0) throwNameError(resource, "BLANK_NAME");
  return normalized;
}

function throwFeatureMetadataError(message: string): never {
  throw new ORPCError("BAD_REQUEST", { message });
}

function normalizeFeatureDescriptionInput(
  description: string | null | undefined,
): string | null | undefined {
  if (description === undefined) return undefined;
  if (description === null) return null;
  const normalized = description.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > DESCRIPTION_MAX_LENGTH) {
    throwFeatureMetadataError(
      `説明は${DESCRIPTION_MAX_LENGTH}文字以内で入力してください。`,
    );
  }
  return normalized;
}

function normalizeFeatureLinksInput(
  links: Array<{ title: string; url: string }> | undefined,
): NormalizedFeatureLinkInput[] | undefined {
  if (links === undefined) return undefined;

  const normalizedLinks: NormalizedFeatureLinkInput[] = [];
  const seenUrls = new Set<string>();

  for (const link of links) {
    const title = link.title.trim();
    const url = link.url.trim();
    if (title.length === 0 || url.length === 0) continue;
    if (title.length > FEATURE_LINK_TITLE_MAX_LENGTH) {
      throwFeatureMetadataError(
        `リンク名は${FEATURE_LINK_TITLE_MAX_LENGTH}文字以内で入力してください。`,
      );
    }
    if (url.length > FEATURE_LINK_URL_MAX_LENGTH) {
      throwFeatureMetadataError(
        `リンクURLは${FEATURE_LINK_URL_MAX_LENGTH}文字以内で入力してください。`,
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throwFeatureMetadataError(
        "リンクURLは http:// または https:// で始まるURLを入力してください。",
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throwFeatureMetadataError(
        "リンクURLは http:// または https:// で始まるURLを入力してください。",
      );
    }
    if (seenUrls.has(url)) {
      throwFeatureMetadataError(
        "同じURLのリンクは1つのEpicに複数登録できません。",
      );
    }
    seenUrls.add(url);
    normalizedLinks.push({
      title,
      url,
      position: normalizedLinks.length,
    });
  }

  if (normalizedLinks.length > FEATURE_LINK_MAX_COUNT) {
    throwFeatureMetadataError(
      `リンクは1つのEpicにつき${FEATURE_LINK_MAX_COUNT}件まで登録できます。`,
    );
  }

  return normalizedLinks;
}

function throwNameError(resource: NameResource, code: NameErrorCode): never {
  const message =
    code === "BLANK_NAME"
      ? NAME_ERROR_MESSAGES.blank
      : NAME_ERROR_MESSAGES[resource];
  throw new ORPCError(code === "BLANK_NAME" ? "BAD_REQUEST" : "CONFLICT", {
    message,
    data: { code, resource },
  });
}

function asSQLiteConstraintError(error: unknown): SQLiteConstraintError | null {
  return error !== null && typeof error === "object"
    ? (error as SQLiteConstraintError)
    : null;
}

function rethrowNameMutationError(
  resource: NameResource,
  error: unknown,
): never {
  const sqliteError = asSQLiteConstraintError(error);
  const message = sqliteError?.message ?? "";
  const tableName =
    resource === "epic"
      ? "epics"
      : resource === "member"
        ? "members"
        : "initiatives";
  if (
    sqliteError?.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    (message.includes(`${tableName}.name`) ||
      message.includes(`${tableName}_name_trim_unique`))
  ) {
    throwNameError(resource, "DUPLICATE_NAME");
  }

  if (
    sqliteError?.code === "SQLITE_CONSTRAINT_CHECK" &&
    message.includes(`${tableName}_name_not_empty_check`)
  ) {
    throwNameError(resource, "BLANK_NAME");
  }

  throw error;
}

async function assertEpicNameAvailable(
  db: typeof DbType,
  name: string,
  excludeId?: number,
): Promise<void> {
  const where =
    excludeId === undefined
      ? sql`trim(${epics.name}) = ${name}`
      : and(sql`trim(${epics.name}) = ${name}`, ne(epics.id, excludeId));
  const existing = await db.select({ id: epics.id }).from(epics).where(where);
  if (existing.length > 0) throwNameError("epic", "DUPLICATE_NAME");
}

async function assertMemberNameAvailable(
  db: typeof DbType,
  name: string,
  excludeId?: number,
): Promise<void> {
  const where =
    excludeId === undefined
      ? sql`trim(${members.name}) = ${name}`
      : and(sql`trim(${members.name}) = ${name}`, ne(members.id, excludeId));
  const existing = await db
    .select({ id: members.id })
    .from(members)
    .where(where);
  if (existing.length > 0) throwNameError("member", "DUPLICATE_NAME");
}

async function assertInitiativeNameAvailable(
  db: typeof DbType,
  name: string,
  excludeId?: number,
): Promise<void> {
  const where =
    excludeId === undefined
      ? sql`trim(${initiatives.name}) = ${name}`
      : and(
          sql`trim(${initiatives.name}) = ${name}`,
          ne(initiatives.id, excludeId),
        );
  const existing = await db
    .select({ id: initiatives.id })
    .from(initiatives)
    .where(where);
  if (existing.length > 0) throwNameError("initiative", "DUPLICATE_NAME");
}

async function getInitiativeLinks(db: typeof DbType, initiativeId: number) {
  return db
    .select()
    .from(initiativeLinks)
    .where(eq(initiativeLinks.initiativeId, initiativeId))
    .orderBy(asc(initiativeLinks.position), asc(initiativeLinks.id));
}

async function getEpicLinks(db: typeof DbType, epicId: number) {
  return db
    .select()
    .from(epicLinks)
    .where(eq(epicLinks.epicId, epicId))
    .orderBy(asc(epicLinks.position), asc(epicLinks.id));
}

async function buildInitiativeDto(
  db: typeof DbType,
  initiative: InitiativeRowRecord,
) {
  return {
    ...initiative,
    links: await getInitiativeLinks(db, initiative.id),
  };
}

async function buildEpicDto(db: typeof DbType, epic: EpicRowRecord) {
  return {
    ...epic,
    links: await getEpicLinks(db, epic.id),
  };
}

async function saveInitiativeLinks(
  db: typeof DbType,
  initiativeId: number,
  links: NormalizedFeatureLinkInput[],
) {
  await db
    .delete(initiativeLinks)
    .where(eq(initiativeLinks.initiativeId, initiativeId));
  if (links.length === 0) return;
  await db.insert(initiativeLinks).values(
    links.map((link) => ({
      initiativeId,
      title: link.title,
      url: link.url,
      position: link.position,
    })),
  );
}

async function saveEpicLinks(
  db: typeof DbType,
  epicId: number,
  links: NormalizedFeatureLinkInput[],
) {
  await db.delete(epicLinks).where(eq(epicLinks.epicId, epicId));
  if (links.length === 0) return;
  await db.insert(epicLinks).values(
    links.map((link) => ({
      epicId,
      title: link.title,
      url: link.url,
      position: link.position,
    })),
  );
}

async function getDefaultInitiativeId(db: typeof DbType): Promise<number> {
  const [defaultInitiative] = await db
    .select({ id: initiatives.id })
    .from(initiatives)
    .where(eq(initiatives.isDefault, true));
  if (defaultInitiative) return defaultInitiative.id;

  const [fallback] = await db
    .select({ id: initiatives.id })
    .from(initiatives)
    .orderBy(asc(initiatives.position), asc(initiatives.id))
    .limit(1);
  if (fallback) return fallback.id;

  const [created] = await db
    .insert(initiatives)
    .values({ name: "未分類", position: 0, isDefault: true })
    .returning();
  if (!created) throw new Error("Failed to create default Initiative");
  return created.id;
}

async function getOrCreateInitiativeByName(
  db: typeof DbType,
  name: string | null | undefined,
): Promise<number> {
  const normalized =
    name === undefined || name === null || name.trim().length === 0
      ? null
      : normalizeNameInput(name, "initiative");
  if (normalized === null) return getDefaultInitiativeId(db);

  const [existing] = await db
    .select({ id: initiatives.id })
    .from(initiatives)
    .where(sql`trim(${initiatives.name}) = ${normalized}`);
  if (existing) return existing.id;

  const [last] = await db
    .select({ position: initiatives.position })
    .from(initiatives)
    .orderBy(sql`${initiatives.position} DESC`, sql`${initiatives.id} DESC`)
    .limit(1);
  const [created] = await db
    .insert(initiatives)
    .values({
      name: normalized,
      position: (last?.position ?? -1) + 1,
      isDefault: false,
    })
    .returning();
  if (!created) throw new Error(`Failed to create Initiative: ${normalized}`);
  return created.id;
}

async function nextEpicPosition(
  db: typeof DbType,
  initiativeId: number,
): Promise<number> {
  const [last] = await db
    .select({ position: epics.position })
    .from(epics)
    .where(eq(epics.initiativeId, initiativeId))
    .orderBy(sql`${epics.position} DESC`, sql`${epics.id} DESC`)
    .limit(1);
  return (last?.position ?? -1) + 1;
}

type PeriodTarget = {
  periodType: "month" | "quarter";
  monthId?: number;
  quarterId?: number;
};

type MonthAllocationResult = {
  monthId: number;
  totalCapacity: number;
  unassignedCapacity: number;
  memberAllocations: Array<{ memberId: number; capacity: number }>;
};

const periodInput = {
  periodType: z.enum(["month", "quarter"]),
  monthId: z.number().int().optional(),
  quarterId: z.number().int().optional(),
};

function monthsInQuarter(quarter: number): number[] {
  const startMonth = (quarter - 1) * 3 + 1;
  return [startMonth, startMonth + 1, startMonth + 2];
}

function monthLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

async function getQuarterMonthRows(db: typeof DbType, quarterId: number) {
  return db
    .select()
    .from(months)
    .where(eq(months.quarterId, quarterId))
    .orderBy(months.year, months.month)
    .all();
}

async function getTargetMonthRows(db: typeof DbType, target: PeriodTarget) {
  if (target.periodType === "month") {
    if (!target.monthId) throw new Error("monthId is required");
    const [month] = await db
      .select()
      .from(months)
      .where(eq(months.id, target.monthId));
    if (!month) throw new Error("Month not found");
    return [month];
  }

  if (!target.quarterId) throw new Error("quarterId is required");
  const monthRows = await getQuarterMonthRows(db, target.quarterId);
  if (monthRows.length === 0) throw new Error("Quarter has no months");
  return monthRows;
}

async function getQuarterRowsWithMonths(db: typeof DbType) {
  const allQuarters = await db
    .select()
    .from(quarters)
    .orderBy(quarters.year, quarters.quarter)
    .all();
  const allMonths = await db
    .select()
    .from(months)
    .orderBy(months.year, months.month)
    .all();

  return allQuarters.map((q) => ({
    ...q,
    months: allMonths.filter((m) => m.quarterId === q.id),
  }));
}

async function getMemberMaxCapacity(
  db: typeof DbType,
  memberId: number,
): Promise<number> {
  const [row] = await db
    .select({ maxCapacity: members.maxCapacity })
    .from(members)
    .where(eq(members.id, memberId));
  return row?.maxCapacity ?? 1.0;
}

async function getMemberUsageInMonth(
  db: typeof DbType,
  memberId: number,
  monthId: number,
  excludeEpicId: number,
): Promise<number> {
  const rows = await db
    .select({
      total: sql<number>`coalesce(sum(${memberMonthAllocations.capacity}), 0)`,
    })
    .from(memberMonthAllocations)
    .where(
      and(
        eq(memberMonthAllocations.memberId, memberId),
        eq(memberMonthAllocations.monthId, monthId),
        ne(memberMonthAllocations.epicId, excludeEpicId),
      ),
    );
  return rows[0]?.total ?? 0;
}

async function getEpicMonthRow(
  db: typeof DbType,
  epicId: number,
  monthId: number,
) {
  const rows = await db
    .select()
    .from(epicMonths)
    .where(and(eq(epicMonths.epicId, epicId), eq(epicMonths.monthId, monthId)));
  return rows[0] ?? null;
}

function normalizeCapacity(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Math.abs(rounded) < 1e-9 ? 0 : rounded;
}

async function upsertEpicMonthTotal(
  db: typeof DbType,
  epicId: number,
  monthId: number,
  totalCapacity: number,
) {
  const existing = await getEpicMonthRow(db, epicId, monthId);
  if (existing) {
    await db
      .update(epicMonths)
      .set({ totalCapacity: normalizeCapacity(totalCapacity) })
      .where(eq(epicMonths.id, existing.id));
    return;
  }

  await db.insert(epicMonths).values({
    epicId,
    monthId,
    totalCapacity: normalizeCapacity(totalCapacity),
  });
}

async function buildEpicMonthResult(
  db: typeof DbType,
  epicId: number,
  monthId: number,
): Promise<MonthAllocationResult> {
  const fm = await getEpicMonthRow(db, epicId, monthId);
  const totalCapacity = fm?.totalCapacity ?? 0;

  const allocs = await db
    .select()
    .from(memberMonthAllocations)
    .where(
      and(
        eq(memberMonthAllocations.epicId, epicId),
        eq(memberMonthAllocations.monthId, monthId),
      ),
    );

  const assignedTotal = allocs.reduce((s, a) => s + a.capacity, 0);
  return {
    monthId,
    totalCapacity,
    unassignedCapacity: Math.max(0, totalCapacity - assignedTotal),
    memberAllocations: allocs.map((a) => ({
      memberId: a.memberId,
      capacity: a.capacity,
    })),
  };
}

async function buildEpicMonthsResult(
  db: typeof DbType,
  epicId: number,
  monthIds: number[],
) {
  const results = await Promise.all(
    monthIds.map((monthId) => buildEpicMonthResult(db, epicId, monthId)),
  );
  return { months: results };
}

async function buildMemberAllocationUpdateResult(
  db: typeof DbType,
  epicId: number,
  monthIds: number[],
  affectedEpicIds: Iterable<number>,
) {
  const updatedEpics = [];
  for (const affectedEpicId of [...new Set(affectedEpicIds)]) {
    updatedEpics.push({
      epicId: affectedEpicId,
      months: await Promise.all(
        monthIds.map((monthId) =>
          buildEpicMonthResult(db, affectedEpicId, monthId),
        ),
      ),
    });
  }
  const target =
    updatedEpics.find((f) => f.epicId === epicId) ??
    (await buildEpicMonthsResult(db, epicId, monthIds));

  return {
    months: target.months,
    updatedFeatures: updatedEpics,
  };
}

async function updateSingleMonthTotal(
  db: typeof DbType,
  epicId: number,
  monthId: number,
  newTotal: number,
) {
  const existing = await getEpicMonthRow(db, epicId, monthId);
  const oldTotal = existing?.totalCapacity ?? 0;
  await upsertEpicMonthTotal(db, epicId, monthId, newTotal);

  const currentAllocs = await db
    .select()
    .from(memberMonthAllocations)
    .where(
      and(
        eq(memberMonthAllocations.epicId, epicId),
        eq(memberMonthAllocations.monthId, monthId),
      ),
    );

  for (const alloc of currentAllocs) {
    const ratio = oldTotal > 0 ? alloc.capacity / oldTotal : 0;
    const candidate = ratio * newTotal;
    const usedElsewhere = await getMemberUsageInMonth(
      db,
      alloc.memberId,
      monthId,
      epicId,
    );
    const maxCap = await getMemberMaxCapacity(db, alloc.memberId);
    const cap = Math.max(0, maxCap - usedElsewhere);
    const newValue = Math.min(candidate, cap);

    await db
      .update(memberMonthAllocations)
      .set({ capacity: newValue })
      .where(eq(memberMonthAllocations.id, alloc.id));
  }
}

async function setMemberMonthAllocationCapacity(
  db: typeof DbType,
  {
    epicId,
    monthId,
    memberId,
    capacity,
    keepZero,
  }: {
    epicId: number;
    monthId: number;
    memberId: number;
    capacity: number;
    keepZero: boolean;
  },
) {
  const nextCapacity = normalizeCapacity(capacity);
  const existing = await db
    .select()
    .from(memberMonthAllocations)
    .where(
      and(
        eq(memberMonthAllocations.epicId, epicId),
        eq(memberMonthAllocations.monthId, monthId),
        eq(memberMonthAllocations.memberId, memberId),
      ),
    );

  if (nextCapacity <= 0 && !keepZero) {
    if (existing.length > 0) {
      await db
        .delete(memberMonthAllocations)
        .where(eq(memberMonthAllocations.id, existing[0]!.id));
    }
    return;
  }

  if (existing.length > 0) {
    await db
      .update(memberMonthAllocations)
      .set({ capacity: nextCapacity })
      .where(eq(memberMonthAllocations.id, existing[0]!.id));
  } else {
    await db.insert(memberMonthAllocations).values({
      epicId,
      monthId,
      memberId,
      capacity: nextCapacity,
    });
  }
}

async function recalculateEpicMonthTotal(
  db: typeof DbType,
  epicId: number,
  monthId: number,
) {
  const updatedAllocs = await db
    .select()
    .from(memberMonthAllocations)
    .where(
      and(
        eq(memberMonthAllocations.epicId, epicId),
        eq(memberMonthAllocations.monthId, monthId),
      ),
    );
  const newTotal = normalizeCapacity(
    updatedAllocs.reduce((s, a) => s + a.capacity, 0),
  );
  await upsertEpicMonthTotal(db, epicId, monthId, newTotal);
}

async function updateSingleMemberMonthAllocation(
  db: typeof DbType,
  epicId: number,
  monthId: number,
  memberId: number,
  capacity: number,
  capacityConflictResolution: z.infer<typeof capacityConflictResolutionSchema>,
): Promise<Set<number>> {
  const usedElsewhere = await getMemberUsageInMonth(
    db,
    memberId,
    monthId,
    epicId,
  );
  const maxCap = await getMemberMaxCapacity(db, memberId);
  const cap = Math.max(0, maxCap - usedElsewhere);
  let nextCapacity =
    capacityConflictResolution === "fitWithinLimit"
      ? Math.min(capacity, cap)
      : capacity;
  const affectedEpicIds = new Set<number>([epicId]);

  if (
    capacityConflictResolution === "rebalanceOthersProportionally" &&
    capacity <= maxCap &&
    usedElsewhere > 0
  ) {
    const scale = Math.max(0, (maxCap - capacity) / usedElsewhere);
    const otherAllocs = await db
      .select()
      .from(memberMonthAllocations)
      .where(
        and(
          eq(memberMonthAllocations.memberId, memberId),
          eq(memberMonthAllocations.monthId, monthId),
          ne(memberMonthAllocations.epicId, epicId),
        ),
      );

    for (const alloc of otherAllocs) {
      affectedEpicIds.add(alloc.epicId);
      await setMemberMonthAllocationCapacity(db, {
        epicId: alloc.epicId,
        monthId,
        memberId,
        capacity: alloc.capacity * scale,
        keepZero: true,
      });
    }
  }

  if (
    capacityConflictResolution === "rebalanceOthersProportionally" &&
    capacity > maxCap
  ) {
    nextCapacity = capacity;
  }

  if (
    capacityConflictResolution === "rebalanceAllProportionally" &&
    usedElsewhere + capacity > maxCap
  ) {
    const total = usedElsewhere + capacity;
    const scale = maxCap / total;
    const otherAllocs = await db
      .select()
      .from(memberMonthAllocations)
      .where(
        and(
          eq(memberMonthAllocations.memberId, memberId),
          eq(memberMonthAllocations.monthId, monthId),
          ne(memberMonthAllocations.epicId, epicId),
        ),
      );

    for (const alloc of otherAllocs) {
      affectedEpicIds.add(alloc.epicId);
      await setMemberMonthAllocationCapacity(db, {
        epicId: alloc.epicId,
        monthId,
        memberId,
        capacity: alloc.capacity * scale,
        keepZero: true,
      });
    }
    nextCapacity = capacity * scale;
  }

  await setMemberMonthAllocationCapacity(db, {
    epicId,
    monthId,
    memberId,
    capacity: nextCapacity,
    keepZero: false,
  });

  for (const affectedEpicId of affectedEpicIds) {
    await recalculateEpicMonthTotal(db, affectedEpicId, monthId);
  }

  return affectedEpicIds;
}

function splitTotalAcrossMonths(
  requestedTotal: number,
  currentTotals: number[],
): number[] {
  const currentSum = currentTotals.reduce((s, v) => s + v, 0);
  if (currentSum <= 0) {
    const even = requestedTotal / currentTotals.length;
    return currentTotals.map(() => even);
  }
  return currentTotals.map((v) => (v / currentSum) * requestedTotal);
}

function snapshotTimestamp(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

function snapshotsEqual(a: RoadmapSnapshot, b: RoadmapSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function getRoadmapSnapshot(db: typeof DbType): Promise<RoadmapSnapshot> {
  const [
    initiativeRows,
    epicRows,
    epicLinkRows,
    memberRows,
    quarterRows,
    monthRows,
    epicMonthRows,
    memberMonthAllocationRows,
  ] = await Promise.all([
    db.select().from(initiatives).orderBy(asc(initiatives.id)).all(),
    db.select().from(epics).orderBy(asc(epics.id)).all(),
    db.select().from(epicLinks).orderBy(asc(epicLinks.id)).all(),
    db.select().from(members).orderBy(asc(members.id)).all(),
    db.select().from(quarters).orderBy(asc(quarters.id)).all(),
    db.select().from(months).orderBy(asc(months.id)).all(),
    db.select().from(epicMonths).orderBy(asc(epicMonths.id)).all(),
    db
      .select()
      .from(memberMonthAllocations)
      .orderBy(asc(memberMonthAllocations.id))
      .all(),
  ]);

  return {
    initiatives: initiativeRows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      position: row.position,
      isDefault: row.isDefault,
    })),
    epics: epicRows.map((row) => ({
      id: row.id,
      initiativeId: row.initiativeId,
      name: row.name,
      description: row.description,
      position: row.position,
      createdAt: snapshotTimestamp(row.createdAt),
    })),
    epicLinks: epicLinkRows.map((row) => ({
      id: row.id,
      epicId: row.epicId,
      title: row.title,
      url: row.url,
      position: row.position,
    })),
    members: memberRows.map((row) => ({
      id: row.id,
      name: row.name,
      maxCapacity: row.maxCapacity,
      createdAt: snapshotTimestamp(row.createdAt),
    })),
    quarters: quarterRows.map((row) => ({
      id: row.id,
      year: row.year,
      quarter: row.quarter,
    })),
    months: monthRows.map((row) => ({
      id: row.id,
      year: row.year,
      month: row.month,
      quarterId: row.quarterId,
    })),
    epicMonths: epicMonthRows.map((row) => ({
      id: row.id,
      epicId: row.epicId,
      monthId: row.monthId,
      totalCapacity: row.totalCapacity,
    })),
    memberMonthAllocations: memberMonthAllocationRows.map((row) => ({
      id: row.id,
      epicId: row.epicId,
      monthId: row.monthId,
      memberId: row.memberId,
      capacity: row.capacity,
    })),
  };
}

async function restoreRoadmapSnapshot(
  db: typeof DbType,
  snapshot: RoadmapSnapshot,
) {
  await db.delete(memberMonthAllocations);
  await db.delete(epicMonths);
  await db.delete(epicLinks);
  await db.delete(months);
  await db.delete(quarters);
  await db.delete(members);
  await db.delete(epics);
  await db.delete(initiatives);

  if (snapshot.initiatives.length > 0) {
    await db.insert(initiatives).values(snapshot.initiatives);
  }
  if (snapshot.epics.length > 0) {
    await db.insert(epics).values(
      snapshot.epics.map((row) => ({
        id: row.id,
        initiativeId: row.initiativeId,
        name: row.name,
        description: row.description,
        position: row.position,
        createdAt: new Date(row.createdAt),
      })),
    );
  }
  if (snapshot.members.length > 0) {
    await db.insert(members).values(
      snapshot.members.map((row) => ({
        id: row.id,
        name: row.name,
        maxCapacity: row.maxCapacity,
        createdAt: new Date(row.createdAt),
      })),
    );
  }
  if (snapshot.quarters.length > 0) {
    await db.insert(quarters).values(snapshot.quarters);
  }
  if (snapshot.months.length > 0) {
    await db.insert(months).values(snapshot.months);
  }
  if (snapshot.epicLinks.length > 0) {
    await db.insert(epicLinks).values(snapshot.epicLinks);
  }
  if (snapshot.epicMonths.length > 0) {
    await db.insert(epicMonths).values(snapshot.epicMonths);
  }
  if (snapshot.memberMonthAllocations.length > 0) {
    await db
      .insert(memberMonthAllocations)
      .values(snapshot.memberMonthAllocations);
  }
}

function insertMovedId(
  ids: number[],
  id: number,
  beforeId?: number,
  afterId?: number,
): number[] {
  const without = ids.filter((itemId) => itemId !== id);
  let index = without.length;
  if (beforeId !== undefined) {
    const beforeIndex = without.indexOf(beforeId);
    if (beforeIndex >= 0) index = beforeIndex;
  } else if (afterId !== undefined) {
    const afterIndex = without.indexOf(afterId);
    if (afterIndex >= 0) index = afterIndex + 1;
  }
  without.splice(index, 0, id);
  return without;
}

async function resequenceInitiatives(db: typeof DbType, orderedIds: number[]) {
  for (let index = 0; index < orderedIds.length; index++) {
    await db
      .update(initiatives)
      .set({ position: index })
      .where(eq(initiatives.id, orderedIds[index]!));
  }
}

async function resequenceEpics(
  db: typeof DbType,
  initiativeId: number,
  orderedIds: number[],
) {
  const tempOffset = 1_000_000;
  for (let index = 0; index < orderedIds.length; index++) {
    await db
      .update(epics)
      .set({ initiativeId, position: tempOffset + index })
      .where(eq(epics.id, orderedIds[index]!));
  }
  for (let index = 0; index < orderedIds.length; index++) {
    await db
      .update(epics)
      .set({ initiativeId, position: index })
      .where(eq(epics.id, orderedIds[index]!));
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const historySnapshot = o.input(z.object({})).handler(async ({ context }) => {
  return getRoadmapSnapshot(context.db);
});

const historyRestore = o
  .input(
    z.object({
      expected: roadmapSnapshotSchema,
      snapshot: roadmapSnapshotSchema,
    }),
  )
  .handler(async ({ input, context }) => {
    await context.db.transaction(async (tx) => {
      const txDb = tx as unknown as typeof DbType;
      const current = await getRoadmapSnapshot(txDb);
      if (!snapshotsEqual(current, input.expected)) {
        throw new ORPCError("CONFLICT", {
          message:
            "現在のデータが履歴作成時から変更されているため、undo/redoできませんでした。",
        });
      }
      await restoreRoadmapSnapshot(txDb, input.snapshot);
    });
  });

// ---------------------------------------------------------------------------
// Initiatives
// ---------------------------------------------------------------------------

const initiativesList = o.input(z.object({})).handler(async ({ context }) => {
  const rows = await context.db
    .select()
    .from(initiatives)
    .orderBy(asc(initiatives.position), asc(initiatives.id))
    .all();
  return Promise.all(
    rows.map((initiative) => buildInitiativeDto(context.db, initiative)),
  );
});

const initiativesCreate = o
  .input(
    z.object({
      name: z.string(),
      description: z.string().nullable().optional(),
      links: z.array(featureLinkInputSchema).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const name = normalizeNameInput(input.name, "initiative");
    const description = normalizeFeatureDescriptionInput(input.description);
    const links = normalizeFeatureLinksInput(input.links);
    await assertInitiativeNameAvailable(context.db, name);
    const [last] = await context.db
      .select({ position: initiatives.position })
      .from(initiatives)
      .orderBy(sql`${initiatives.position} DESC`, sql`${initiatives.id} DESC`)
      .limit(1);
    try {
      const [row] = await context.db
        .insert(initiatives)
        .values({
          name,
          description: description ?? null,
          position: (last?.position ?? -1) + 1,
          isDefault: false,
        })
        .returning();
      if (!row) return row;
      if (links !== undefined)
        await saveInitiativeLinks(context.db, row.id, links);
      return buildInitiativeDto(context.db, row);
    } catch (error) {
      rethrowNameMutationError("initiative", error);
    }
  });

const initiativesRename = o
  .input(
    z.object({
      id: z.number().int(),
      name: z.string(),
      description: z.string().nullable().optional(),
      links: z.array(featureLinkInputSchema).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const name = normalizeNameInput(input.name, "initiative");
    const description = normalizeFeatureDescriptionInput(input.description);
    const links = normalizeFeatureLinksInput(input.links);
    await assertInitiativeNameAvailable(context.db, name, input.id);
    try {
      const values: { name: string; description?: string | null } = { name };
      if (description !== undefined) values.description = description;
      const [row] = await context.db
        .update(initiatives)
        .set(values)
        .where(eq(initiatives.id, input.id))
        .returning();
      if (!row) return row;
      if (links !== undefined)
        await saveInitiativeLinks(context.db, row.id, links);
      return buildInitiativeDto(context.db, row);
    } catch (error) {
      rethrowNameMutationError("initiative", error);
    }
  });

const initiativesDelete = o
  .input(z.object({ id: z.number().int() }))
  .handler(async ({ input, context }) => {
    const [initiative] = await context.db
      .select()
      .from(initiatives)
      .where(eq(initiatives.id, input.id));
    if (!initiative) return;
    if (initiative.isDefault) {
      throw new ORPCError("BAD_REQUEST", {
        message: "既定Initiativeは削除できません。",
      });
    }
    const [child] = await context.db
      .select({ id: epics.id })
      .from(epics)
      .where(eq(epics.initiativeId, input.id))
      .limit(1);
    if (child) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Epicが残っているInitiativeは削除できません。",
      });
    }
    await context.db.delete(initiatives).where(eq(initiatives.id, input.id));
  });

const initiativesMove = o
  .input(
    z.object({
      id: z.number().int(),
      beforeId: z.number().int().optional(),
      afterId: z.number().int().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const rows = await context.db
      .select({ id: initiatives.id })
      .from(initiatives)
      .orderBy(asc(initiatives.position), asc(initiatives.id))
      .all();
    if (!rows.some((row) => row.id === input.id)) {
      throw new ORPCError("NOT_FOUND", { message: "Initiative not found" });
    }
    const orderedIds = insertMovedId(
      rows.map((row) => row.id),
      input.id,
      input.beforeId,
      input.afterId,
    );
    await resequenceInitiatives(context.db, orderedIds);
    const updatedRows = await context.db
      .select()
      .from(initiatives)
      .orderBy(asc(initiatives.position), asc(initiatives.id))
      .all();
    return Promise.all(
      updatedRows.map((initiative) =>
        buildInitiativeDto(context.db, initiative),
      ),
    );
  });

// ---------------------------------------------------------------------------
// Epics
// ---------------------------------------------------------------------------

const epicsList = o.input(z.object({})).handler(async ({ context }) => {
  const rows = await context.db
    .select()
    .from(epics)
    .orderBy(asc(epics.initiativeId), asc(epics.position), asc(epics.id))
    .all();
  return Promise.all(rows.map((epic) => buildEpicDto(context.db, epic)));
});

const epicsCreate = o
  .input(
    z.object({
      name: z.string(),
      initiativeId: z.number().int().optional(),
      description: z.string().nullable().optional(),
      links: z.array(featureLinkInputSchema).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const name = normalizeNameInput(input.name, "epic");
    const description = normalizeFeatureDescriptionInput(input.description);
    const links = normalizeFeatureLinksInput(input.links);
    const initiativeId =
      input.initiativeId ?? (await getDefaultInitiativeId(context.db));
    await assertEpicNameAvailable(context.db, name);
    try {
      const [row] = await context.db
        .insert(epics)
        .values({
          name,
          description: description ?? null,
          initiativeId,
          position: await nextEpicPosition(context.db, initiativeId),
        })
        .returning();
      if (!row) return row;
      if (links !== undefined) await saveEpicLinks(context.db, row.id, links);
      return buildEpicDto(context.db, row);
    } catch (error) {
      rethrowNameMutationError("epic", error);
    }
  });

const epicsRename = o
  .input(
    z.object({
      id: z.number().int(),
      name: z.string(),
      initiativeId: z.number().int().optional(),
      description: z.string().nullable().optional(),
      links: z.array(featureLinkInputSchema).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const name = normalizeNameInput(input.name, "epic");
    const description = normalizeFeatureDescriptionInput(input.description);
    const links = normalizeFeatureLinksInput(input.links);
    await assertEpicNameAvailable(context.db, name, input.id);
    try {
      const values: {
        name: string;
        description?: string | null;
        initiativeId?: number;
        position?: number;
      } = { name };
      if (description !== undefined) values.description = description;
      if (input.initiativeId !== undefined) {
        const [current] = await context.db
          .select({ initiativeId: epics.initiativeId })
          .from(epics)
          .where(eq(epics.id, input.id));
        values.initiativeId = input.initiativeId;
        if (current?.initiativeId !== input.initiativeId) {
          values.position = await nextEpicPosition(
            context.db,
            input.initiativeId,
          );
        }
      }
      const [row] = await context.db
        .update(epics)
        .set(values)
        .where(eq(epics.id, input.id))
        .returning();
      if (!row) return row;
      if (links !== undefined) await saveEpicLinks(context.db, row.id, links);
      return buildEpicDto(context.db, row);
    } catch (error) {
      rethrowNameMutationError("epic", error);
    }
  });

const epicsDelete = o
  .input(z.object({ id: z.number().int() }))
  .handler(async ({ input, context }) => {
    await context.db.delete(epics).where(eq(epics.id, input.id));
  });

const epicsMove = o
  .input(
    z.object({
      id: z.number().int(),
      initiativeId: z.number().int(),
      beforeId: z.number().int().optional(),
      afterId: z.number().int().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const [target] = await context.db
      .select()
      .from(epics)
      .where(eq(epics.id, input.id));
    if (!target)
      throw new ORPCError("NOT_FOUND", { message: "Epic not found" });

    const affectedInitiativeIds = new Set<number>([
      target.initiativeId,
      input.initiativeId,
    ]);
    for (const initiativeId of affectedInitiativeIds) {
      const rows = await context.db
        .select({ id: epics.id })
        .from(epics)
        .where(eq(epics.initiativeId, initiativeId))
        .orderBy(asc(epics.position), asc(epics.id))
        .all();
      let orderedIds = rows
        .map((row) => row.id)
        .filter((id) => id !== input.id);
      if (initiativeId === input.initiativeId) {
        orderedIds = insertMovedId(
          [...orderedIds, input.id],
          input.id,
          input.beforeId,
          input.afterId,
        );
      }
      await resequenceEpics(context.db, initiativeId, orderedIds);
    }
    const [row] = await context.db
      .select()
      .from(epics)
      .where(eq(epics.id, input.id));
    if (!row) return row;
    return buildEpicDto(context.db, row);
  });

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

const membersList = o
  .input(z.object({}))
  .handler(async ({ context }) => context.db.select().from(members).all());

const membersCreate = o
  .input(z.object({ name: z.string() }))
  .handler(async ({ input, context }) => {
    const name = normalizeNameInput(input.name, "member");
    await assertMemberNameAvailable(context.db, name);
    try {
      const [row] = await context.db
        .insert(members)
        .values({ name })
        .returning();
      return row;
    } catch (error) {
      rethrowNameMutationError("member", error);
    }
  });

const membersRename = o
  .input(z.object({ id: z.number().int(), name: z.string() }))
  .handler(async ({ input, context }) => {
    const name = normalizeNameInput(input.name, "member");
    await assertMemberNameAvailable(context.db, name, input.id);
    try {
      const [row] = await context.db
        .update(members)
        .set({ name })
        .where(eq(members.id, input.id))
        .returning();
      return row;
    } catch (error) {
      rethrowNameMutationError("member", error);
    }
  });

const membersDelete = o
  .input(z.object({ id: z.number().int() }))
  .handler(async ({ input, context }) => {
    await context.db.delete(members).where(eq(members.id, input.id));
  });

const membersSetMaxCapacity = o
  .input(
    z.object({
      id: z.number().int(),
      maxCapacity: z.number().min(0.001).max(1).nullable(),
    }),
  )
  .handler(async ({ input, context }) => {
    const [row] = await context.db
      .update(members)
      .set({ maxCapacity: input.maxCapacity })
      .where(eq(members.id, input.id))
      .returning();
    return row;
  });

const membersGetCapacitySummary = o
  .input(
    z.object({
      year: z.number().int(),
      month: z.number().int().min(1).max(12),
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    return db
      .select({
        id: members.id,
        name: members.name,
        maxCapacity: members.maxCapacity,
        usedCapacity: sql<number>`coalesce(sum(${memberMonthAllocations.capacity}), 0)`,
      })
      .from(members)
      .leftJoin(
        memberMonthAllocations,
        and(
          eq(memberMonthAllocations.memberId, members.id),
          eq(
            memberMonthAllocations.monthId,
            sql`(select id from months where year = ${input.year} and month = ${input.month})`,
          ),
        ),
      )
      .groupBy(members.id)
      .orderBy(asc(members.id))
      .all();
  });

// ---------------------------------------------------------------------------
// Quarters
// ---------------------------------------------------------------------------

const quartersList = o
  .input(z.object({}))
  .handler(async ({ context }) => getQuarterRowsWithMonths(context.db));

const quartersCreate = o
  .input(
    z.object({
      year: z.number().int(),
      quarter: z.number().int().min(1).max(4),
    }),
  )
  .handler(async ({ input, context }) => {
    const [row] = await context.db
      .insert(quarters)
      .values({ year: input.year, quarter: input.quarter })
      .returning();
    if (!row) return row;

    const monthRows = await context.db
      .insert(months)
      .values(
        monthsInQuarter(input.quarter).map((month) => ({
          year: input.year,
          month,
          quarterId: row.id,
        })),
      )
      .returning();

    return {
      ...row,
      months: monthRows.sort((a, b) => a.month - b.month),
    };
  });

const quartersDelete = o
  .input(z.object({ id: z.number().int() }))
  .handler(async ({ input, context }) => {
    await context.db.delete(quarters).where(eq(quarters.id, input.id));
  });

// Allocations
// ---------------------------------------------------------------------------

const allocationsGetEpicView = o
  .input(z.object({ epicId: z.number().int() }))
  .handler(async ({ input, context }) => {
    const { db } = context;
    const [epic] = await db
      .select()
      .from(epics)
      .where(eq(epics.id, input.epicId));
    if (!epic) throw new Error("Epic not found");

    const allQuarters = await getQuarterRowsWithMonths(db);
    const allMembers = await db.select().from(members).all();
    const fmRows = await db
      .select()
      .from(epicMonths)
      .where(eq(epicMonths.epicId, input.epicId));
    const maRows = await db
      .select()
      .from(memberMonthAllocations)
      .where(eq(memberMonthAllocations.epicId, input.epicId));

    const quarterData = allQuarters.map((q) => ({
      quarter: { id: q.id, year: q.year, quarter: q.quarter },
      months: q.months.map((month) => {
        const fm = fmRows.find((r) => r.monthId === month.id);
        const total = fm?.totalCapacity ?? 0;
        const monthAllocs = maRows.filter((r) => r.monthId === month.id);
        const assignedTotal = monthAllocs.reduce((s, a) => s + a.capacity, 0);
        return {
          month,
          totalCapacity: total,
          unassignedCapacity: Math.max(0, total - assignedTotal),
          memberAllocations: allMembers
            .map((member) => ({
              member,
              capacity:
                monthAllocs.find((a) => a.memberId === member.id)?.capacity ??
                0,
            }))
            .filter((a) =>
              monthAllocs.some((rec) => rec.memberId === a.member.id),
            ),
        };
      }),
    }));

    return {
      epic: await buildEpicDto(db, epic),
      quarters: quarterData,
    };
  });

const allocationsGetMemberView = o
  .input(z.object({ memberId: z.number().int() }))
  .handler(async ({ input, context }) => {
    const { db } = context;
    const [member] = await db
      .select()
      .from(members)
      .where(eq(members.id, input.memberId));
    if (!member) throw new Error("Member not found");

    const allQuarters = await getQuarterRowsWithMonths(db);
    const allEpics = await db.select().from(epics).all();
    const allInitiatives = await db.select().from(initiatives).all();
    const initiativeById = new Map(
      allInitiatives.map((initiative) => [initiative.id, initiative]),
    );
    const maRows = await db
      .select()
      .from(memberMonthAllocations)
      .where(eq(memberMonthAllocations.memberId, input.memberId));

    const quarterData = allQuarters.map((q) => ({
      quarter: { id: q.id, year: q.year, quarter: q.quarter },
      months: q.months.map((month) => {
        const monthAllocs = maRows.filter((r) => r.monthId === month.id);
        const monthTotal = monthAllocs.reduce((s, a) => s + a.capacity, 0);
        return {
          month,
          totalCapacity: monthTotal,
          epicAllocations: allEpics
            .map((epic) => ({
              epic: {
                ...epic,
                initiative: initiativeById.get(epic.initiativeId) ?? null,
              },
              capacity:
                monthAllocs.find((a) => a.epicId === epic.id)?.capacity ?? 0,
            }))
            .filter((a) => a.capacity > 0),
        };
      }),
    }));

    return { member, quarters: quarterData };
  });

const allocationsAssignMember = o
  .input(
    z.object({
      epicId: z.number().int(),
      memberId: z.number().int(),
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const { epicId, memberId } = input;
    const allMonths = await db.select().from(months).all();
    for (const month of allMonths) {
      const existing = await db
        .select()
        .from(memberMonthAllocations)
        .where(
          and(
            eq(memberMonthAllocations.epicId, epicId),
            eq(memberMonthAllocations.monthId, month.id),
            eq(memberMonthAllocations.memberId, memberId),
          ),
        );
      if (existing.length === 0) {
        await db.insert(memberMonthAllocations).values({
          epicId,
          monthId: month.id,
          memberId,
          capacity: 0,
        });
      }
    }
  });

const allocationsRemoveMemberFromEpic = o
  .input(
    z.object({
      epicId: z.number().int(),
      memberId: z.number().int(),
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const { epicId, memberId } = input;

    const toRemove = await db
      .select()
      .from(memberMonthAllocations)
      .where(
        and(
          eq(memberMonthAllocations.epicId, epicId),
          eq(memberMonthAllocations.memberId, memberId),
        ),
      );

    if (toRemove.length === 0) return;

    await db
      .delete(memberMonthAllocations)
      .where(
        and(
          eq(memberMonthAllocations.epicId, epicId),
          eq(memberMonthAllocations.memberId, memberId),
        ),
      );

    const affectedMonthIds = [...new Set(toRemove.map((r) => r.monthId))];
    for (const monthId of affectedMonthIds) {
      const remaining = await db
        .select()
        .from(memberMonthAllocations)
        .where(
          and(
            eq(memberMonthAllocations.epicId, epicId),
            eq(memberMonthAllocations.monthId, monthId),
          ),
        );
      const newTotal = remaining.reduce((s, a) => s + a.capacity, 0);
      await upsertEpicMonthTotal(db, epicId, monthId, newTotal);
    }
  });

const allocationsUpdateTotal = o
  .input(
    z.object({
      epicId: z.number().int(),
      totalCapacity: z.number().min(0),
      ...periodInput,
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const monthRows = await getTargetMonthRows(db, input);
    const currentTotals = await Promise.all(
      monthRows.map(async (month) => {
        const fm = await getEpicMonthRow(db, input.epicId, month.id);
        return fm?.totalCapacity ?? 0;
      }),
    );
    const newMonthTotals =
      input.periodType === "month"
        ? [input.totalCapacity]
        : splitTotalAcrossMonths(input.totalCapacity, currentTotals);

    for (const [index, month] of monthRows.entries()) {
      await updateSingleMonthTotal(
        db,
        input.epicId,
        month.id,
        newMonthTotals[index] ?? 0,
      );
    }

    return buildEpicMonthsResult(
      db,
      input.epicId,
      monthRows.map((month) => month.id),
    );
  });

const allocationsPreviewMemberAllocation = o
  .input(
    z.object({
      epicId: z.number().int(),
      memberId: z.number().int(),
      capacity: z.number().min(0),
      ...periodInput,
    }),
  )
  .handler(async ({ input, context }) => {
    const monthRows = await getTargetMonthRows(context.db, input);
    const maxCap = await getMemberMaxCapacity(context.db, input.memberId);
    const monthPreviews = await Promise.all(
      monthRows.map(async (month) => {
        const usedElsewhere = await getMemberUsageInMonth(
          context.db,
          input.memberId,
          month.id,
          input.epicId,
        );
        return {
          usedElsewhere,
          assignableCapacity: Math.max(0, maxCap - usedElsewhere),
        };
      }),
    );

    const totalUsedElsewhere = monthPreviews.reduce(
      (sum, preview) => sum + preview.usedElsewhere,
      0,
    );
    const totalMaxCap = maxCap * monthRows.length;

    return {
      usedElsewhere: normalizeCapacity(totalUsedElsewhere),
      assignableCapacity: normalizeCapacity(
        monthPreviews.reduce(
          (sum, preview) => sum + preview.assignableCapacity,
          0,
        ),
      ),
      hasConflict:
        input.capacity <= totalMaxCap &&
        totalUsedElsewhere + input.capacity > totalMaxCap + 0.000001,
    };
  });

const allocationsUpdateMemberAllocation = o
  .input(
    z.object({
      epicId: z.number().int(),
      memberId: z.number().int(),
      capacity: z.number().min(0),
      ...periodInput,
      capacityConflictResolution: capacityConflictResolutionSchema
        .optional()
        .default("fitWithinLimit"),
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const monthRows = await getTargetMonthRows(db, input);
    const currentCapacities = await Promise.all(
      monthRows.map(async (month) => {
        const [row] = await db
          .select()
          .from(memberMonthAllocations)
          .where(
            and(
              eq(memberMonthAllocations.epicId, input.epicId),
              eq(memberMonthAllocations.monthId, month.id),
              eq(memberMonthAllocations.memberId, input.memberId),
            ),
          );
        return row?.capacity ?? 0;
      }),
    );
    const newMonthCapacities =
      input.periodType === "month"
        ? [input.capacity]
        : splitTotalAcrossMonths(input.capacity, currentCapacities);

    const affectedEpicIds = new Set<number>([input.epicId]);
    for (const [index, month] of monthRows.entries()) {
      const affected = await updateSingleMemberMonthAllocation(
        db,
        input.epicId,
        month.id,
        input.memberId,
        newMonthCapacities[index] ?? 0,
        input.capacityConflictResolution,
      );
      for (const epicId of affected) affectedEpicIds.add(epicId);
    }

    return buildMemberAllocationUpdateResult(
      db,
      input.epicId,
      monthRows.map((month) => month.id),
      affectedEpicIds,
    );
  });

const allocationsMoveQuarter = o
  .input(
    z.object({
      epicId: z.number().int(),
      fromQuarterId: z.number().int(),
      toQuarterId: z.number().int(),
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const { epicId, fromQuarterId, toQuarterId } = input;
    const fromMonths = await getQuarterMonthRows(db, fromQuarterId);
    const toMonths = await getQuarterMonthRows(db, toQuarterId);
    if (fromMonths.length === 0 || toMonths.length === 0) return;

    for (const [index, fromMonth] of fromMonths.entries()) {
      const toMonth = toMonths[index];
      if (!toMonth) continue;

      const fromFm = await getEpicMonthRow(db, epicId, fromMonth.id);
      if (fromFm) {
        const toFm = await getEpicMonthRow(db, epicId, toMonth.id);
        await upsertEpicMonthTotal(
          db,
          epicId,
          toMonth.id,
          (toFm?.totalCapacity ?? 0) + fromFm.totalCapacity,
        );
      }

      const fromAllocs = await db
        .select()
        .from(memberMonthAllocations)
        .where(
          and(
            eq(memberMonthAllocations.epicId, epicId),
            eq(memberMonthAllocations.monthId, fromMonth.id),
          ),
        );

      for (const alloc of fromAllocs) {
        const [toExisting] = await db
          .select()
          .from(memberMonthAllocations)
          .where(
            and(
              eq(memberMonthAllocations.epicId, epicId),
              eq(memberMonthAllocations.monthId, toMonth.id),
              eq(memberMonthAllocations.memberId, alloc.memberId),
            ),
          );

        const usedElsewhere = await getMemberUsageInMonth(
          db,
          alloc.memberId,
          toMonth.id,
          epicId,
        );
        const maxCap = await getMemberMaxCapacity(db, alloc.memberId);
        const cap = Math.max(0, maxCap - usedElsewhere);
        const merged = Math.min(
          (toExisting?.capacity ?? 0) + alloc.capacity,
          cap,
        );

        if (toExisting) {
          await db
            .update(memberMonthAllocations)
            .set({ capacity: merged })
            .where(eq(memberMonthAllocations.id, toExisting.id));
        } else {
          await db.insert(memberMonthAllocations).values({
            epicId,
            monthId: toMonth.id,
            memberId: alloc.memberId,
            capacity: merged,
          });
        }
      }

      await db
        .delete(memberMonthAllocations)
        .where(
          and(
            eq(memberMonthAllocations.epicId, epicId),
            eq(memberMonthAllocations.monthId, fromMonth.id),
          ),
        );
      await db
        .delete(epicMonths)
        .where(
          and(
            eq(epicMonths.epicId, epicId),
            eq(epicMonths.monthId, fromMonth.id),
          ),
        );
    }
  });

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const exportEpicCSV = o.input(z.object({})).handler(async ({ context }) => {
  const { db } = context;
  const allEpics = await db.select().from(epics).all();
  const allInitiatives = await db.select().from(initiatives).all();
  const allQuarters = await getQuarterRowsWithMonths(db);
  const fmRows = await db.select().from(epicMonths).all();
  const initiativeById = new Map(
    allInitiatives.map((initiative) => [initiative.id, initiative.name]),
  );

  const header = [
    "Initiative",
    "Epic",
    "epic_id",
    ...allQuarters.map((q) => `${q.year}-Q${q.quarter}`),
  ].join(",");
  const rows = allEpics.map((epic) => {
    const cells = allQuarters.map((quarter) =>
      quarter.months.reduce((sum, month) => {
        const fm = fmRows.find(
          (r) => r.epicId === epic.id && r.monthId === month.id,
        );
        return sum + (fm?.totalCapacity ?? 0);
      }, 0),
    );
    return [
      csvCell(initiativeById.get(epic.initiativeId) ?? ""),
      csvCell(epic.name),
      epic.id,
      ...cells,
    ].join(",");
  });

  return [header, ...rows].join("\n");
});

const exportMemberCSV = o.input(z.object({})).handler(async ({ context }) => {
  const { db } = context;
  const allMembers = await db.select().from(members).all();
  const allQuarters = await getQuarterRowsWithMonths(db);
  const allEpics = await db.select().from(epics).all();
  const allInitiatives = await db.select().from(initiatives).all();
  const maRows = await db.select().from(memberMonthAllocations).all();
  const initiativeById = new Map(
    allInitiatives.map((initiative) => [initiative.id, initiative.name]),
  );

  const qHeaders = allQuarters.map((q) => `${q.year}-Q${q.quarter}`);
  const header = [
    "担当者",
    "member_id",
    "Initiative",
    "Epic",
    "epic_id",
    ...qHeaders,
  ].join(",");

  const rows: string[] = [];
  for (const member of allMembers) {
    for (const epic of allEpics) {
      const cells = allQuarters.map((quarter) =>
        quarter.months.reduce((sum, month) => {
          const alloc = maRows.find(
            (r) =>
              r.memberId === member.id &&
              r.epicId === epic.id &&
              r.monthId === month.id,
          );
          return sum + (alloc?.capacity ?? 0);
        }, 0),
      );
      if (cells.some((c) => c > 0)) {
        rows.push(
          [
            csvCell(member.name),
            member.id,
            csvCell(initiativeById.get(epic.initiativeId) ?? ""),
            csvCell(epic.name),
            epic.id,
            ...cells,
          ].join(","),
        );
      }
    }
  }

  return [header, ...rows].join("\n");
});

const exportAllocationCSV = o
  .input(z.object({}))
  .handler(async ({ context }) => {
    const { db } = context;
    const allMonths = await db
      .select()
      .from(months)
      .orderBy(months.year, months.month)
      .all();
    const allEpics = await db.select().from(epics).all();
    const allInitiatives = await db.select().from(initiatives).all();
    const allMembers = await db.select().from(members).all();
    const maRows = await db.select().from(memberMonthAllocations).all();

    const epicById = new Map(allEpics.map((f) => [f.id, f]));
    const initiativeById = new Map(
      allInitiatives.map((initiative) => [initiative.id, initiative.name]),
    );
    const memberById = new Map(allMembers.map((m) => [m.id, m.name]));
    const monthById = new Map(allMonths.map((m) => [m.id, m]));

    const header = [
      "Initiative",
      "Epic",
      "epic_id",
      "担当者",
      "member_id",
      "キャパシティ",
      "月",
    ].join(",");
    const rows = maRows
      .filter((r) => r.capacity > 0)
      .flatMap((r) => {
        const epic = epicById.get(r.epicId);
        const epicName = epic?.name ?? "";
        const memberName = memberById.get(r.memberId) ?? "";
        const month = monthById.get(r.monthId);
        if (!month) return [];
        return [
          [
            csvCell(epic ? (initiativeById.get(epic.initiativeId) ?? "") : ""),
            csvCell(epicName),
            r.epicId,
            csvCell(memberName),
            r.memberId,
            r.capacity,
            monthLabel(month.year, month.month),
          ].join(","),
        ];
      });

    return [header, ...rows].join("\n");
  });

function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function tsvCell(value: string): string {
  if (!/["\t\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

const exportAllocationTSV = o
  .input(z.object({}))
  .handler(async ({ context }) => {
    const { db } = context;
    const allMonths = await db
      .select()
      .from(months)
      .orderBy(months.year, months.month)
      .all();
    const allEpics = await db.select().from(epics).all();
    const allInitiatives = await db.select().from(initiatives).all();
    const allMembers = await db.select().from(members).all();
    const maRows = await db.select().from(memberMonthAllocations).all();

    const epicById = new Map(allEpics.map((f) => [f.id, f]));
    const initiativeById = new Map(
      allInitiatives.map((initiative) => [initiative.id, initiative.name]),
    );
    const memberById = new Map(allMembers.map((m) => [m.id, m.name]));
    const monthById = new Map(allMonths.map((m) => [m.id, m]));

    const header = [
      "Initiative",
      "Epic",
      "epic_id",
      "担当者",
      "member_id",
      "キャパシティ",
      "月",
    ].join("\t");
    const rows = maRows
      .filter((r) => r.capacity > 0)
      .flatMap((r) => {
        const epic = epicById.get(r.epicId);
        const epicName = epic?.name ?? "";
        const memberName = memberById.get(r.memberId) ?? "";
        const month = monthById.get(r.monthId);
        if (!month) return [];
        return [
          [
            tsvCell(epic ? (initiativeById.get(epic.initiativeId) ?? "") : ""),
            tsvCell(epicName),
            r.epicId,
            tsvCell(memberName),
            r.memberId,
            r.capacity,
            monthLabel(month.year, month.month),
          ].join("\t"),
        ];
      });

    return [header, ...rows].join("\n");
  });

const exportEpicMetadataCSV = o
  .input(z.object({}))
  .handler(async ({ context }) => {
    const allEpics = await context.db.select().from(epics).all();
    const allInitiatives = await context.db.select().from(initiatives).all();
    const initiativeById = new Map(
      allInitiatives.map((initiative) => [initiative.id, initiative.name]),
    );
    const rows = await Promise.all(
      allEpics.map(async (epic) => {
        const links = await getEpicLinks(context.db, epic.id);
        return [
          csvCell(initiativeById.get(epic.initiativeId) ?? ""),
          epic.id,
          csvCell(epic.name),
          csvCell(epic.description ?? ""),
          csvCell(
            JSON.stringify(
              links.map((link) => ({ title: link.title, url: link.url })),
            ),
          ),
        ].join(",");
      }),
    );
    return [
      ["initiative", "epic_id", "name", "description", "links"].join(","),
      ...rows,
    ].join("\n");
  });

const exportInitiativeMetadataCSV = o
  .input(z.object({}))
  .handler(async ({ context }) => {
    const allInitiatives = await context.db
      .select()
      .from(initiatives)
      .orderBy(asc(initiatives.position), asc(initiatives.id))
      .all();
    const rows = await Promise.all(
      allInitiatives.map(async (initiative) => {
        const links = await getInitiativeLinks(context.db, initiative.id);
        return [
          csvCell(initiative.name),
          csvCell(initiative.description ?? ""),
          csvCell(
            JSON.stringify(
              links.map((link) => ({ title: link.title, url: link.url })),
            ),
          ),
        ].join(",");
      }),
    );
    return [["name", "description", "links"].join(","), ...rows].join("\n");
  });

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function parseTSVLine(line: string): string[] {
  return line.split("\t");
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

async function findOrCreateMonth(
  db: typeof DbType,
  year: number,
  month: number,
  cache: Map<string, number>,
): Promise<number> {
  const key = monthLabel(year, month);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const quarterNum = Math.ceil(month / 3) as 1 | 2 | 3 | 4;
  const existingQ = await db
    .select()
    .from(quarters)
    .where(and(eq(quarters.year, year), eq(quarters.quarter, quarterNum)));

  let quarterId: number;
  if (existingQ[0]) {
    quarterId = existingQ[0].id;
    const existingM = await db
      .select()
      .from(months)
      .where(and(eq(months.year, year), eq(months.month, month)));
    if (existingM[0]) {
      cache.set(key, existingM[0].id);
      return existingM[0].id;
    }
    // Quarter exists but month record missing — create just this month
    const [newM] = await db
      .insert(months)
      .values({ year, month, quarterId })
      .returning();
    if (!newM) throw new Error("Failed to create month record");
    cache.set(key, newM.id);
    return newM.id;
  }

  // Create quarter and all 3 months
  const [newQ] = await db
    .insert(quarters)
    .values({ year, quarter: quarterNum })
    .returning();
  if (!newQ) throw new Error("Failed to create quarter record");
  quarterId = newQ.id;
  const monthRows = await db
    .insert(months)
    .values(
      monthsInQuarter(quarterNum).map((m) => ({ year, month: m, quarterId })),
    )
    .returning();
  for (const m of monthRows) {
    cache.set(monthLabel(m.year, m.month), m.id);
  }
  return cache.get(key)!;
}

type ImportRowError = { row: number; message: string };
type ImportResult = {
  success: number;
  skipped: number;
  errors: ImportRowError[];
};
type MemberTSVImportMode = "append" | "sync";
type MemberTSVImportRow = {
  row: number;
  id: number | null;
  name: string;
  maxCapacity: number | null;
};

class MemberTSVImportAbort extends Error {
  constructor(readonly result: ImportResult) {
    super("Member TSV import aborted");
  }
}

type EpicMetadataImportRow = {
  row: number;
  initiative: string | null | undefined;
  epicId: number | null;
  name: string;
  description: string | null;
  links: NormalizedFeatureLinkInput[];
};

function parseOptionalMemberId(
  raw: string,
  row: number,
  column: string,
): { id: number | null; error?: ImportRowError } {
  const value = raw.trim();
  if (value.length === 0) return { id: null };
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    return {
      id: null,
      error: {
        row,
        message: `${column} は正の整数を入力してください（値: ${value}）`,
      },
    };
  }
  return { id };
}

function parseMemberTSVRows(
  lines: string[],
  colId: number,
  colMemberId: number,
  colName: number,
  colMaxCapacity: number,
): { rows: MemberTSVImportRow[]; skipped: number; errors: ImportRowError[] } {
  const rows: MemberTSVImportRow[] = [];
  const errors: ImportRowError[] = [];
  const seenIds = new Set<number>();
  const seenNames = new Set<string>();
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1;
    const cols = parseTSVLine(lines[i]!);

    const idValue =
      colId >= 0
        ? parseOptionalMemberId(cols[colId] ?? "", rowNum, "id")
        : { id: null };
    const memberIdValue =
      colMemberId >= 0
        ? parseOptionalMemberId(cols[colMemberId] ?? "", rowNum, "member_id")
        : { id: null };

    if (idValue.error) {
      errors.push(idValue.error);
      skipped++;
      continue;
    }
    if (memberIdValue.error) {
      errors.push(memberIdValue.error);
      skipped++;
      continue;
    }
    if (
      idValue.id !== null &&
      memberIdValue.id !== null &&
      idValue.id !== memberIdValue.id
    ) {
      errors.push({
        row: rowNum,
        message: `id と member_id が一致していません（id: ${idValue.id}, member_id: ${memberIdValue.id}）`,
      });
      skipped++;
      continue;
    }

    const id = idValue.id ?? memberIdValue.id;
    if (id !== null) {
      if (seenIds.has(id)) {
        errors.push({
          row: rowNum,
          message: `TSV内でMember IDが重複しています: ${id}`,
        });
        skipped++;
        continue;
      }
      seenIds.add(id);
    }

    let name: string;
    try {
      name = normalizeNameInput(cols[colName] ?? "", "member");
    } catch {
      errors.push({ row: rowNum, message: NAME_ERROR_MESSAGES.blank });
      skipped++;
      continue;
    }
    if (seenNames.has(name)) {
      errors.push({
        row: rowNum,
        message: `TSV内でMember名が重複しています: ${name}`,
      });
      skipped++;
      continue;
    }
    seenNames.add(name);

    let maxCapacity: number | null = null;
    if (colMaxCapacity !== -1) {
      const rawCap = (cols[colMaxCapacity] ?? "").trim();
      if (rawCap.length > 0) {
        const parsed = Number(rawCap);
        if (Number.isNaN(parsed) || parsed <= 0 || parsed > 1) {
          errors.push({
            row: rowNum,
            message: `max_capacity は 0 より大きく 1 以下の値を入力してください（値: ${rawCap}）`,
          });
          skipped++;
          continue;
        }
        maxCapacity = parsed;
      }
    }

    rows.push({ row: rowNum, id, name, maxCapacity });
  }

  return { rows, skipped, errors };
}

function parseFeatureMetadataLinksCell(
  value: string,
): Array<{ title: string; url: string }> {
  if (value.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throwFeatureMetadataError("links列はJSON配列で入力してください。");
  }
  if (!Array.isArray(parsed)) {
    throwFeatureMetadataError("links列はJSON配列で入力してください。");
  }
  return parsed.map((item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      typeof (item as { title?: unknown }).title !== "string" ||
      typeof (item as { url?: unknown }).url !== "string"
    ) {
      throwFeatureMetadataError(
        'links列は [{"title":"...","url":"https://..."}] の形式で入力してください。',
      );
    }
    return {
      title: (item as { title: string }).title,
      url: (item as { url: string }).url,
    };
  });
}

const csvImport = o
  .input(z.object({ csv: z.string() }))
  .handler(async ({ input, context }) => {
    const { db } = context;
    const lines = input.csv
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);

    if (lines.length < 2) {
      return { success: 0, skipped: 0, errors: [] as ImportRowError[] };
    }

    const headers = parseCSVLine(lines[0]!).map((h) => h.trim());
    const colEpic =
      headers.indexOf("Epic") >= 0
        ? headers.indexOf("Epic")
        : headers.indexOf("機能");
    const colMember = headers.indexOf("担当者");
    const colCapacity = headers.indexOf("キャパシティ");
    const colMonth = headers.indexOf("月");
    const colInitiative = headers.indexOf("Initiative");
    const colEpicId =
      headers.indexOf("epic_id") >= 0
        ? headers.indexOf("epic_id")
        : headers.indexOf("feature_id");
    const colMemberId = headers.indexOf("member_id");

    if ([colEpic, colMember, colCapacity, colMonth].includes(-1)) {
      throw new ORPCError("BAD_REQUEST", {
        message:
          "CSVヘッダーに「Epic」「担当者」「キャパシティ」「月」のカラムが必要です。",
      });
    }

    let success = 0;
    let skipped = 0;
    const errors: ImportRowError[] = [];

    // Preload caches
    const epicCache = new Map<string, { id: number; initiativeId: number }>();
    const epicCacheById = new Map<
      number,
      { id: number; initiativeId: number }
    >();
    const memberCache = new Map<string, number>();
    const memberCacheById = new Map<number, number>();
    const monthCache = new Map<string, number>();
    const defaultInitiativeId = await getDefaultInitiativeId(db);
    for (const f of await db.select().from(epics).all()) {
      epicCache.set(f.name, { id: f.id, initiativeId: f.initiativeId });
      epicCacheById.set(f.id, { id: f.id, initiativeId: f.initiativeId });
    }
    for (const m of await db.select().from(members).all()) {
      memberCache.set(m.name, m.id);
      memberCacheById.set(m.id, m.id);
    }
    for (const m of await db.select().from(months).all())
      monthCache.set(monthLabel(m.year, m.month), m.id);

    const affectedPairs = new Set<string>();

    for (let i = 1; i < lines.length; i++) {
      const rowNum = i + 1;
      const cols = parseCSVLine(lines[i]!);

      const epicName = (cols[colEpic] ?? "").trim();
      const memberName = (cols[colMember] ?? "").trim();
      const capacityStr = (cols[colCapacity] ?? "").trim();
      const monthStr = (cols[colMonth] ?? "").trim();
      const rawEpicId = colEpicId >= 0 ? (cols[colEpicId] ?? "").trim() : "";
      const rawMemberId =
        colMemberId >= 0 ? (cols[colMemberId] ?? "").trim() : "";
      const initiativeName =
        colInitiative >= 0 ? (cols[colInitiative] ?? "").trim() : undefined;

      if (!epicName) {
        errors.push({ row: rowNum, message: "Epic名が空です" });
        skipped++;
        continue;
      }
      if (!memberName) {
        errors.push({ row: rowNum, message: "担当者名が空です" });
        skipped++;
        continue;
      }

      const capacity = Number(capacityStr);
      if (!capacityStr || Number.isNaN(capacity) || capacity < 0) {
        errors.push({
          row: rowNum,
          message: `キャパシティが不正な値です: "${capacityStr}"`,
        });
        skipped++;
        continue;
      }

      const monthMatch = /^(\d{4})-(\d{2})$/.exec(monthStr);
      if (!monthMatch) {
        errors.push({
          row: rowNum,
          message: `月のフォーマットが不正です: "${monthStr}"`,
        });
        skipped++;
        continue;
      }
      const year = Number(monthMatch[1]);
      const monthNum = Number(monthMatch[2]);
      if (monthNum < 1 || monthNum > 12) {
        errors.push({
          row: rowNum,
          message: `月の値が不正です: "${monthStr}"`,
        });
        skipped++;
        continue;
      }

      // Find or create epic
      const desiredInitiativeId =
        colInitiative >= 0
          ? await getOrCreateInitiativeByName(db, initiativeName)
          : undefined;
      // ID lookup first, then name fallback
      const parsedEpicId = rawEpicId ? Number(rawEpicId) : NaN;
      let epicRecord =
        (!Number.isNaN(parsedEpicId) && epicCacheById.get(parsedEpicId)) ||
        epicCache.get(epicName);
      let epicId = epicRecord?.id;
      if (epicId === undefined) {
        const initiativeId = desiredInitiativeId ?? defaultInitiativeId;
        const [newF] = await db
          .insert(epics)
          .values({
            name: epicName,
            initiativeId,
            position: await nextEpicPosition(db, initiativeId),
          })
          .returning();
        if (!newF) throw new Error(`Failed to create epic: ${epicName}`);
        epicId = newF.id;
        epicRecord = { id: epicId, initiativeId: newF.initiativeId };
        epicCache.set(epicName, epicRecord);
        epicCacheById.set(epicId, epicRecord);
      } else if (
        desiredInitiativeId !== undefined &&
        epicRecord &&
        epicRecord.initiativeId !== desiredInitiativeId
      ) {
        await db
          .update(epics)
          .set({
            initiativeId: desiredInitiativeId,
            position: await nextEpicPosition(db, desiredInitiativeId),
          })
          .where(eq(epics.id, epicId));
        const updated = { id: epicId, initiativeId: desiredInitiativeId };
        epicCache.set(epicName, updated);
        epicCacheById.set(epicId, updated);
      }

      // Find or create member
      // ID lookup first, then name fallback
      const parsedMemberId = rawMemberId ? Number(rawMemberId) : NaN;
      let memberId =
        (!Number.isNaN(parsedMemberId) &&
          memberCacheById.get(parsedMemberId)) ||
        memberCache.get(memberName);
      if (memberId === undefined) {
        const [newM] = await db
          .insert(members)
          .values({ name: memberName })
          .returning();
        if (!newM) throw new Error(`Failed to create member: ${memberName}`);
        memberId = newM.id;
        memberCache.set(memberName, memberId);
        memberCacheById.set(memberId, memberId);
      }

      // Find or create month (and quarter if needed)
      const monthId = await findOrCreateMonth(db, year, monthNum, monthCache);

      // Ensure epic_months record exists without overwriting existing total
      const existingFM = await getEpicMonthRow(db, epicId, monthId);
      if (!existingFM) {
        await db
          .insert(epicMonths)
          .values({ epicId, monthId, totalCapacity: 0 });
      }

      // Additive upsert for member_month_allocations
      const existingAlloc = await db
        .select()
        .from(memberMonthAllocations)
        .where(
          and(
            eq(memberMonthAllocations.epicId, epicId),
            eq(memberMonthAllocations.monthId, monthId),
            eq(memberMonthAllocations.memberId, memberId),
          ),
        );

      if (existingAlloc[0]) {
        await db
          .update(memberMonthAllocations)
          .set({
            capacity: normalizeCapacity(existingAlloc[0].capacity + capacity),
          })
          .where(eq(memberMonthAllocations.id, existingAlloc[0].id));
      } else {
        await db.insert(memberMonthAllocations).values({
          epicId,
          monthId,
          memberId,
          capacity: normalizeCapacity(capacity),
        });
      }

      affectedPairs.add(`${epicId}:${monthId}`);
      success++;
    }

    // Recalculate epic_months totals for all affected pairs
    for (const pair of affectedPairs) {
      const parts = pair.split(":");
      await recalculateEpicMonthTotal(db, Number(parts[0]), Number(parts[1]));
    }

    return { success, skipped, errors };
  });

const tsvImport = o
  .input(z.object({ tsv: z.string() }))
  .handler(async ({ input, context }) => {
    const { db } = context;
    const lines = input.tsv
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);

    if (lines.length < 2) {
      return { success: 0, skipped: 0, errors: [] as ImportRowError[] };
    }

    const headers = parseTSVLine(lines[0]!).map((h) => h.trim());
    const colEpic =
      headers.indexOf("Epic") >= 0
        ? headers.indexOf("Epic")
        : headers.indexOf("機能");
    const colMember = headers.indexOf("担当者");
    const colCapacity = headers.indexOf("キャパシティ");
    const colMonth = headers.indexOf("月");
    const colInitiative = headers.indexOf("Initiative");
    const colEpicId =
      headers.indexOf("epic_id") >= 0
        ? headers.indexOf("epic_id")
        : headers.indexOf("feature_id");
    const colMemberId = headers.indexOf("member_id");

    if ([colEpic, colMember, colCapacity, colMonth].includes(-1)) {
      throw new ORPCError("BAD_REQUEST", {
        message:
          "TSVヘッダーに「Epic」「担当者」「キャパシティ」「月」のカラムが必要です。",
      });
    }

    let success = 0;
    let skipped = 0;
    const errors: ImportRowError[] = [];

    // Preload caches
    const epicCache = new Map<string, { id: number; initiativeId: number }>();
    const epicCacheById = new Map<
      number,
      { id: number; initiativeId: number }
    >();
    const memberCache = new Map<string, number>();
    const memberCacheById = new Map<number, number>();
    const monthCache = new Map<string, number>();
    const defaultInitiativeId = await getDefaultInitiativeId(db);
    for (const f of await db.select().from(epics).all()) {
      epicCache.set(f.name, { id: f.id, initiativeId: f.initiativeId });
      epicCacheById.set(f.id, { id: f.id, initiativeId: f.initiativeId });
    }
    for (const m of await db.select().from(members).all()) {
      memberCache.set(m.name, m.id);
      memberCacheById.set(m.id, m.id);
    }
    for (const m of await db.select().from(months).all())
      monthCache.set(monthLabel(m.year, m.month), m.id);

    const affectedPairs = new Set<string>();

    for (let i = 1; i < lines.length; i++) {
      const rowNum = i + 1;
      const cols = parseTSVLine(lines[i]!);

      const epicName = (cols[colEpic] ?? "").trim();
      const memberName = (cols[colMember] ?? "").trim();
      const capacityStr = (cols[colCapacity] ?? "").trim();
      const monthStr = (cols[colMonth] ?? "").trim();
      const rawEpicId = colEpicId >= 0 ? (cols[colEpicId] ?? "").trim() : "";
      const rawMemberId =
        colMemberId >= 0 ? (cols[colMemberId] ?? "").trim() : "";
      const initiativeName =
        colInitiative >= 0 ? (cols[colInitiative] ?? "").trim() : undefined;

      if (!epicName) {
        errors.push({ row: rowNum, message: "Epic名が空です" });
        skipped++;
        continue;
      }
      if (!memberName) {
        errors.push({ row: rowNum, message: "担当者名が空です" });
        skipped++;
        continue;
      }

      const capacity = Number(capacityStr);
      if (!capacityStr || Number.isNaN(capacity) || capacity < 0) {
        errors.push({
          row: rowNum,
          message: `キャパシティが不正な値です: "${capacityStr}"`,
        });
        skipped++;
        continue;
      }

      const monthMatch = /^(\d{4})-(\d{2})$/.exec(monthStr);
      if (!monthMatch) {
        errors.push({
          row: rowNum,
          message: `月のフォーマットが不正です: "${monthStr}"`,
        });
        skipped++;
        continue;
      }
      const year = Number(monthMatch[1]);
      const monthNum = Number(monthMatch[2]);
      if (monthNum < 1 || monthNum > 12) {
        errors.push({
          row: rowNum,
          message: `月の値が不正です: "${monthStr}"`,
        });
        skipped++;
        continue;
      }

      // Find or create epic
      const desiredInitiativeId =
        colInitiative >= 0
          ? await getOrCreateInitiativeByName(db, initiativeName)
          : undefined;
      // ID lookup first, then name fallback
      const parsedEpicId = rawEpicId ? Number(rawEpicId) : NaN;
      let epicRecord =
        (!Number.isNaN(parsedEpicId) && epicCacheById.get(parsedEpicId)) ||
        epicCache.get(epicName);
      let epicId = epicRecord?.id;
      if (epicId === undefined) {
        const initiativeId = desiredInitiativeId ?? defaultInitiativeId;
        const [newF] = await db
          .insert(epics)
          .values({
            name: epicName,
            initiativeId,
            position: await nextEpicPosition(db, initiativeId),
          })
          .returning();
        if (!newF) throw new Error(`Failed to create epic: ${epicName}`);
        epicId = newF.id;
        epicRecord = { id: epicId, initiativeId: newF.initiativeId };
        epicCache.set(epicName, epicRecord);
        epicCacheById.set(epicId, epicRecord);
      } else if (
        desiredInitiativeId !== undefined &&
        epicRecord &&
        epicRecord.initiativeId !== desiredInitiativeId
      ) {
        await db
          .update(epics)
          .set({
            initiativeId: desiredInitiativeId,
            position: await nextEpicPosition(db, desiredInitiativeId),
          })
          .where(eq(epics.id, epicId));
        const updated = { id: epicId, initiativeId: desiredInitiativeId };
        epicCache.set(epicName, updated);
        epicCacheById.set(epicId, updated);
      }

      // Find or create member
      // ID lookup first, then name fallback
      const parsedMemberId = rawMemberId ? Number(rawMemberId) : NaN;
      let memberId =
        (!Number.isNaN(parsedMemberId) &&
          memberCacheById.get(parsedMemberId)) ||
        memberCache.get(memberName);
      if (memberId === undefined) {
        const [newM] = await db
          .insert(members)
          .values({ name: memberName })
          .returning();
        if (!newM) throw new Error(`Failed to create member: ${memberName}`);
        memberId = newM.id;
        memberCache.set(memberName, memberId);
        memberCacheById.set(memberId, memberId);
      }

      // Find or create month (and quarter if needed)
      const monthId = await findOrCreateMonth(db, year, monthNum, monthCache);

      // Ensure epic_months record exists without overwriting existing total
      const existingFM = await getEpicMonthRow(db, epicId, monthId);
      if (!existingFM) {
        await db
          .insert(epicMonths)
          .values({ epicId, monthId, totalCapacity: 0 });
      }

      // Additive upsert for member_month_allocations
      const existingAlloc = await db
        .select()
        .from(memberMonthAllocations)
        .where(
          and(
            eq(memberMonthAllocations.epicId, epicId),
            eq(memberMonthAllocations.monthId, monthId),
            eq(memberMonthAllocations.memberId, memberId),
          ),
        );

      if (existingAlloc[0]) {
        await db
          .update(memberMonthAllocations)
          .set({
            capacity: normalizeCapacity(existingAlloc[0].capacity + capacity),
          })
          .where(eq(memberMonthAllocations.id, existingAlloc[0].id));
      } else {
        await db.insert(memberMonthAllocations).values({
          epicId,
          monthId,
          memberId,
          capacity: normalizeCapacity(capacity),
        });
      }

      affectedPairs.add(`${epicId}:${monthId}`);
      success++;
    }

    // Recalculate epic_months totals for all affected pairs
    for (const pair of affectedPairs) {
      const parts = pair.split(":");
      await recalculateEpicMonthTotal(db, Number(parts[0]), Number(parts[1]));
    }

    return { success, skipped, errors };
  });

const epicMetadataCSVImport = o
  .input(z.object({ csv: z.string() }))
  .handler(async ({ input, context }) => {
    const { db } = context;
    const lines = input.csv
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);

    if (lines.length < 2) return { success: 0 };

    const headers = parseCSVLine(lines[0]!).map((h) => h.trim());
    const colInitiative = headers.indexOf("initiative");
    const colEpicId = headers.indexOf("epic_id");
    const colName = headers.indexOf("name");
    const colDescription = headers.indexOf("description");
    const colLinks = headers.indexOf("links");
    if ([colName, colDescription, colLinks].includes(-1)) {
      throw new ORPCError("BAD_REQUEST", {
        message: "CSVヘッダーに name,description,links のカラムが必要です。",
      });
    }

    const rows: EpicMetadataImportRow[] = [];
    const seenNames = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
      const rowNum = i + 1;
      const cols = parseCSVLine(lines[i]!);
      const initiative =
        colInitiative < 0
          ? undefined
          : (cols[colInitiative] ?? "").trim().length > 0
            ? (cols[colInitiative] ?? "").trim()
            : null;
      const name = normalizeNameInput(cols[colName] ?? "", "epic");
      if (seenNames.has(name)) {
        throwFeatureMetadataError(
          `Epic metadata CSV内でEpic名が重複しています: ${name}`,
        );
      }
      seenNames.add(name);

      const rawEpicId = colEpicId >= 0 ? (cols[colEpicId] ?? "").trim() : "";
      const epicId = rawEpicId ? Number(rawEpicId) : null;

      const description = normalizeFeatureDescriptionInput(
        cols[colDescription] ?? "",
      );
      const links = normalizeFeatureLinksInput(
        parseFeatureMetadataLinksCell(cols[colLinks] ?? ""),
      );
      rows.push({
        row: rowNum,
        initiative,
        epicId: epicId !== null && !Number.isNaN(epicId) ? epicId : null,
        name,
        description: description ?? null,
        links: links ?? [],
      });
    }

    const existingEpics = await db.select().from(epics).all();
    const epicByName = new Map(existingEpics.map((f) => [f.name, f]));
    const epicById = new Map(existingEpics.map((f) => [f.id, f]));
    const defaultInitiativeId = await getDefaultInitiativeId(db);

    for (const row of rows) {
      // ID lookup first, then name fallback
      const existing =
        (row.epicId !== null && epicById.get(row.epicId)) ||
        epicByName.get(row.name);
      const initiativeId =
        row.initiative === undefined
          ? (existing?.initiativeId ?? defaultInitiativeId)
          : row.initiative !== null
            ? await getOrCreateInitiativeByName(db, row.initiative)
            : defaultInitiativeId;
      if (existing) {
        const [updated] = await db
          .update(epics)
          .set({
            description: row.description,
            initiativeId,
            ...(existing.initiativeId !== initiativeId
              ? { position: await nextEpicPosition(db, initiativeId) }
              : {}),
          })
          .where(eq(epics.id, existing.id))
          .returning();
        if (!updated) {
          throw new Error(`Failed to update epic metadata at row ${row.row}`);
        }
        await saveEpicLinks(db, existing.id, row.links);
        epicByName.set(row.name, updated);
        epicById.set(existing.id, updated);
      } else {
        const [created] = await db
          .insert(epics)
          .values({
            name: row.name,
            description: row.description,
            initiativeId,
            position: await nextEpicPosition(db, initiativeId),
          })
          .returning();
        if (!created) {
          throw new Error(`Failed to create epic metadata at row ${row.row}`);
        }
        await saveEpicLinks(db, created.id, row.links);
        epicByName.set(row.name, created);
        epicById.set(created.id, created);
      }
    }

    return { success: rows.length };
  });

const memberTSVImport = o
  .input(
    z.object({
      tsv: z.string(),
      mode: z.enum(["append", "sync"]).default("append"),
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const mode: MemberTSVImportMode = input.mode;
    const lines = input.tsv
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);

    if (lines.length === 0) return { success: 0, skipped: 0, errors: [] };

    const headers = parseTSVLine(lines[0]!).map((h) => h.trim());
    const colId = headers.indexOf("id");
    const colMemberId = headers.indexOf("member_id");
    const colName = headers.indexOf("name");
    const colMaxCapacity = headers.indexOf("max_capacity");
    const hasMaxCapacityColumn = colMaxCapacity !== -1;

    if (colName === -1) {
      throw new ORPCError("BAD_REQUEST", {
        message: "TSVヘッダーに「name」カラムが必要です。",
      });
    }

    const parsed = parseMemberTSVRows(
      lines,
      colId,
      colMemberId,
      colName,
      colMaxCapacity,
    );
    if (mode === "sync" && parsed.errors.length > 0) {
      return { success: 0, skipped: parsed.skipped, errors: parsed.errors };
    }

    async function applyRows(targetDb: typeof DbType): Promise<ImportResult> {
      const result: ImportResult = {
        success: 0,
        skipped: parsed.skipped,
        errors: [...parsed.errors],
      };
      const existingMembers = await targetDb.select().from(members).all();
      let memberByName = new Map(existingMembers.map((m) => [m.name, m]));
      let memberById = new Map(existingMembers.map((m) => [m.id, m]));
      const retainedMemberIds = new Set<number>();

      const failRow = (row: number, message: string) => {
        result.errors.push({ row, message });
        result.skipped++;
        if (mode === "sync") {
          throw new MemberTSVImportAbort({ ...result, success: 0 });
        }
      };

      if (mode === "sync") {
        for (const row of parsed.rows) {
          if (row.id === null) continue;
          const existingById = memberById.get(row.id);
          const existingByName = memberByName.get(row.name);
          if (!existingById && existingByName) {
            failRow(
              row.row,
              `指定されたidは存在しませんが、同名のMemberが既に存在します（名前: ${row.name}）`,
            );
          }
          if (
            existingById &&
            existingByName &&
            existingByName.id !== existingById.id
          ) {
            failRow(row.row, `Member名は重複できません（名前: ${row.name}）`);
          }
        }

        const preRetainedMemberIds = new Set<number>();
        for (const row of parsed.rows) {
          if (row.id !== null) {
            preRetainedMemberIds.add(row.id);
          } else {
            const existing = memberByName.get(row.name);
            if (existing) preRetainedMemberIds.add(existing.id);
          }
        }
        for (const member of existingMembers) {
          if (!preRetainedMemberIds.has(member.id)) {
            await targetDb.delete(members).where(eq(members.id, member.id));
          }
        }
        const currentMembers = await targetDb.select().from(members).all();
        memberByName = new Map(currentMembers.map((m) => [m.name, m]));
        memberById = new Map(currentMembers.map((m) => [m.id, m]));
      }

      for (const row of parsed.rows) {
        const existing =
          row.id !== null ? memberById.get(row.id) : memberByName.get(row.name);
        const nameOwner = memberByName.get(row.name);

        if (existing && nameOwner && nameOwner.id !== existing.id) {
          failRow(row.row, `Member名は重複できません（名前: ${row.name}）`);
          continue;
        }
        if (!existing && nameOwner) {
          failRow(
            row.row,
            `指定されたidは存在しませんが、同名のMemberが既に存在します（名前: ${row.name}）`,
          );
          continue;
        }

        try {
          if (existing) {
            const values: { name: string; maxCapacity?: number | null } = {
              name: row.name,
            };
            if (hasMaxCapacityColumn) values.maxCapacity = row.maxCapacity;
            const [updated] = await targetDb
              .update(members)
              .set(values)
              .where(eq(members.id, existing.id))
              .returning();
            if (!updated) {
              failRow(row.row, `行 ${row.row}: インポートに失敗しました`);
              continue;
            }
            memberByName.delete(existing.name);
            memberByName.set(updated.name, updated);
            memberById.set(updated.id, updated);
            retainedMemberIds.add(updated.id);
          } else {
            const values: {
              id?: number;
              name: string;
              maxCapacity?: number | null;
            } = { name: row.name };
            if (row.id !== null) values.id = row.id;
            if (hasMaxCapacityColumn) values.maxCapacity = row.maxCapacity;
            const [created] = await targetDb
              .insert(members)
              .values(values)
              .returning();
            if (!created) {
              failRow(row.row, `行 ${row.row}: インポートに失敗しました`);
              continue;
            }
            memberByName.set(created.name, created);
            memberById.set(created.id, created);
            retainedMemberIds.add(created.id);
          }
          result.success++;
        } catch (_error) {
          failRow(row.row, `行 ${row.row}: インポートに失敗しました`);
        }
      }

      if (mode === "sync") {
        const currentMembers = await targetDb.select().from(members).all();
        for (const member of currentMembers) {
          if (!retainedMemberIds.has(member.id)) {
            await targetDb.delete(members).where(eq(members.id, member.id));
          }
        }
      }

      return result;
    }

    if (mode === "append") return applyRows(db);

    try {
      return await db.transaction(async (tx) => {
        const txDb = tx as unknown as typeof DbType;
        return applyRows(txDb);
      });
    } catch (error) {
      if (error instanceof MemberTSVImportAbort) return error.result;
      throw error;
    }
  });

const initiativeMetadataCSVImport = o
  .input(z.object({ csv: z.string() }))
  .handler(async ({ input, context }) => {
    const { db } = context;
    const lines = input.csv
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);

    if (lines.length < 2) return { success: 0 };

    const headers = parseCSVLine(lines[0]!).map((h) => h.trim());
    const colName = headers.indexOf("name");
    const colDescription = headers.indexOf("description");
    const colLinks = headers.indexOf("links");
    if ([colName, colDescription, colLinks].includes(-1)) {
      throw new ORPCError("BAD_REQUEST", {
        message: "CSVヘッダーに name,description,links のカラムが必要です。",
      });
    }

    const rows: Array<{
      row: number;
      name: string;
      description: string | null;
      links: NormalizedFeatureLinkInput[];
    }> = [];
    const seenNames = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
      const rowNum = i + 1;
      const cols = parseCSVLine(lines[i]!);
      const name = normalizeNameInput(cols[colName] ?? "", "initiative");
      if (seenNames.has(name)) {
        throwFeatureMetadataError(
          `Initiative metadata CSV内でInitiative名が重複しています: ${name}`,
        );
      }
      seenNames.add(name);
      const description = normalizeFeatureDescriptionInput(
        cols[colDescription] ?? "",
      );
      const links = normalizeFeatureLinksInput(
        parseFeatureMetadataLinksCell(cols[colLinks] ?? ""),
      );
      rows.push({
        row: rowNum,
        name,
        description: description ?? null,
        links: links ?? [],
      });
    }

    const existingInitiatives = await db.select().from(initiatives).all();
    const initiativeByName = new Map(
      existingInitiatives.map((initiative) => [initiative.name, initiative]),
    );
    for (const row of rows) {
      const existing = initiativeByName.get(row.name);
      if (existing) {
        const [updated] = await db
          .update(initiatives)
          .set({ description: row.description })
          .where(eq(initiatives.id, existing.id))
          .returning();
        if (!updated) {
          throw new Error(
            `Failed to update initiative metadata at row ${row.row}`,
          );
        }
        await saveInitiativeLinks(db, existing.id, row.links);
        initiativeByName.set(row.name, updated);
      } else {
        const [created] = await db
          .insert(initiatives)
          .values({
            name: row.name,
            description: row.description,
            position: (await db.select().from(initiatives).all()).length,
            isDefault: false,
          })
          .returning();
        if (!created) {
          throw new Error(
            `Failed to create initiative metadata at row ${row.row}`,
          );
        }
        await saveInitiativeLinks(db, created.id, row.links);
        initiativeByName.set(row.name, created);
      }
    }

    return { success: rows.length };
  });

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const router = {
  history: {
    snapshot: historySnapshot,
    restore: historyRestore,
  },
  initiatives: {
    list: initiativesList,
    create: initiativesCreate,
    rename: initiativesRename,
    delete: initiativesDelete,
    move: initiativesMove,
  },
  epics: {
    list: epicsList,
    create: epicsCreate,
    rename: epicsRename,
    delete: epicsDelete,
    move: epicsMove,
  },
  members: {
    list: membersList,
    create: membersCreate,
    rename: membersRename,
    delete: membersDelete,
    setMaxCapacity: membersSetMaxCapacity,
    getCapacitySummary: membersGetCapacitySummary,
  },
  quarters: {
    list: quartersList,
    create: quartersCreate,
    delete: quartersDelete,
  },
  allocations: {
    getEpicView: allocationsGetEpicView,
    getMemberView: allocationsGetMemberView,
    assignMember: allocationsAssignMember,
    removeMemberFromEpic: allocationsRemoveMemberFromEpic,
    previewMemberAllocation: allocationsPreviewMemberAllocation,
    updateTotal: allocationsUpdateTotal,
    updateMemberAllocation: allocationsUpdateMemberAllocation,
    moveQuarter: allocationsMoveQuarter,
  },
  export: {
    epicCSV: exportEpicCSV,
    memberCSV: exportMemberCSV,
    allocationCSV: exportAllocationCSV,
    allocationTSV: exportAllocationTSV,
    epicMetadataCSV: exportEpicMetadataCSV,
    initiativeMetadataCSV: exportInitiativeMetadataCSV,
  },
  import: {
    csvImport,
    tsvImport,
    epicMetadataCSVImport,
    memberTSVImport,
    initiativeMetadataCSVImport,
  },
};

export type AppRouter = typeof router;
