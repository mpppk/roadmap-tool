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

  bun cli.ts members list
  bun cli.ts members add <name>
  bun cli.ts members rename <id> <name>
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
