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
`;
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
  const [resource, command, ...args] = argv;

  if (resource === "help" || resource === "--help" || resource === "-h") {
    help();
  }
  if (!resource || !command) usage();

  const orpc = createClient();

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
      const id = Number(args[0]);
      if (!id) usage();
      await orpc.features.delete({ id });
      console.log(`Deleted: ${id}`);
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
    } else if (command === "delete") {
      const id = Number(args[0]);
      if (!id) usage();
      await orpc.members.delete({ id });
      console.log(`Deleted: ${id}`);
    } else if (command === "import") {
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
