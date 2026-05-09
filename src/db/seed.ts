#!/usr/bin/env bun
/**
 * DB seed script — populates db.sqlite with sample data.
 *
 * Starts a temporary server internally, imports data via the CLI, then stops
 * the server. No running server required beforehand.
 *
 * Usage:
 *   bun run db:seed
 *   ROADMAP_DB=/path/to/other.sqlite bun run db:seed
 *
 * Epics, Features, and Members are imported via the CLI import commands.
 * Quarters (no CLI import available) are created via the oRPC client.
 */

import { $ } from "bun";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../router";

const SEED_DIR = join(import.meta.dir, "../../seed");
const SEED_PORT = 19876; // fixed internal port used only during seeding
const BASE_URL = `http://localhost:${SEED_PORT}`;

// Start a temporary server
const serverEnv = {
  ...process.env,
  PORT: String(SEED_PORT),
  HOST: "127.0.0.1",
  // Default to cwd db.sqlite (same as bun dev) unless overridden
  ROADMAP_DB: process.env.ROADMAP_DB ?? "db.sqlite",
};
const server = Bun.spawn(["bun", "src/index.ts"], {
  env: serverEnv,
  stdout: "ignore",
  stderr: "ignore",
});

// Wait until the server is ready (up to 10 seconds)
let ready = false;
for (let i = 0; i < 33; i++) {
  try {
    const res = await fetch(BASE_URL);
    if (res.ok || res.status < 500) {
      ready = true;
      break;
    }
  } catch {
    // not yet ready
  }
  await Bun.sleep(300);
}
if (!ready) {
  server.kill();
  console.error("Server failed to start within 10 seconds.");
  process.exit(1);
}

const cliEnv = { ...process.env, PORT: String(SEED_PORT) };

try {
  // 1. Epics — CLI import
  console.log("Importing epics...");
  await $`bun src/cli.ts epics import ${join(SEED_DIR, "epics.csv")}`.env(cliEnv);

  // 2. Features — CLI import
  console.log("Importing features...");
  await $`bun src/cli.ts features import ${join(SEED_DIR, "features.csv")}`.env(cliEnv);

  // 3. Members — CLI import
  console.log("Importing members...");
  await $`bun src/cli.ts members import ${join(SEED_DIR, "members.tsv")} --mode append`.env(cliEnv);

  // 4. Quarters — no CLI import available; use oRPC client directly
  console.log("Creating quarters...");
  const orpc = createORPCClient<RouterClient<AppRouter>>(
    new RPCLink({ url: `${BASE_URL}/orpc` }),
  );
  const quartersToCreate = nextQuarters(currentQuarter(), 4);
  let quartersCreated = 0;
  for (const q of quartersToCreate) {
    try {
      await orpc.quarters.create(q);
      console.log(`  Created ${q.year} Q${q.quarter}`);
      quartersCreated++;
    } catch {
      console.log(`  ${q.year} Q${q.quarter} already exists, skipping`);
    }
  }
  console.log(`  → ${quartersCreated} created`);

  console.log("\nSeed complete!");
} finally {
  server.kill();
}

function currentQuarter(): { year: number; quarter: number } {
  const now = new Date();
  return {
    year: now.getFullYear(),
    quarter: Math.ceil((now.getMonth() + 1) / 3),
  };
}

function nextQuarters(
  start: { year: number; quarter: number },
  count: number,
): Array<{ year: number; quarter: number }> {
  const result: Array<{ year: number; quarter: number }> = [];
  let { year, quarter } = start;
  for (let i = 0; i < count; i++) {
    result.push({ year, quarter });
    quarter += 1;
    if (quarter > 4) {
      quarter = 1;
      year += 1;
    }
  }
  return result;
}

