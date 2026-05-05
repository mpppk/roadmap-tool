import { ORPCError, os } from "@orpc/server";
import { and, eq, ne, sql } from "drizzle-orm";
import * as z from "zod";
import type { db as DbType } from "./db/index";
import {
  featureMonths,
  features,
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
]);

type SQLiteConstraintError = {
  code?: string;
  message?: string;
};

function normalizeNameInput(name: string, resource: NameResource): string {
  const normalized = trimSqliteSpaces(name);
  if (normalized.length === 0) throwNameError(resource, "BLANK_NAME");
  return normalized;
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
  if (
    sqliteError?.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    (message.includes(
      `${resource === "feature" ? "features" : "members"}.name`,
    ) ||
      message.includes(
        `${resource === "feature" ? "features" : "members"}_name_trim_unique`,
      ))
  ) {
    throwNameError(resource, "DUPLICATE_NAME");
  }

  if (
    sqliteError?.code === "SQLITE_CONSTRAINT_CHECK" &&
    message.includes(
      `${resource === "feature" ? "features" : "members"}_name_not_empty_check`,
    )
  ) {
    throwNameError(resource, "BLANK_NAME");
  }

  throw error;
}

async function assertFeatureNameAvailable(
  db: typeof DbType,
  name: string,
  excludeId?: number,
): Promise<void> {
  const where =
    excludeId === undefined
      ? sql`trim(${features.name}) = ${name}`
      : and(sql`trim(${features.name}) = ${name}`, ne(features.id, excludeId));
  const existing = await db
    .select({ id: features.id })
    .from(features)
    .where(where);
  if (existing.length > 0) throwNameError("feature", "DUPLICATE_NAME");
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
  excludeFeatureId: number,
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
        ne(memberMonthAllocations.featureId, excludeFeatureId),
      ),
    );
  return rows[0]?.total ?? 0;
}

async function getFeatureMonthRow(
  db: typeof DbType,
  featureId: number,
  monthId: number,
) {
  const rows = await db
    .select()
    .from(featureMonths)
    .where(
      and(
        eq(featureMonths.featureId, featureId),
        eq(featureMonths.monthId, monthId),
      ),
    );
  return rows[0] ?? null;
}

function normalizeCapacity(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Math.abs(rounded) < 1e-9 ? 0 : rounded;
}

async function upsertFeatureMonthTotal(
  db: typeof DbType,
  featureId: number,
  monthId: number,
  totalCapacity: number,
) {
  const existing = await getFeatureMonthRow(db, featureId, monthId);
  if (existing) {
    await db
      .update(featureMonths)
      .set({ totalCapacity: normalizeCapacity(totalCapacity) })
      .where(eq(featureMonths.id, existing.id));
    return;
  }

  await db.insert(featureMonths).values({
    featureId,
    monthId,
    totalCapacity: normalizeCapacity(totalCapacity),
  });
}

async function buildFeatureMonthResult(
  db: typeof DbType,
  featureId: number,
  monthId: number,
): Promise<MonthAllocationResult> {
  const fm = await getFeatureMonthRow(db, featureId, monthId);
  const totalCapacity = fm?.totalCapacity ?? 0;

  const allocs = await db
    .select()
    .from(memberMonthAllocations)
    .where(
      and(
        eq(memberMonthAllocations.featureId, featureId),
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

async function buildFeatureMonthsResult(
  db: typeof DbType,
  featureId: number,
  monthIds: number[],
) {
  const results = await Promise.all(
    monthIds.map((monthId) => buildFeatureMonthResult(db, featureId, monthId)),
  );
  return { months: results };
}

async function buildMemberAllocationUpdateResult(
  db: typeof DbType,
  featureId: number,
  monthIds: number[],
  affectedFeatureIds: Iterable<number>,
) {
  const updatedFeatures = [];
  for (const affectedFeatureId of [...new Set(affectedFeatureIds)]) {
    updatedFeatures.push({
      featureId: affectedFeatureId,
      months: await Promise.all(
        monthIds.map((monthId) =>
          buildFeatureMonthResult(db, affectedFeatureId, monthId),
        ),
      ),
    });
  }
  const target =
    updatedFeatures.find((f) => f.featureId === featureId) ??
    (await buildFeatureMonthsResult(db, featureId, monthIds));

  return {
    months: target.months,
    updatedFeatures,
  };
}

async function updateSingleMonthTotal(
  db: typeof DbType,
  featureId: number,
  monthId: number,
  newTotal: number,
) {
  const existing = await getFeatureMonthRow(db, featureId, monthId);
  const oldTotal = existing?.totalCapacity ?? 0;
  await upsertFeatureMonthTotal(db, featureId, monthId, newTotal);

  const currentAllocs = await db
    .select()
    .from(memberMonthAllocations)
    .where(
      and(
        eq(memberMonthAllocations.featureId, featureId),
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
      featureId,
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
    featureId,
    monthId,
    memberId,
    capacity,
    keepZero,
  }: {
    featureId: number;
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
        eq(memberMonthAllocations.featureId, featureId),
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
      featureId,
      monthId,
      memberId,
      capacity: nextCapacity,
    });
  }
}

async function recalculateFeatureMonthTotal(
  db: typeof DbType,
  featureId: number,
  monthId: number,
) {
  const updatedAllocs = await db
    .select()
    .from(memberMonthAllocations)
    .where(
      and(
        eq(memberMonthAllocations.featureId, featureId),
        eq(memberMonthAllocations.monthId, monthId),
      ),
    );
  const newTotal = normalizeCapacity(
    updatedAllocs.reduce((s, a) => s + a.capacity, 0),
  );
  await upsertFeatureMonthTotal(db, featureId, monthId, newTotal);
}

async function updateSingleMemberMonthAllocation(
  db: typeof DbType,
  featureId: number,
  monthId: number,
  memberId: number,
  capacity: number,
  capacityConflictResolution: z.infer<typeof capacityConflictResolutionSchema>,
): Promise<Set<number>> {
  const usedElsewhere = await getMemberUsageInMonth(
    db,
    memberId,
    monthId,
    featureId,
  );
  const maxCap = await getMemberMaxCapacity(db, memberId);
  const cap = Math.max(0, maxCap - usedElsewhere);
  let nextCapacity =
    capacityConflictResolution === "fitWithinLimit"
      ? Math.min(capacity, cap)
      : capacity;
  const affectedFeatureIds = new Set<number>([featureId]);

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
          ne(memberMonthAllocations.featureId, featureId),
        ),
      );

    for (const alloc of otherAllocs) {
      affectedFeatureIds.add(alloc.featureId);
      await setMemberMonthAllocationCapacity(db, {
        featureId: alloc.featureId,
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

  await setMemberMonthAllocationCapacity(db, {
    featureId,
    monthId,
    memberId,
    capacity: nextCapacity,
    keepZero: false,
  });

  for (const affectedFeatureId of affectedFeatureIds) {
    await recalculateFeatureMonthTotal(db, affectedFeatureId, monthId);
  }

  return affectedFeatureIds;
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

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

const featuresList = o
  .input(z.object({}))
  .handler(async ({ context }) => context.db.select().from(features).all());

const featuresCreate = o
  .input(z.object({ name: z.string() }))
  .handler(async ({ input, context }) => {
    const name = normalizeNameInput(input.name, "feature");
    await assertFeatureNameAvailable(context.db, name);
    try {
      const [row] = await context.db
        .insert(features)
        .values({ name })
        .returning();
      return row;
    } catch (error) {
      rethrowNameMutationError("feature", error);
    }
  });

const featuresRename = o
  .input(z.object({ id: z.number().int(), name: z.string() }))
  .handler(async ({ input, context }) => {
    const name = normalizeNameInput(input.name, "feature");
    await assertFeatureNameAvailable(context.db, name, input.id);
    try {
      const [row] = await context.db
        .update(features)
        .set({ name })
        .where(eq(features.id, input.id))
        .returning();
      return row;
    } catch (error) {
      rethrowNameMutationError("feature", error);
    }
  });

const featuresDelete = o
  .input(z.object({ id: z.number().int() }))
  .handler(async ({ input, context }) => {
    await context.db.delete(features).where(eq(features.id, input.id));
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

const allocationsGetFeatureView = o
  .input(z.object({ featureId: z.number().int() }))
  .handler(async ({ input, context }) => {
    const { db } = context;
    const [feature] = await db
      .select()
      .from(features)
      .where(eq(features.id, input.featureId));
    if (!feature) throw new Error("Feature not found");

    const allQuarters = await getQuarterRowsWithMonths(db);
    const allMembers = await db.select().from(members).all();
    const fmRows = await db
      .select()
      .from(featureMonths)
      .where(eq(featureMonths.featureId, input.featureId));
    const maRows = await db
      .select()
      .from(memberMonthAllocations)
      .where(eq(memberMonthAllocations.featureId, input.featureId));

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

    return { feature, quarters: quarterData };
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
    const allFeatures = await db.select().from(features).all();
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
          featureAllocations: allFeatures
            .map((feature) => ({
              feature,
              capacity:
                monthAllocs.find((a) => a.featureId === feature.id)?.capacity ??
                0,
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
      featureId: z.number().int(),
      memberId: z.number().int(),
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const { featureId, memberId } = input;
    const allMonths = await db.select().from(months).all();
    for (const month of allMonths) {
      const existing = await db
        .select()
        .from(memberMonthAllocations)
        .where(
          and(
            eq(memberMonthAllocations.featureId, featureId),
            eq(memberMonthAllocations.monthId, month.id),
            eq(memberMonthAllocations.memberId, memberId),
          ),
        );
      if (existing.length === 0) {
        await db.insert(memberMonthAllocations).values({
          featureId,
          monthId: month.id,
          memberId,
          capacity: 0,
        });
      }
    }
  });

const allocationsRemoveMemberFromFeature = o
  .input(
    z.object({
      featureId: z.number().int(),
      memberId: z.number().int(),
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const { featureId, memberId } = input;

    const toRemove = await db
      .select()
      .from(memberMonthAllocations)
      .where(
        and(
          eq(memberMonthAllocations.featureId, featureId),
          eq(memberMonthAllocations.memberId, memberId),
        ),
      );

    if (toRemove.length === 0) return;

    await db
      .delete(memberMonthAllocations)
      .where(
        and(
          eq(memberMonthAllocations.featureId, featureId),
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
            eq(memberMonthAllocations.featureId, featureId),
            eq(memberMonthAllocations.monthId, monthId),
          ),
        );
      const newTotal = remaining.reduce((s, a) => s + a.capacity, 0);
      await upsertFeatureMonthTotal(db, featureId, monthId, newTotal);
    }
  });

const allocationsUpdateTotal = o
  .input(
    z.object({
      featureId: z.number().int(),
      totalCapacity: z.number().min(0),
      ...periodInput,
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const monthRows = await getTargetMonthRows(db, input);
    const currentTotals = await Promise.all(
      monthRows.map(async (month) => {
        const fm = await getFeatureMonthRow(db, input.featureId, month.id);
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
        input.featureId,
        month.id,
        newMonthTotals[index] ?? 0,
      );
    }

    return buildFeatureMonthsResult(
      db,
      input.featureId,
      monthRows.map((month) => month.id),
    );
  });

const allocationsPreviewMemberAllocation = o
  .input(
    z.object({
      featureId: z.number().int(),
      memberId: z.number().int(),
      capacity: z.number().min(0),
      ...periodInput,
    }),
  )
  .handler(async ({ input, context }) => {
    const monthRows = await getTargetMonthRows(context.db, input);
    const currentCapacities = await Promise.all(
      monthRows.map(async (month) => {
        const [row] = await context.db
          .select()
          .from(memberMonthAllocations)
          .where(
            and(
              eq(memberMonthAllocations.featureId, input.featureId),
              eq(memberMonthAllocations.monthId, month.id),
              eq(memberMonthAllocations.memberId, input.memberId),
            ),
          );
        return row?.capacity ?? 0;
      }),
    );
    const requestedCapacities =
      input.periodType === "month"
        ? [input.capacity]
        : splitTotalAcrossMonths(input.capacity, currentCapacities);
    const monthPreviews = await Promise.all(
      monthRows.map(async (month, index) => {
        const usedElsewhere = await getMemberUsageInMonth(
          context.db,
          input.memberId,
          month.id,
          input.featureId,
        );
        const requestedCapacity = requestedCapacities[index] ?? 0;
        const maxCap = await getMemberMaxCapacity(context.db, input.memberId);
        return {
          usedElsewhere,
          assignableCapacity: Math.max(0, maxCap - usedElsewhere),
          hasConflict:
            requestedCapacity <= maxCap &&
            usedElsewhere + requestedCapacity > maxCap + 0.000001,
        };
      }),
    );

    return {
      usedElsewhere: normalizeCapacity(
        monthPreviews.reduce((sum, preview) => sum + preview.usedElsewhere, 0),
      ),
      assignableCapacity: normalizeCapacity(
        monthPreviews.reduce(
          (sum, preview) => sum + preview.assignableCapacity,
          0,
        ),
      ),
      hasConflict: monthPreviews.some((preview) => preview.hasConflict),
    };
  });

const allocationsUpdateMemberAllocation = o
  .input(
    z.object({
      featureId: z.number().int(),
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
              eq(memberMonthAllocations.featureId, input.featureId),
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

    const affectedFeatureIds = new Set<number>([input.featureId]);
    for (const [index, month] of monthRows.entries()) {
      const affected = await updateSingleMemberMonthAllocation(
        db,
        input.featureId,
        month.id,
        input.memberId,
        newMonthCapacities[index] ?? 0,
        input.capacityConflictResolution,
      );
      for (const featureId of affected) affectedFeatureIds.add(featureId);
    }

    return buildMemberAllocationUpdateResult(
      db,
      input.featureId,
      monthRows.map((month) => month.id),
      affectedFeatureIds,
    );
  });

const allocationsMoveQuarter = o
  .input(
    z.object({
      featureId: z.number().int(),
      fromQuarterId: z.number().int(),
      toQuarterId: z.number().int(),
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const { featureId, fromQuarterId, toQuarterId } = input;
    const fromMonths = await getQuarterMonthRows(db, fromQuarterId);
    const toMonths = await getQuarterMonthRows(db, toQuarterId);
    if (fromMonths.length === 0 || toMonths.length === 0) return;

    for (const [index, fromMonth] of fromMonths.entries()) {
      const toMonth = toMonths[index];
      if (!toMonth) continue;

      const fromFm = await getFeatureMonthRow(db, featureId, fromMonth.id);
      if (fromFm) {
        const toFm = await getFeatureMonthRow(db, featureId, toMonth.id);
        await upsertFeatureMonthTotal(
          db,
          featureId,
          toMonth.id,
          (toFm?.totalCapacity ?? 0) + fromFm.totalCapacity,
        );
      }

      const fromAllocs = await db
        .select()
        .from(memberMonthAllocations)
        .where(
          and(
            eq(memberMonthAllocations.featureId, featureId),
            eq(memberMonthAllocations.monthId, fromMonth.id),
          ),
        );

      for (const alloc of fromAllocs) {
        const [toExisting] = await db
          .select()
          .from(memberMonthAllocations)
          .where(
            and(
              eq(memberMonthAllocations.featureId, featureId),
              eq(memberMonthAllocations.monthId, toMonth.id),
              eq(memberMonthAllocations.memberId, alloc.memberId),
            ),
          );

        const usedElsewhere = await getMemberUsageInMonth(
          db,
          alloc.memberId,
          toMonth.id,
          featureId,
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
            featureId,
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
            eq(memberMonthAllocations.featureId, featureId),
            eq(memberMonthAllocations.monthId, fromMonth.id),
          ),
        );
      await db
        .delete(featureMonths)
        .where(
          and(
            eq(featureMonths.featureId, featureId),
            eq(featureMonths.monthId, fromMonth.id),
          ),
        );
    }
  });

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const exportFeatureCSV = o.input(z.object({})).handler(async ({ context }) => {
  const { db } = context;
  const allFeatures = await db.select().from(features).all();
  const allQuarters = await getQuarterRowsWithMonths(db);
  const fmRows = await db.select().from(featureMonths).all();

  const header = [
    "機能",
    ...allQuarters.map((q) => `${q.year}-Q${q.quarter}`),
  ].join(",");
  const rows = allFeatures.map((feature) => {
    const cells = allQuarters.map((quarter) =>
      quarter.months.reduce((sum, month) => {
        const fm = fmRows.find(
          (r) => r.featureId === feature.id && r.monthId === month.id,
        );
        return sum + (fm?.totalCapacity ?? 0);
      }, 0),
    );
    return [feature.name, ...cells].join(",");
  });

  return [header, ...rows].join("\n");
});

const exportMemberCSV = o.input(z.object({})).handler(async ({ context }) => {
  const { db } = context;
  const allMembers = await db.select().from(members).all();
  const allQuarters = await getQuarterRowsWithMonths(db);
  const allFeatures = await db.select().from(features).all();
  const maRows = await db.select().from(memberMonthAllocations).all();

  const qHeaders = allQuarters.map((q) => `${q.year}-Q${q.quarter}`);
  const header = ["担当者", "機能", ...qHeaders].join(",");

  const rows: string[] = [];
  for (const member of allMembers) {
    for (const feature of allFeatures) {
      const cells = allQuarters.map((quarter) =>
        quarter.months.reduce((sum, month) => {
          const alloc = maRows.find(
            (r) =>
              r.memberId === member.id &&
              r.featureId === feature.id &&
              r.monthId === month.id,
          );
          return sum + (alloc?.capacity ?? 0);
        }, 0),
      );
      if (cells.some((c) => c > 0)) {
        rows.push([member.name, feature.name, ...cells].join(","));
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
    const allFeatures = await db.select().from(features).all();
    const allMembers = await db.select().from(members).all();
    const maRows = await db.select().from(memberMonthAllocations).all();

    const featureById = new Map(allFeatures.map((f) => [f.id, f.name]));
    const memberById = new Map(allMembers.map((m) => [m.id, m.name]));
    const monthById = new Map(allMonths.map((m) => [m.id, m]));

    const header = ["機能", "担当者", "キャパシティ", "月"].join(",");
    const rows = maRows
      .filter((r) => r.capacity > 0)
      .flatMap((r) => {
        const featureName = featureById.get(r.featureId) ?? "";
        const memberName = memberById.get(r.memberId) ?? "";
        const month = monthById.get(r.monthId);
        if (!month) return [];
        return [
          [
            featureName,
            memberName,
            r.capacity,
            monthLabel(month.year, month.month),
          ].join(","),
        ];
      });

    return [header, ...rows].join("\n");
  });

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const router = {
  features: {
    list: featuresList,
    create: featuresCreate,
    rename: featuresRename,
    delete: featuresDelete,
  },
  members: {
    list: membersList,
    create: membersCreate,
    rename: membersRename,
    delete: membersDelete,
    setMaxCapacity: membersSetMaxCapacity,
  },
  quarters: {
    list: quartersList,
    create: quartersCreate,
    delete: quartersDelete,
  },
  allocations: {
    getFeatureView: allocationsGetFeatureView,
    getMemberView: allocationsGetMemberView,
    assignMember: allocationsAssignMember,
    removeMemberFromFeature: allocationsRemoveMemberFromFeature,
    previewMemberAllocation: allocationsPreviewMemberAllocation,
    updateTotal: allocationsUpdateTotal,
    updateMemberAllocation: allocationsUpdateMemberAllocation,
    moveQuarter: allocationsMoveQuarter,
  },
  export: {
    featureCSV: exportFeatureCSV,
    memberCSV: exportMemberCSV,
    allocationCSV: exportAllocationCSV,
  },
};

export type AppRouter = typeof router;
