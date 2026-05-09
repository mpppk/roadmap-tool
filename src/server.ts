import { RPCHandler } from "@orpc/server/fetch";
import { serve } from "bun";
import { db } from "./db/index";
import index from "./index.html";
import { router } from "./router";
import { getPort } from "./runtime-config";

const DATA_CHANGE_EVENT = "roadmap-data-changed";
const ROADMAP_CLIENT_ID_HEADER = "x-roadmap-client-id";

type DataChangePayload = {
  version: number;
  sourceClientId?: string;
};

type DataChangeClient = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  keepAliveTimer: Timer;
};

const encoder = new TextEncoder();
const dataChangeClients = new Set<DataChangeClient>();
let dataChangeVersion = 0;

const dataChangeProcedures = new Set([
  "history.restore",
  "initiatives.create",
  "initiatives.rename",
  "initiatives.delete",
  "initiatives.move",
  "epics.create",
  "epics.rename",
  "epics.delete",
  "epics.move",
  "members.create",
  "members.rename",
  "members.delete",
  "members.setMaxCapacity",
  "quarters.create",
  "quarters.delete",
  "allocations.assignMember",
  "allocations.removeMemberFromEpic",
  "allocations.updateTotal",
  "allocations.updateMemberAllocation",
  "allocations.moveQuarter",
]);

function encodeSSE(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function encodeSSEComment(comment: string): Uint8Array {
  return encoder.encode(`: ${comment}\n\n`);
}

export function orpcProcedureNameFromPathname(pathname: string): string | null {
  const normalized = pathname.replace(/^\/orpc\/?/, "").replace(/^\/|\/$/g, "");
  if (!normalized) return null;
  return normalized.split("/").map(decodeURIComponent).join(".");
}

export function shouldNotifyDataChange(pathname: string): boolean {
  const procedureName = orpcProcedureNameFromPathname(pathname);
  if (!procedureName) return false;
  return (
    dataChangeProcedures.has(procedureName) ||
    procedureName.startsWith("import.")
  );
}

function notifyDataChange(sourceClientId?: string): void {
  dataChangeVersion++;
  const payload: DataChangePayload = { version: dataChangeVersion };
  if (sourceClientId) payload.sourceClientId = sourceClientId;

  for (const client of dataChangeClients) {
    try {
      client.controller.enqueue(encodeSSE(DATA_CHANGE_EVENT, payload));
    } catch {
      clearInterval(client.keepAliveTimer);
      dataChangeClients.delete(client);
    }
  }
}

function createDataChangeEventResponse(req: Request): Response {
  let client: DataChangeClient | undefined;

  const cleanup = () => {
    if (!client) return;
    clearInterval(client.keepAliveTimer);
    dataChangeClients.delete(client);
    client = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = {
        controller,
        keepAliveTimer: setInterval(() => {
          try {
            controller.enqueue(encodeSSEComment("keep-alive"));
          } catch {
            cleanup();
          }
        }, 30_000),
      };
      dataChangeClients.add(client);
      controller.enqueue(encodeSSEComment("connected"));
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);

  try {
    await fetch(`http://localhost:${port}/`, {
      method: "HEAD",
      signal: controller.signal,
    });
    throw new Error(`Port ${port} is already in use.`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Port ${port} is already in use.`
    ) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Port ${port} is already in use.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function startServer(port = getPort()) {
  await assertPortAvailable(port);

  const rpcHandler = new RPCHandler(router);
  const server = serve({
    port,
    routes: {
      "/events/data-changes": (req, server) => {
        server.timeout(req, 0);
        return createDataChangeEventResponse(req);
      },
      "/orpc/*": async (req) => {
        const pathname = new URL(req.url).pathname;
        const result = await rpcHandler.handle(req, {
          prefix: "/orpc",
          context: { db },
        });
        if (result.matched) {
          if (
            result.response.status >= 200 &&
            result.response.status < 300 &&
            shouldNotifyDataChange(pathname)
          ) {
            const sourceClientId =
              req.headers.get(ROADMAP_CLIENT_ID_HEADER) ?? undefined;
            notifyDataChange(sourceClientId);
          }
          return result.response;
        }
        return new Response("Not found", { status: 404 });
      },
      "/*": index,
    },
    development:
      process.env.NODE_ENV !== "production"
        ? {
            hmr: true,
            console: true,
          }
        : false,
  });

  console.log(`Server running at ${server.url}`);
  return server;
}
