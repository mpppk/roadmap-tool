import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { getNameErrorMessage } from "./name-errors";
import type { AppRouter } from "./router";

const BASE_URL = process.env.ROADMAP_URL ?? "http://localhost:3000";
const link = new RPCLink({ url: `${BASE_URL}/orpc` });
const orpc = createORPCClient<RouterClient<AppRouter>>(link);

function usage(): never {
  console.error(`Usage:
  bun cli.ts features list
  bun cli.ts features add <name> [--description <text>] [--link <title=url> ...]
  bun cli.ts features rename <id> <name> [--description <text>] [--link <title=url> ...] [--clear-description] [--clear-links]

  bun cli.ts members list
  bun cli.ts members add <name>
  bun cli.ts members rename <id> <name>
`);
  process.exit(1);
}

const [, , resource, command, ...args] = process.argv;

if (!resource || !command) usage();

function parseFeatureMetadataFlags(args: string[]): {
  rest: string[];
  metadata: {
    description?: string | null;
    links?: Array<{ title: string; url: string }>;
  };
} {
  const rest: string[] = [];
  const links: Array<{ title: string; url: string }> = [];
  let description: string | null | undefined;
  let linksSpecified = false;
  let clearDescription = false;
  let clearLinks = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--description") {
      const value = args[++i];
      if (value === undefined) usage();
      description = value;
      continue;
    }
    if (arg === "--link") {
      const value = args[++i];
      if (value === undefined) usage();
      const sep = value.indexOf("=");
      if (sep <= 0 || sep === value.length - 1) usage();
      linksSpecified = true;
      links.push({
        title: value.slice(0, sep),
        url: value.slice(sep + 1),
      });
      continue;
    }
    if (arg === "--clear-description") {
      clearDescription = true;
      continue;
    }
    if (arg === "--clear-links") {
      clearLinks = true;
      continue;
    }
    rest.push(arg);
  }

  if (clearDescription && description !== undefined) usage();
  if (clearLinks && linksSpecified) usage();

  return {
    rest,
    metadata: {
      ...(description !== undefined ? { description } : {}),
      ...(clearDescription ? { description: null } : {}),
      ...(linksSpecified ? { links } : {}),
      ...(clearLinks ? { links: [] } : {}),
    },
  };
}

async function run() {
  if (resource === "features") {
    if (command === "list") {
      const items = await orpc.features.list({});
      if (items.length === 0) {
        console.log("(no features)");
      } else {
        for (const f of items) {
          const linkCount = f.links.length;
          const description = f.description ?? "";
          console.log(`${f.id}\t${f.name}\t${description}\t${linkCount} links`);
        }
      }
    } else if (command === "add") {
      const { rest, metadata } = parseFeatureMetadataFlags(args);
      const name = rest[0];
      if (!name) usage();
      const f = await orpc.features.create({ name, ...metadata });
      console.log(`Created: ${f!.id}\t${f!.name}`);
    } else if (command === "rename") {
      const { rest, metadata } = parseFeatureMetadataFlags(args);
      const id = Number(rest[0]);
      const name = rest[1];
      if (!id || !name) usage();
      const f = await orpc.features.rename({ id, name, ...metadata });
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
  const nameErrorMessage = getNameErrorMessage(err);
  if (nameErrorMessage) {
    console.error(`警告: ${nameErrorMessage}`);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
