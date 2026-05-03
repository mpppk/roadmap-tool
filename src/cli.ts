import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "./router";

const BASE_URL = process.env.ROADMAP_URL ?? "http://localhost:3000";
const link = new RPCLink({ url: `${BASE_URL}/orpc` });
const orpc = createORPCClient<RouterClient<AppRouter>>(link);

function usage(): never {
  console.error(`Usage:
  bun cli.ts features list
  bun cli.ts features add <name>
  bun cli.ts features rename <id> <name>
  bun cli.ts features delete <id>

  bun cli.ts members list
  bun cli.ts members add <name>
  bun cli.ts members rename <id> <name>
  bun cli.ts members delete <id>

  bun cli.ts quarters list
  bun cli.ts quarters add <year> <quarter>
  bun cli.ts quarters delete <id>

  bun cli.ts allocations feature-view <featureId>
  bun cli.ts allocations member-view <memberId>
  bun cli.ts allocations update-total <featureId> <quarterId> <totalCapacity>
  bun cli.ts allocations update-member <featureId> <quarterId> <memberId> <capacity>
  bun cli.ts allocations move <featureId> <fromQuarterId> <toQuarterId>

  bun cli.ts export features
  bun cli.ts export members
`);
  process.exit(1);
}

const [, , resource, command, ...args] = process.argv;

if (!resource || !command) usage();

async function run() {
  if (resource === "features") {
    if (command === "list") {
      const items = await orpc.features.list({});
      if (items.length === 0) {
        console.log("(no features)");
      } else {
        for (const f of items) console.log(`${f.id}\t${f.name}`);
      }
    } else if (command === "add") {
      const name = args[0];
      if (!name) usage();
      const f = await orpc.features.create({ name });
      console.log(`Created: ${f!.id}\t${f!.name}`);
    } else if (command === "rename") {
      const id = Number(args[0]);
      const name = args[1];
      if (!id || !name) usage();
      const f = await orpc.features.rename({ id, name });
      console.log(`Renamed: ${f!.id}\t${f!.name}`);
    } else if (command === "delete") {
      const id = Number(args[0]);
      if (!id) usage();
      await orpc.features.delete({ id });
      console.log(`Deleted: ${id}`);
    } else {
      usage();
    }
  } else if (resource === "members") {
    if (command === "list") {
      const items = await orpc.members.list({});
      if (items.length === 0) {
        console.log("(no members)");
      } else {
        for (const m of items) console.log(`${m.id}\t${m.name}`);
      }
    } else if (command === "add") {
      const name = args[0];
      if (!name) usage();
      const m = await orpc.members.create({ name });
      console.log(`Created: ${m!.id}\t${m!.name}`);
    } else if (command === "rename") {
      const id = Number(args[0]);
      const name = args[1];
      if (!id || !name) usage();
      const m = await orpc.members.rename({ id, name });
      console.log(`Renamed: ${m!.id}\t${m!.name}`);
    } else if (command === "delete") {
      const id = Number(args[0]);
      if (!id) usage();
      await orpc.members.delete({ id });
      console.log(`Deleted: ${id}`);
    } else {
      usage();
    }
  } else if (resource === "quarters") {
    if (command === "list") {
      const items = await orpc.quarters.list({});
      if (items.length === 0) {
        console.log("(no quarters)");
      } else {
        for (const q of items) console.log(`${q.id}\t${q.year}-Q${q.quarter}`);
      }
    } else if (command === "add") {
      const year = Number(args[0]);
      const quarter = Number(args[1]);
      if (!year || !quarter) usage();
      const q = await orpc.quarters.create({ year, quarter });
      console.log(`Created: ${q!.id}\t${q!.year}-Q${q!.quarter}`);
    } else if (command === "delete") {
      const id = Number(args[0]);
      if (!id) usage();
      await orpc.quarters.delete({ id });
      console.log(`Deleted: ${id}`);
    } else {
      usage();
    }
  } else if (resource === "allocations") {
    if (command === "feature-view") {
      const featureId = Number(args[0]);
      if (!featureId) usage();
      const result = await orpc.allocations.getFeatureView({ featureId });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "member-view") {
      const memberId = Number(args[0]);
      if (!memberId) usage();
      const result = await orpc.allocations.getMemberView({ memberId });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "update-total") {
      const featureId = Number(args[0]);
      const quarterId = Number(args[1]);
      const totalCapacity = Number(args[2]);
      if (!featureId || !quarterId || args[2] === undefined) usage();
      const result = await orpc.allocations.updateTotal({
        featureId,
        quarterId,
        totalCapacity,
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "update-member") {
      const featureId = Number(args[0]);
      const quarterId = Number(args[1]);
      const memberId = Number(args[2]);
      const capacity = Number(args[3]);
      if (!featureId || !quarterId || !memberId || args[3] === undefined)
        usage();
      const result = await orpc.allocations.updateMemberAllocation({
        featureId,
        quarterId,
        memberId,
        capacity,
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "move") {
      const featureId = Number(args[0]);
      const fromQuarterId = Number(args[1]);
      const toQuarterId = Number(args[2]);
      if (!featureId || !fromQuarterId || !toQuarterId) usage();
      await orpc.allocations.moveQuarter({
        featureId,
        fromQuarterId,
        toQuarterId,
      });
      console.log(`Moved: featureId=${featureId} from=${fromQuarterId} to=${toQuarterId}`);
    } else {
      usage();
    }
  } else if (resource === "export") {
    if (command === "features") {
      const csv = await orpc.export.featureCSV({});
      console.log(csv);
    } else if (command === "members") {
      const csv = await orpc.export.memberCSV({});
      console.log(csv);
    } else {
      usage();
    }
  } else {
    usage();
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
