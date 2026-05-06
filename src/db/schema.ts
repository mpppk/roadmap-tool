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

export const epics = sqliteTable(
  "epics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    position: integer("position").notNull().default(0),
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    check("epics_name_trimmed_check", sql`${t.name} = trim(${t.name})`),
    check("epics_name_not_empty_check", sql`length(${t.name}) > 0`),
    check("epics_position_check", sql`${t.position} >= 0`),
    uniqueIndex("epics_name_trim_unique").on(sql`trim(${t.name})`),
    uniqueIndex("epics_default_unique")
      .on(t.isDefault)
      .where(sql`${t.isDefault} = 1`),
  ],
);

export const epicLinks = sqliteTable(
  "epic_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    epicId: integer("epic_id")
      .notNull()
      .references(() => epics.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    unique().on(t.epicId, t.position),
    unique().on(t.epicId, t.url),
    check("epic_links_title_not_empty_check", sql`length(${t.title}) > 0`),
    check("epic_links_url_not_empty_check", sql`length(${t.url}) > 0`),
    check("epic_links_position_check", sql`${t.position} >= 0`),
  ],
);

export const features = sqliteTable(
  "features",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    epicId: integer("epic_id")
      .notNull()
      .references(() => epics.id, { onDelete: "restrict" }),
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    check("features_name_trimmed_check", sql`${t.name} = trim(${t.name})`),
    check("features_name_not_empty_check", sql`length(${t.name}) > 0`),
    check("features_position_check", sql`${t.position} >= 0`),
    uniqueIndex("features_name_trim_unique").on(sql`trim(${t.name})`),
    unique().on(t.epicId, t.position),
  ],
);

export const featureLinks = sqliteTable(
  "feature_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    featureId: integer("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    unique().on(t.featureId, t.position),
    unique().on(t.featureId, t.url),
    check("feature_links_title_not_empty_check", sql`length(${t.title}) > 0`),
    check("feature_links_url_not_empty_check", sql`length(${t.url}) > 0`),
    check("feature_links_position_check", sql`${t.position} >= 0`),
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
