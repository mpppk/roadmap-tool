#!/usr/bin/env bun
/**
 * DB seed script — populates db.sqlite with sample data.
 *
 * Requires a running dev server. Start it first with `bun dev`, then run:
 *   PORT=<port> bun run db:seed
 *
 * This mirrors how the `roadmap-tool` CLI works — all import commands
 * connect to a running server via HTTP.
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
import { getLocalBaseUrl } from "../runtime-config";

const SEED_DIR = join(import.meta.dir, "../../seed");
const baseUrl = getLocalBaseUrl();
const orpc = createORPCClient<RouterClient<AppRouter>>(
  new RPCLink({ url: `${baseUrl}/orpc` }),
);

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

// 1. Epics — CLI import
console.log("Importing epics...");
await $`bun src/cli.ts epics import ${join(SEED_DIR, "epics.csv")}`;

// 2. Features — CLI import
console.log("Importing features...");
await $`bun src/cli.ts features import ${join(SEED_DIR, "features.csv")}`;

// 3. Members — CLI import
console.log("Importing members...");
await $`bun src/cli.ts members import ${join(SEED_DIR, "members.tsv")} --mode append`;

// 4. Quarters — no CLI import available; use oRPC client directly
console.log("Creating quarters...");
let quartersCreated = 0;
for (const q of nextQuarters(currentQuarter(), 4)) {
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

