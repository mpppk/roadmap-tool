import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { getNameErrorMessage } from "./name-errors";
import type { AppRouter } from "./router";

const BASE_URL = process.env.ROADMAP_URL ?? "http://localhost:3000";
const link = new RPCLink({ url: `${BASE_URL}/orpc` });
const orpc = createORPCClient<RouterClient<AppRouter>>(link);

const HELP_TEXT = `Usage:
  bun cli.ts features list
  bun cli.ts features add <name> [--epic-id <id>] [--description <text>] [--link <title=url> ...]
  bun cli.ts features rename <id> <name> [--epic-id <id>] [--description <text>] [--link <title=url> ...] [--clear-description] [--clear-links]
  bun cli.ts features move <id> --epic-id <id> [--before <feature-id>] [--after <feature-id>]
  bun cli.ts features import <path|->

  bun cli.ts epics list
  bun cli.ts epics add <name> [--description <text>] [--link <title=url> ...]
  bun cli.ts epics rename <id> <name> [--description <text>] [--link <title=url> ...] [--clear-description] [--clear-links]
  bun cli.ts epics delete <id>
  bun cli.ts epics move <id> [--before <epic-id>] [--after <epic-id>]
  bun cli.ts epics import <path|->

  bun cli.ts members list
  bun cli.ts members add <name>
  bun cli.ts members rename <id> <name>
`;

function help(): never {
  console.log(HELP_TEXT);
  process.exit(0);
}

function usage(): never {
  console.error(HELP_TEXT);
  process.exit(1);
}

const [, , resource, command, ...args] = process.argv;

if (resource === "help" || resource === "--help" || resource === "-h") help();
if (!resource || !command) usage();

async function readImportSource(args: string[]): Promise<string> {
  const source = args[0];
  if (!source || args.length !== 1 || source.startsWith("--")) usage();
  return source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
}

function parseFeatureMetadataFlags(args: string[]): {
  rest: string[];
  metadata: {
    epicId?: number;
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
  let epicId: number | undefined;

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
    if (arg === "--epic-id") {
      const value = Number(args[++i]);
      if (!value) usage();
      epicId = value;
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
      ...(epicId !== undefined ? { epicId } : {}),
      ...(clearDescription ? { description: null } : {}),
      ...(linksSpecified ? { links } : {}),
      ...(clearLinks ? { links: [] } : {}),
    },
  };
}

function parseMoveFlags(args: string[]): {
  rest: string[];
  epicId?: number;
  beforeId?: number;
  afterId?: number;
} {
  const rest: string[] = [];
  let epicId: number | undefined;
  let beforeId: number | undefined;
  let afterId: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--epic-id") {
      epicId = Number(args[++i]);
      if (!epicId) usage();
      continue;
    }
    if (arg === "--before") {
      beforeId = Number(args[++i]);
      if (!beforeId) usage();
      continue;
    }
    if (arg === "--after") {
      afterId = Number(args[++i]);
      if (!afterId) usage();
      continue;
    }
    rest.push(arg);
  }
  if (beforeId !== undefined && afterId !== undefined) usage();
  return { rest, epicId, beforeId, afterId };
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
          console.log(
            `${f.id}\t${f.epicId}\t${f.name}\t${description}\t${linkCount} links`,
          );
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
    } else if (command === "move") {
      const { rest, epicId, beforeId, afterId } = parseMoveFlags(args);
      const id = Number(rest[0]);
      if (!id || !epicId) usage();
      const f = await orpc.features.move({ id, epicId, beforeId, afterId });
      console.log(`Moved: ${f!.id}\t${f!.name}`);
    } else if (command === "import") {
      const csv = await readImportSource(args);
      const result = await orpc.import.featureMetadataCSVImport({ csv });
      console.log(`Imported: ${result.success}`);
    } else {
      usage();
    }
  } else if (resource === "epics") {
    if (command === "list") {
      const items = await orpc.epics.list({});
      if (items.length === 0) {
        console.log("(no epics)");
      } else {
        for (const epic of items) {
          const linkCount = epic.links.length;
          const description = epic.description ?? "";
          console.log(
            `${epic.id}\t${epic.name}\t${description}\t${linkCount} links${epic.isDefault ? "\tdefault" : ""}`,
          );
        }
      }
    } else if (command === "add") {
      const { rest, metadata } = parseFeatureMetadataFlags(args);
      const { epicId: _epicId, ...epicMetadata } = metadata;
      const name = rest[0];
      if (!name) usage();
      const epic = await orpc.epics.create({ name, ...epicMetadata });
      console.log(`Created: ${epic!.id}\t${epic!.name}`);
    } else if (command === "rename") {
      const { rest, metadata } = parseFeatureMetadataFlags(args);
      const { epicId: _epicId, ...epicMetadata } = metadata;
      const id = Number(rest[0]);
      const name = rest[1];
      if (!id || !name) usage();
      const epic = await orpc.epics.rename({ id, name, ...epicMetadata });
      console.log(`Renamed: ${epic!.id}\t${epic!.name}`);
    } else if (command === "delete") {
      const id = Number(args[0]);
      if (!id) usage();
      await orpc.epics.delete({ id });
      console.log(`Deleted: ${id}`);
    } else if (command === "move") {
      const { rest, beforeId, afterId } = parseMoveFlags(args);
      const id = Number(rest[0]);
      if (!id) usage();
      await orpc.epics.move({ id, beforeId, afterId });
      console.log(`Moved: ${id}`);
    } else if (command === "import") {
      const csv = await readImportSource(args);
      const result = await orpc.import.epicMetadataCSVImport({ csv });
      console.log(`Imported: ${result.success}`);
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
