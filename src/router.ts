import { os } from "@orpc/server";
import { and, eq, ne, sql } from "drizzle-orm";
import * as z from "zod";
import type { db as DbType } from "./db/index";
import {
  featureQuarters,
  features,
  memberAllocations,
  members,
  quarters,
} from "./db/schema";

type Context = { db: typeof DbType };
const o = os.$context<Context>();

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
  .input(
    z.object({
      name: z.string().min(1),
      icon: z.string().trim().max(64).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const [row] = await context.db
      .insert(members)
      .values({ name: input.name, icon: input.icon || null })
      .returning();
    return row;
  });

const membersRename = o
  .input(
    z.object({
      id: z.number().int(),
      name: z.string().min(1),
      icon: z.string().trim().max(64).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const [row] = await context.db
      .update(members)
      .set({ name: input.name, icon: input.icon || null })
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
  .handler(async ({ context }) => context.db.select().from(quarters).all());

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
    return row;
  });

const quartersDelete = o
  .input(z.object({ id: z.number().int() }))
  .handler(async ({ input, context }) => {
    await context.db.delete(quarters).where(eq(quarters.id, input.id));
  });

// ---------------------------------------------------------------------------
// Allocation helpers
// ---------------------------------------------------------------------------

async function getMemberUsageInQuarter(
  db: typeof DbType,
  memberId: number,
  quarterId: number,
  excludeFeatureId: number,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`sum(${memberAllocations.capacity})` })
    .from(memberAllocations)
    .where(
      and(
        eq(memberAllocations.memberId, memberId),
        eq(memberAllocations.quarterId, quarterId),
        ne(memberAllocations.featureId, excludeFeatureId),
      ),
    );
  return rows[0]?.total ?? 0;
}

async function getFeatureQuarterRow(
  db: typeof DbType,
  featureId: number,
  quarterId: number,
) {
  const rows = await db
    .select()
    .from(featureQuarters)
    .where(
      and(
        eq(featureQuarters.featureId, featureId),
        eq(featureQuarters.quarterId, quarterId),
      ),
    );
  return rows[0] ?? null;
}

async function buildFeatureQuarterResult(
  db: typeof DbType,
  featureId: number,
  quarterId: number,
) {
  const fq = await getFeatureQuarterRow(db, featureId, quarterId);
  const totalCapacity = fq?.totalCapacity ?? 0;

  const allocs = await db
    .select()
    .from(memberAllocations)
    .where(
      and(
        eq(memberAllocations.featureId, featureId),
        eq(memberAllocations.quarterId, quarterId),
      ),
    );

  const assignedTotal = allocs.reduce((s, a) => s + a.capacity, 0);
  return {
    featureId,
    quarterId,
    totalCapacity,
    unassignedCapacity: Math.max(0, totalCapacity - assignedTotal),
    memberAllocations: allocs.map((a) => ({
      memberId: a.memberId,
      capacity: a.capacity,
    })),
  };
}

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

    const allQuarters = await db.select().from(quarters).all();
    const allMembers = await db.select().from(members).all();
    const fqRows = await db
      .select()
      .from(featureQuarters)
      .where(eq(featureQuarters.featureId, input.featureId));
    const maRows = await db
      .select()
      .from(memberAllocations)
      .where(eq(memberAllocations.featureId, input.featureId));

    const quarterData = allQuarters.map((q) => {
      const fq = fqRows.find((r) => r.quarterId === q.id);
      const total = fq?.totalCapacity ?? 0;
      const qAllocs = maRows.filter((r) => r.quarterId === q.id);
      const assignedTotal = qAllocs.reduce((s, a) => s + a.capacity, 0);
      return {
        quarter: q,
        totalCapacity: total,
        unassignedCapacity: Math.max(0, total - assignedTotal),
        memberAllocations: allMembers
          .map((m) => ({
            member: m,
            capacity: qAllocs.find((a) => a.memberId === m.id)?.capacity ?? 0,
          }))
          .filter((a) => qAllocs.some((rec) => rec.memberId === a.member.id)),
      };
    });

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

    const allQuarters = await db.select().from(quarters).all();
    const allFeatures = await db.select().from(features).all();
    const maRows = await db
      .select()
      .from(memberAllocations)
      .where(eq(memberAllocations.memberId, input.memberId));

    const quarterData = allQuarters.map((q) => {
      const qAllocs = maRows.filter((r) => r.quarterId === q.id);
      const qTotal = qAllocs.reduce((s, a) => s + a.capacity, 0);
      return {
        quarter: q,
        totalCapacity: qTotal,
        featureAllocations: allFeatures
          .map((f) => ({
            feature: f,
            capacity: qAllocs.find((a) => a.featureId === f.id)?.capacity ?? 0,
          }))
          .filter((a) => a.capacity > 0),
      };
    });

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
    const allQuarters = await db.select().from(quarters).all();
    for (const q of allQuarters) {
      const existing = await db
        .select()
        .from(memberAllocations)
        .where(
          and(
            eq(memberAllocations.featureId, featureId),
            eq(memberAllocations.quarterId, q.id),
            eq(memberAllocations.memberId, memberId),
          ),
        );
      if (existing.length === 0) {
        await db
          .insert(memberAllocations)
          .values({ featureId, quarterId: q.id, memberId, capacity: 0 });
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
      .from(memberAllocations)
      .where(
        and(
          eq(memberAllocations.featureId, featureId),
          eq(memberAllocations.memberId, memberId),
        ),
      );

    if (toRemove.length === 0) return;

    await db
      .delete(memberAllocations)
      .where(
        and(
          eq(memberAllocations.featureId, featureId),
          eq(memberAllocations.memberId, memberId),
        ),
      );

    const affectedQuarterIds = [...new Set(toRemove.map((r) => r.quarterId))];
    for (const quarterId of affectedQuarterIds) {
      const remaining = await db
        .select()
        .from(memberAllocations)
        .where(
          and(
            eq(memberAllocations.featureId, featureId),
            eq(memberAllocations.quarterId, quarterId),
          ),
        );
      const newTotal = remaining.reduce((s, a) => s + a.capacity, 0);
      const existingFq = await getFeatureQuarterRow(db, featureId, quarterId);
      if (existingFq) {
        await db
          .update(featureQuarters)
          .set({ totalCapacity: newTotal })
          .where(
            and(
              eq(featureQuarters.featureId, featureId),
              eq(featureQuarters.quarterId, quarterId),
            ),
          );
      }
    }
  });

const allocationsUpdateTotal = o
  .input(
    z.object({
      featureId: z.number().int(),
      quarterId: z.number().int(),
      totalCapacity: z.number().min(0),
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const { featureId, quarterId, totalCapacity: newTotal } = input;

    // Upsert feature_quarters
    const existing = await getFeatureQuarterRow(db, featureId, quarterId);
    const oldTotal = existing?.totalCapacity ?? 0;

    if (existing) {
      await db
        .update(featureQuarters)
        .set({ totalCapacity: newTotal })
        .where(
          and(
            eq(featureQuarters.featureId, featureId),
            eq(featureQuarters.quarterId, quarterId),
          ),
        );
    } else {
      await db
        .insert(featureQuarters)
        .values({ featureId, quarterId, totalCapacity: newTotal });
    }

    // Proportionally redistribute member allocations
    const currentAllocs = await db
      .select()
      .from(memberAllocations)
      .where(
        and(
          eq(memberAllocations.featureId, featureId),
          eq(memberAllocations.quarterId, quarterId),
        ),
      );

    for (const alloc of currentAllocs) {
      const ratio = oldTotal > 0 ? alloc.capacity / oldTotal : 0;
      const candidate = ratio * newTotal;

      // Cap by member×quarter limit (1.0 across all features)
      const usedElsewhere = await getMemberUsageInQuarter(
        db,
        alloc.memberId,
        quarterId,
        featureId,
      );
      const cap = Math.max(0, 1.0 - usedElsewhere);
      const newValue = Math.min(candidate, cap);

      if (newValue <= 0) {
        await db
          .delete(memberAllocations)
          .where(eq(memberAllocations.id, alloc.id));
      } else {
        await db
          .update(memberAllocations)
          .set({ capacity: newValue })
          .where(eq(memberAllocations.id, alloc.id));
      }
    }

    return buildFeatureQuarterResult(db, featureId, quarterId);
  });

const allocationsUpdateMemberAllocation = o
  .input(
    z.object({
      featureId: z.number().int(),
      quarterId: z.number().int(),
      memberId: z.number().int(),
      capacity: z.number().min(0),
    }),
  )
  .handler(async ({ input, context }) => {
    const { db } = context;
    const { featureId, quarterId, memberId, capacity } = input;

    // Check member×quarter cap
    const usedElsewhere = await getMemberUsageInQuarter(
      db,
      memberId,
      quarterId,
      featureId,
    );
    const cap = Math.max(0, 1.0 - usedElsewhere);
    const capped = Math.min(capacity, cap);

    const existing = await db
      .select()
      .from(memberAllocations)
      .where(
        and(
          eq(memberAllocations.featureId, featureId),
          eq(memberAllocations.quarterId, quarterId),
          eq(memberAllocations.memberId, memberId),
        ),
      );

    if (capped <= 0) {
      if (existing.length > 0) {
        await db
          .delete(memberAllocations)
          .where(eq(memberAllocations.id, existing[0]!.id));
      }
    } else if (existing.length > 0) {
      await db
        .update(memberAllocations)
        .set({ capacity: capped })
        .where(eq(memberAllocations.id, existing[0]!.id));
    } else {
      await db
        .insert(memberAllocations)
        .values({ featureId, quarterId, memberId, capacity: capped });
    }

    const updatedAllocs = await db
      .select()
      .from(memberAllocations)
      .where(
        and(
          eq(memberAllocations.featureId, featureId),
          eq(memberAllocations.quarterId, quarterId),
        ),
      );
    const newTotal = updatedAllocs.reduce((s, a) => s + a.capacity, 0);

    const existingFq = await getFeatureQuarterRow(db, featureId, quarterId);
    if (existingFq) {
      await db
        .update(featureQuarters)
        .set({ totalCapacity: newTotal })
        .where(
          and(
            eq(featureQuarters.featureId, featureId),
            eq(featureQuarters.quarterId, quarterId),
          ),
        );
    } else if (newTotal > 0) {
      await db
        .insert(featureQuarters)
        .values({ featureId, quarterId, totalCapacity: newTotal });
    }

    return buildFeatureQuarterResult(db, featureId, quarterId);
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

    const fromFq = await getFeatureQuarterRow(db, featureId, fromQuarterId);
    if (!fromFq) return;

    // Upsert destination feature_quarters
    const toFq = await getFeatureQuarterRow(db, featureId, toQuarterId);
    const newTotal = (toFq?.totalCapacity ?? 0) + fromFq.totalCapacity;

    if (toFq) {
      await db
        .update(featureQuarters)
        .set({ totalCapacity: newTotal })
        .where(
          and(
            eq(featureQuarters.featureId, featureId),
            eq(featureQuarters.quarterId, toQuarterId),
          ),
        );
    } else {
      await db.insert(featureQuarters).values({
        featureId,
        quarterId: toQuarterId,
        totalCapacity: newTotal,
      });
    }

    // Move member allocations
    const fromAllocs = await db
      .select()
      .from(memberAllocations)
      .where(
        and(
          eq(memberAllocations.featureId, featureId),
          eq(memberAllocations.quarterId, fromQuarterId),
        ),
      );

    for (const alloc of fromAllocs) {
      const toExisting = await db
        .select()
        .from(memberAllocations)
        .where(
          and(
            eq(memberAllocations.featureId, featureId),
            eq(memberAllocations.quarterId, toQuarterId),
            eq(memberAllocations.memberId, alloc.memberId),
          ),
        );

      const usedElsewhere = await getMemberUsageInQuarter(
        db,
        alloc.memberId,
        toQuarterId,
        featureId,
      );
      const cap = Math.max(0, 1.0 - usedElsewhere);
      const merged = Math.min(
        (toExisting[0]?.capacity ?? 0) + alloc.capacity,
        cap,
      );

      if (toExisting.length > 0) {
        await db
          .update(memberAllocations)
          .set({ capacity: merged })
          .where(eq(memberAllocations.id, toExisting[0]!.id));
      } else {
        await db.insert(memberAllocations).values({
          featureId,
          quarterId: toQuarterId,
          memberId: alloc.memberId,
          capacity: merged,
        });
      }
    }

    // Remove source
    await db
      .delete(memberAllocations)
      .where(
        and(
          eq(memberAllocations.featureId, featureId),
          eq(memberAllocations.quarterId, fromQuarterId),
        ),
      );
    await db
      .delete(featureQuarters)
      .where(
        and(
          eq(featureQuarters.featureId, featureId),
          eq(featureQuarters.quarterId, fromQuarterId),
        ),
      );
  });

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const exportFeatureCSV = o.input(z.object({})).handler(async ({ context }) => {
  const { db } = context;
  const allFeatures = await db.select().from(features).all();
  const allQuarters = await db
    .select()
    .from(quarters)
    .orderBy(quarters.year, quarters.quarter)
    .all();
  const fqRows = await db.select().from(featureQuarters).all();

  const header = [
    "機能",
    ...allQuarters.map((q) => `${q.year}-Q${q.quarter}`),
  ].join(",");
  const rows = allFeatures.map((f) => {
    const cells = allQuarters.map((q) => {
      const fq = fqRows.find(
        (r) => r.featureId === f.id && r.quarterId === q.id,
      );
      return fq?.totalCapacity ?? 0;
    });
    return [f.name, ...cells].join(",");
  });

  return [header, ...rows].join("\n");
});

const exportMemberCSV = o.input(z.object({})).handler(async ({ context }) => {
  const { db } = context;
  const allMembers = await db.select().from(members).all();
  const allQuarters = await db
    .select()
    .from(quarters)
    .orderBy(quarters.year, quarters.quarter)
    .all();
  const allFeatures = await db.select().from(features).all();
  const maRows = await db.select().from(memberAllocations).all();

  // Header: 担当者, 機能, Q1, Q2, ...
  const qHeaders = allQuarters.map((q) => `${q.year}-Q${q.quarter}`);
  const header = ["担当者", "機能", ...qHeaders].join(",");

  const rows: string[] = [];
  for (const m of allMembers) {
    for (const f of allFeatures) {
      const cells = allQuarters.map((q) => {
        const alloc = maRows.find(
          (r) =>
            r.memberId === m.id && r.featureId === f.id && r.quarterId === q.id,
        );
        return alloc?.capacity ?? 0;
      });
      if (cells.some((c) => c > 0)) {
        rows.push([m.name, f.name, ...cells].join(","));
      }
    }
  }

  return [header, ...rows].join("\n");
});

const exportAllocationCSV = o
  .input(z.object({}))
  .handler(async ({ context }) => {
    const { db } = context;
    const allQuarters = await db
      .select()
      .from(quarters)
      .orderBy(quarters.year, quarters.quarter)
      .all();
    const allFeatures = await db.select().from(features).all();
    const allMembers = await db.select().from(members).all();
    const maRows = await db.select().from(memberAllocations).all();

    const featureById = new Map(allFeatures.map((f) => [f.id, f.name]));
    const memberById = new Map(allMembers.map((m) => [m.id, m.name]));
    const quarterById = new Map(allQuarters.map((q) => [q.id, q]));

    const monthsInQuarter = (year: number, quarter: number): string[] => {
      const startMonth = (quarter - 1) * 3 + 1;
      return Array.from({ length: 3 }, (_, i) => {
        const month = startMonth + i;
        return `${year}-${String(month).padStart(2, "0")}`;
      });
    };

    // Header: 機能, 担当者, キャパシティ, 月
    const header = ["機能", "担当者", "キャパシティ", "月"].join(",");
    const rows = maRows
      .filter((r) => r.capacity > 0)
      .flatMap((r) => {
        const featureName = featureById.get(r.featureId) ?? "";
        const memberName = memberById.get(r.memberId) ?? "";
        const q = quarterById.get(r.quarterId);
        if (!q) return [];
        return monthsInQuarter(q.year, q.quarter).map((month) =>
          [featureName, memberName, r.capacity, month].join(","),
        );
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
