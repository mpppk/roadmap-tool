import { os } from "@orpc/server";
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

type Context = { db: typeof DbType };
const o = os.$context<Context>();

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
      .set({ totalCapacity })
      .where(eq(featureMonths.id, existing.id));
    return;
  }

  await db.insert(featureMonths).values({ featureId, monthId, totalCapacity });
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
    const cap = Math.max(0, 1.0 - usedElsewhere);
    const newValue = Math.min(candidate, cap);

    await db
      .update(memberMonthAllocations)
      .set({ capacity: newValue })
      .where(eq(memberMonthAllocations.id, alloc.id));
  }
}

async function updateSingleMemberMonthAllocation(
  db: typeof DbType,
  featureId: number,
  monthId: number,
  memberId: number,
  capacity: number,
) {
  const usedElsewhere = await getMemberUsageInMonth(
    db,
    memberId,
    monthId,
    featureId,
  );
  const cap = Math.max(0, 1.0 - usedElsewhere);
  const capped = Math.min(capacity, cap);

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

  if (existing.length > 0) {
    await db
      .update(memberMonthAllocations)
      .set({ capacity: capped })
      .where(eq(memberMonthAllocations.id, existing[0]!.id));
  } else {
    await db
      .insert(memberMonthAllocations)
      .values({ featureId, monthId, memberId, capacity: capped });
  }

  const updatedAllocs = await db
    .select()
    .from(memberMonthAllocations)
    .where(
      and(
        eq(memberMonthAllocations.featureId, featureId),
        eq(memberMonthAllocations.monthId, monthId),
      ),
    );
  const newTotal = updatedAllocs.reduce((s, a) => s + a.capacity, 0);
  await upsertFeatureMonthTotal(db, featureId, monthId, newTotal);
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
  .input(z.object({ name: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const [row] = await context.db
      .insert(features)
      .values({ name: input.name })
      .returning();
    return row;
  });

const featuresRename = o
  .input(z.object({ id: z.number().int(), name: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const [row] = await context.db
      .update(features)
      .set({ name: input.name })
      .where(eq(features.id, input.id))
      .returning();
    return row;
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
  .input(z.object({ name: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const [row] = await context.db
      .insert(members)
      .values({ name: input.name })
      .returning();
    return row;
  });

const membersRename = o
  .input(z.object({ id: z.number().int(), name: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const [row] = await context.db
      .update(members)
      .set({ name: input.name })
      .where(eq(members.id, input.id))
      .returning();
    return row;
  });

const membersDelete = o
  .input(z.object({ id: z.number().int() }))
  .handler(async ({ input, context }) => {
    await context.db.delete(members).where(eq(members.id, input.id));
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

// ---------------------------------------------------------------------------
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

const allocationsUpdateMemberAllocation = o
  .input(
    z.object({
      featureId: z.number().int(),
      memberId: z.number().int(),
      capacity: z.number().min(0),
      ...periodInput,
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

    for (const [index, month] of monthRows.entries()) {
      await updateSingleMemberMonthAllocation(
        db,
        input.featureId,
        month.id,
        input.memberId,
        newMonthCapacities[index] ?? 0,
      );
    }

    return buildFeatureMonthsResult(
      db,
      input.featureId,
      monthRows.map((month) => month.id),
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
        const cap = Math.max(0, 1.0 - usedElsewhere);
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
