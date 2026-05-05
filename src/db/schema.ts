import { sql } from "drizzle-orm";
import {
  check,
  integer,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const features = sqliteTable(
  "features",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    check("features_name_trimmed_check", sql`${t.name} = trim(${t.name})`),
    check("features_name_not_empty_check", sql`length(${t.name}) > 0`),
    uniqueIndex("features_name_trim_unique").on(sql`trim(${t.name})`),
  ],
);

export const members = sqliteTable(
  "members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    maxCapacity: real("max_capacity"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    check("members_name_trimmed_check", sql`${t.name} = trim(${t.name})`),
    check("members_name_not_empty_check", sql`length(${t.name}) > 0`),
    uniqueIndex("members_name_trim_unique").on(sql`trim(${t.name})`),
    check(
      "members_max_capacity_check",
      sql`${t.maxCapacity} IS NULL OR (${t.maxCapacity} > 0 AND ${t.maxCapacity} <= 1)`,
    ),
  ],
);

export const quarters = sqliteTable(
  "quarters",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    year: integer("year").notNull(),
    quarter: integer("quarter").notNull(), // 1-4
  },
  (t) => [unique().on(t.year, t.quarter)],
);

export const months = sqliteTable(
  "months",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    year: integer("year").notNull(),
    month: integer("month").notNull(), // 1-12
    quarterId: integer("quarter_id")
      .notNull()
      .references(() => quarters.id, { onDelete: "cascade" }),
  },
  (t) => [unique().on(t.year, t.month), unique().on(t.quarterId, t.month)],
);

export const featureMonths = sqliteTable(
  "feature_months",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    featureId: integer("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    monthId: integer("month_id")
      .notNull()
      .references(() => months.id, { onDelete: "cascade" }),
    totalCapacity: real("total_capacity").notNull().default(0),
  },
  (t) => [unique().on(t.featureId, t.monthId)],
);

export const memberMonthAllocations = sqliteTable(
  "member_month_allocations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    featureId: integer("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    monthId: integer("month_id")
      .notNull()
      .references(() => months.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    capacity: real("capacity").notNull().default(0),
  },
  (t) => [unique().on(t.featureId, t.monthId, t.memberId)],
);
