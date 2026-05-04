import { RPCHandler } from "@orpc/server/fetch";
import { serve } from "bun";
import { db } from "./db/index";
import index from "./index.html";
import { router } from "./router";
import { handleMcpRequest } from "./mcp";

const rpcHandler = new RPCHandler(router);

const server = serve({
  routes: {
    "/orpc/*": async (req) => {
      const result = await rpcHandler.handle(req, {
        prefix: "/orpc",
        context: { db },
      });
      if (result.matched) return result.response;
      return new Response("Not found", { status: 404 });
    },
    "/mcp": async (req) => {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleMcpRequest(req, db);
    },
    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);
