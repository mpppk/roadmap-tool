import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { parseArgs } from "util";
import { getNameErrorMessage } from "./name-errors";
import type { AppRouter } from "./router";
import { getLocalBaseUrl } from "./runtime-config";

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`);
  }
}

let activeHelpText = "";
let activeCommandName = "";

function createHelpText(commandName: string): string {
  return `Usage:
  ${commandName} features list
  ${commandName} features add <name> [--epic-id <id>] [--description <text>] [--link <title=url> ...]
  ${commandName} features rename <id> <name> [--epic-id <id>] [--description <text>] [--link <title=url> ...] [--clear-description] [--clear-links]
  ${commandName} features move <id> --epic-id <id> [--before <feature-id>] [--after <feature-id>]
  ${commandName} features delete <id>
  ${commandName} features import <path|->

  ${commandName} epics list
  ${commandName} epics add <name> [--description <text>] [--link <title=url> ...]
  ${commandName} epics rename <id> <name> [--description <text>] [--link <title=url> ...] [--clear-description] [--clear-links]
  ${commandName} epics delete <id>
  ${commandName} epics move <id> [--before <epic-id>] [--after <epic-id>]
  ${commandName} epics import <path|->

  ${commandName} members list
  ${commandName} members add <name>
  ${commandName} members rename <id> <name>
  ${commandName} members delete <id>
  ${commandName} members import <path|-> [--mode append|sync]
  ${commandName} members capacity --year <year> --month <month>
`;
}

function createResourceHelpText(resource: string, commandName: string): string {
  switch (resource) {
    case "features":
      return `Usage: ${commandName} features <subcommand> [options]

Subcommands:
  list
  add <name> [--epic-id <id>] [--description <text>] [--link <title=url> ...]
  rename <id> <name> [--epic-id <id>] [--description <text>] [--link <title=url> ...] [--clear-description] [--clear-links]
  move <id> --epic-id <id> [--before <feature-id>] [--after <feature-id>]
  delete <id>
  import <path|->

Run '${commandName} features <subcommand> --help' for subcommand details.`;
    case "epics":
      return `Usage: ${commandName} epics <subcommand> [options]

Subcommands:
  list
  add <name> [--description <text>] [--link <title=url> ...]
  rename <id> <name> [--description <text>] [--link <title=url> ...] [--clear-description] [--clear-links]
  delete <id>
  move <id> [--before <epic-id>] [--after <epic-id>]
  import <path|->

Run '${commandName} epics <subcommand> --help' for subcommand details.`;
    case "members":
      return `Usage: ${commandName} members <subcommand> [options]

Subcommands:
  list
  add <name>
  rename <id> <name>
  delete <id>
  import <path|-> [--mode append|sync]
  capacity --year <year> --month <month>

Run '${commandName} members <subcommand> --help' for subcommand details.`;
    default:
      return activeHelpText;
  }
}

function createSubcommandHelpText(
  resource: string,
  command: string,
  commandName: string,
): string {
  switch (`${resource}.${command}`) {
    case "features.list":
      return `Usage: ${commandName} features list`;
    case "features.add":
      return `Usage: ${commandName} features add <name> [options]

  --epic-id <id>        Assign to this epic
  --description <text>  Feature description
  --link <title=url>    Add a link (repeatable)
  --help, -h            Show this help`;
    case "features.rename":
      return `Usage: ${commandName} features rename <id> <name> [options]

  --epic-id <id>        Assign to this epic
  --description <text>  Feature description
  --link <title=url>    Set links (repeatable)
  --clear-description   Clear existing description
  --clear-links         Clear existing links
  --help, -h            Show this help`;
    case "features.move":
      return `Usage: ${commandName} features move <id> --epic-id <id> [options]

  --epic-id <id>          Target epic (required)
  --before <feature-id>   Place before this feature
  --after <feature-id>    Place after this feature
  --help, -h              Show this help`;
    case "features.delete":
      return `Usage: ${commandName} features delete <id>`;
    case "features.import":
      return `Usage: ${commandName} features import <path|->

  <path|->    Path to CSV file, or '-' to read from stdin
  --help, -h  Show this help`;
    case "epics.list":
      return `Usage: ${commandName} epics list`;
    case "epics.add":
      return `Usage: ${commandName} epics add <name> [options]

  --description <text>  Epic description
  --link <title=url>    Add a link (repeatable)
  --help, -h            Show this help`;
    case "epics.rename":
      return `Usage: ${commandName} epics rename <id> <name> [options]

  --description <text>  Epic description
  --link <title=url>    Set links (repeatable)
  --clear-description   Clear existing description
  --clear-links         Clear existing links
  --help, -h            Show this help`;
    case "epics.delete":
      return `Usage: ${commandName} epics delete <id>`;
    case "epics.move":
      return `Usage: ${commandName} epics move <id> [options]

  --before <epic-id>  Place before this epic
  --after <epic-id>   Place after this epic
  --help, -h          Show this help`;
    case "epics.import":
      return `Usage: ${commandName} epics import <path|->

  <path|->    Path to CSV file, or '-' to read from stdin
  --help, -h  Show this help`;
    case "members.list":
      return `Usage: ${commandName} members list`;
    case "members.add":
      return `Usage: ${commandName} members add <name>`;
    case "members.rename":
      return `Usage: ${commandName} members rename <id> <name>`;
    case "members.delete":
      return `Usage: ${commandName} members delete <id>`;
    case "members.import":
      return `Usage: ${commandName} members import <path|-> [options]

  --mode append|sync  Import mode (default: append)
  --help, -h          Show this help`;
    case "members.capacity":
      return `Usage: ${commandName} members capacity [options]

  --year <year>    Year (required)
  --month <month>  Month 1-12 (required)
  --help, -h       Show this help`;
    default:
      return activeHelpText;
  }
}

function helpForResource(resource: string): never {
  console.log(createResourceHelpText(resource, activeCommandName));
  throw new CliExit(0);
}

function helpForSubcommand(resource: string, command: string): never {
  console.log(createSubcommandHelpText(resource, command, activeCommandName));
  throw new CliExit(0);
}

function createClient(baseUrl = getLocalBaseUrl()) {
  const link = new RPCLink({ url: `${baseUrl}/orpc` });
  return createORPCClient<RouterClient<AppRouter>>(link);
}

function help(): never {
  console.log(activeHelpText);
  throw new CliExit(0);
}

function usage(): never {
  console.error(activeHelpText);
  throw new CliExit(1);
}

async function readImportSource(args: string[]): Promise<string> {
  const source = args[0];
  if (!source || args.length !== 1 || source.startsWith("--")) usage();
  return source === "-"
    ? await Bun.stdin.text()
    : await Bun.file(source).text();
}

function parseFeatureMetadataFlags(args: string[]): {
  rest: string[];
  metadata: {
    epicId?: number;
    description?: string | null;
    links?: Array<{ title: string; url: string }>;
  };
} {
  const { values, positionals: rest } = parseArgs({
    args,
    options: {
      description: { type: "string" },
      link: { type: "string", multiple: true },
      "epic-id": { type: "string" },
      "clear-description": { type: "boolean" },
      "clear-links": { type: "boolean" },
    },
    strict: true,
    allowPositionals: true,
  });

  const clearDescription = values["clear-description"] ?? false;
  const clearLinks = values["clear-links"] ?? false;
  const description = values.description;
  const rawLinks = values.link ?? [];
  const linksSpecified = rawLinks.length > 0;
  const epicId = values["epic-id"] ? Number(values["epic-id"]) : undefined;

  if (clearDescription && description !== undefined) usage();
  if (clearLinks && linksSpecified) usage();

  const links = rawLinks.map((v: string) => {
    const sep = v.indexOf("=");
    if (sep <= 0 || sep === v.length - 1) usage();
    return { title: v.slice(0, sep), url: v.slice(sep + 1) };
  });

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

function printImportResult(result: {
  success: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
}) {
  console.log(`Imported: ${result.success}`);
  if (result.skipped > 0) console.log(`Skipped: ${result.skipped}`);
  if (result.errors.length > 0) {
    console.error(`Errors: ${result.errors.length}`);
    for (const error of result.errors) {
      const row = error.row > 0 ? `row ${error.row}: ` : "";
      console.error(`${row}${error.message}`);
    }
  }
}

export async function runCli(
  argv = process.argv.slice(2),
  commandName = "roadmap-tool",
) {
  activeHelpText = createHelpText(commandName);
  activeCommandName = commandName;
  const [resource, command, ...args] = argv;

  if (resource === "help" || resource === "--help" || resource === "-h") {
    help();
  }
  if (command === "--help" || command === "-h") {
    helpForResource(resource ?? "");
  }
  if (!resource || !command) usage();

  const orpc = createClient();

  if (resource === "features") {
    if (command === "list") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
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
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const { rest, metadata } = parseFeatureMetadataFlags(args);
      const name = rest[0];
      if (!name) usage();
      const f = await orpc.features.create({ name, ...metadata });
      console.log(`Created: ${f!.id}\t${f!.name}`);
    } else if (command === "rename") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const { rest, metadata } = parseFeatureMetadataFlags(args);
      const id = Number(rest[0]);
      const name = rest[1];
      if (!id || !name) usage();
      const f = await orpc.features.rename({ id, name, ...metadata });
      console.log(`Renamed: ${f!.id}\t${f!.name}`);
    } else if (command === "move") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const { values: moveValues, positionals: movePositionals } = parseArgs({
        args,
        options: {
          "epic-id": { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
        },
        strict: true,
        allowPositionals: true,
      });
      const id = Number(movePositionals[0]);
      const epicId = Number(moveValues["epic-id"]);
      const beforeId = moveValues.before
        ? Number(moveValues.before)
        : undefined;
      const afterId = moveValues.after ? Number(moveValues.after) : undefined;
      if (!id || !epicId) usage();
      if (beforeId !== undefined && afterId !== undefined) usage();
      const f = await orpc.features.move({ id, epicId, beforeId, afterId });
      console.log(`Moved: ${f!.id}\t${f!.name}`);
    } else if (command === "delete") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const id = Number(args[0]);
      if (!id) usage();
      await orpc.features.delete({ id });
      console.log(`Deleted: ${id}`);
    } else if (command === "import") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const csv = await readImportSource(args);
      const result = await orpc.import.featureMetadataCSVImport({ csv });
      console.log(`Imported: ${result.success}`);
    } else {
      usage();
    }
  } else if (resource === "epics") {
    if (command === "list") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
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
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const { rest, metadata } = parseFeatureMetadataFlags(args);
      const { epicId: _epicId, ...epicMetadata } = metadata;
      const name = rest[0];
      if (!name) usage();
      const epic = await orpc.epics.create({ name, ...epicMetadata });
      console.log(`Created: ${epic!.id}\t${epic!.name}`);
    } else if (command === "rename") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const { rest, metadata } = parseFeatureMetadataFlags(args);
      const { epicId: _epicId, ...epicMetadata } = metadata;
      const id = Number(rest[0]);
      const name = rest[1];
      if (!id || !name) usage();
      const epic = await orpc.epics.rename({ id, name, ...epicMetadata });
      console.log(`Renamed: ${epic!.id}\t${epic!.name}`);
    } else if (command === "delete") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const id = Number(args[0]);
      if (!id) usage();
      await orpc.epics.delete({ id });
      console.log(`Deleted: ${id}`);
    } else if (command === "move") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const { values: moveValues, positionals: movePositionals } = parseArgs({
        args,
        options: {
          before: { type: "string" },
          after: { type: "string" },
        },
        strict: true,
        allowPositionals: true,
      });
      const id = Number(movePositionals[0]);
      const beforeId = moveValues.before
        ? Number(moveValues.before)
        : undefined;
      const afterId = moveValues.after ? Number(moveValues.after) : undefined;
      if (!id) usage();
      if (beforeId !== undefined && afterId !== undefined) usage();
      await orpc.epics.move({ id, beforeId, afterId });
      console.log(`Moved: ${id}`);
    } else if (command === "import") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const csv = await readImportSource(args);
      const result = await orpc.import.epicMetadataCSVImport({ csv });
      console.log(`Imported: ${result.success}`);
    } else {
      usage();
    }
  } else if (resource === "members") {
    if (command === "list") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const items = await orpc.members.list({});
      if (items.length === 0) {
        console.log("(no members)");
      } else {
        for (const m of items) {
          const maxCap = m.maxCapacity ?? 1;
          console.log(`${m.id}\t${m.name}\t${maxCap}`);
        }
      }
    } else if (command === "add") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const name = args[0];
      if (!name) usage();
      const m = await orpc.members.create({ name });
      console.log(`Created: ${m!.id}\t${m!.name}`);
    } else if (command === "rename") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const id = Number(args[0]);
      const name = args[1];
      if (!id || !name) usage();
      const m = await orpc.members.rename({ id, name });
      console.log(`Renamed: ${m!.id}\t${m!.name}`);
    } else if (command === "delete") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const id = Number(args[0]);
      if (!id) usage();
      await orpc.members.delete({ id });
      console.log(`Deleted: ${id}`);
    } else if (command === "import") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const { values: importValues, positionals: importPositionals } =
        parseArgs({
          args,
          options: { mode: { type: "string", default: "append" } },
          strict: true,
          allowPositionals: true,
        });
      const mode = importValues.mode;
      if (mode !== "append" && mode !== "sync") usage();
      const tsv = await readImportSource(importPositionals);
      const result = await orpc.import.memberTSVImport({ tsv, mode });
      printImportResult(result);
    } else if (command === "capacity") {
      if (args.includes("--help") || args.includes("-h"))
        helpForSubcommand(resource, command);
      const { values: capValues } = parseArgs({
        args,
        options: {
          year: { type: "string" },
          month: { type: "string" },
        },
        strict: true,
        allowPositionals: false,
      });
      const year = Number(capValues.year);
      const month = Number(capValues.month);
      if (!year || !month || month < 1 || month > 12) usage();
      const items = await orpc.members.getCapacitySummary({ year, month });
      if (items.length === 0) {
        console.log("(no members)");
      } else {
        for (const m of items) {
          const maxCap = m.maxCapacity ?? 1;
          console.log(`${m.id}\t${m.name}\t${maxCap}\t${m.usedCapacity}`);
        }
      }
    } else {
      usage();
    }
  } else {
    usage();
  }
}

export function handleCliError(err: unknown): never {
  if (err instanceof CliExit) {
    process.exit(err.code);
  }

  const nameErrorMessage = getNameErrorMessage(err);
  if (nameErrorMessage) {
    console.error(`警告: ${nameErrorMessage}`);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
}

if (import.meta.main) {
  runCli(process.argv.slice(2), "bun src/cli.ts").catch(handleCliError);
}
