import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const roadmaps = sqliteTable("roadmaps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const items = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roadmapId: integer("roadmap_id")
    .notNull()
    .references(() => roadmaps.id),
  title: text("title").notNull(),
  status: text("status", { enum: ["planned", "in-progress", "done"] })
    .notNull()
    .default("planned"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
