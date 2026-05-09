import type { Config } from "drizzle-kit";
import { resolveDbPath } from "./src/db/path";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: resolveDbPath(),
  },
} satisfies Config;
