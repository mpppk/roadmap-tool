#!/usr/bin/env bun
/**
 * DB seed script — populates a fresh db.sqlite with sample data.
 *
 * Usage:
 *   bun run db:seed          # uses ROADMAP_DB (defaults to db.sqlite in cwd)
 *   ROADMAP_DB=/path/to.sqlite bun run db:seed
 *
 * The script is idempotent: re-running it skips already-existing records.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./index";
import { router } from "../router";

const SEED_DIR = join(import.meta.dir, "../../seed");

function readSeedFile(filename: string): string {
  return readFileSync(join(SEED_DIR, filename), "utf-8");
}

/** Returns the current year and quarter number (1-4). */
function currentQuarter(): { year: number; quarter: number } {
  const now = new Date();
  return {
    year: now.getFullYear(),
    quarter: Math.ceil((now.getMonth() + 1) / 3),
  };
}

/** Returns an array of {year, quarter} for the next `count` quarters starting from the given one. */
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

async function main() {
  const ctx = { db };

  // 1. Epics
  console.log("Importing epics...");
  const epicResult = await router.import.epicMetadataCSVImport.callable({
    context: ctx,
  })({ csv: readSeedFile("epics.csv") });
  console.log(`  → ${epicResult.success} created / updated`);

  // 2. Features
  console.log("Importing features...");
  const featureResult = await router.import.featureMetadataCSVImport.callable({
    context: ctx,
  })({ csv: readSeedFile("features.csv") });
  console.log(`  → ${featureResult.success} created / updated`);

  // 3. Members
  console.log("Importing members...");
  const memberResult = await router.import.memberTSVImport.callable({
    context: ctx,
  })({ tsv: readSeedFile("members.tsv"), mode: "append" });
  console.log(
    `  → ${memberResult.success} created / updated, ${memberResult.skipped} skipped`,
  );

  // 4. Quarters: current + next 3 quarters (4 total)
  console.log("Creating quarters...");
  const quartersToCreate = nextQuarters(currentQuarter(), 4);
  const createQuarter = router.quarters.create.callable({ context: ctx });
  let quartersCreated = 0;
  for (const q of quartersToCreate) {
    try {
      await createQuarter(q);
      console.log(`  → Created ${q.year} Q${q.quarter}`);
      quartersCreated++;
    } catch {
      console.log(`  → ${q.year} Q${q.quarter} already exists, skipping`);
    }
  }
  console.log(`  → ${quartersCreated} created`);

  console.log("\nSeed complete!");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
