import { RPCHandler } from "@orpc/server/fetch";
import { serve } from "bun";
import { db } from "./db/index";
import index from "./index.html";
import { router } from "./router";
import { getPort } from "./runtime-config";

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
      "/orpc/*": async (req) => {
        const result = await rpcHandler.handle(req, {
          prefix: "/orpc",
          context: { db },
        });
        if (result.matched) return result.response;
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
