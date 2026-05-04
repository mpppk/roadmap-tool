import {
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

export const features = sqliteTable("features", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const members = sqliteTable("members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  icon: text("icon"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const quarters = sqliteTable(
  "quarters",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    year: integer("year").notNull(),
    quarter: integer("quarter").notNull(), // 1-4
  },
  (t) => [unique().on(t.year, t.quarter)],
);

export const featureQuarters = sqliteTable(
  "feature_quarters",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    featureId: integer("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    quarterId: integer("quarter_id")
      .notNull()
      .references(() => quarters.id, { onDelete: "cascade" }),
    totalCapacity: real("total_capacity").notNull().default(0),
  },
  (t) => [unique().on(t.featureId, t.quarterId)],
);

export const memberAllocations = sqliteTable(
  "member_allocations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    featureId: integer("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    quarterId: integer("quarter_id")
      .notNull()
      .references(() => quarters.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    capacity: real("capacity").notNull().default(0),
  },
  (t) => [unique().on(t.featureId, t.quarterId, t.memberId)],
);
