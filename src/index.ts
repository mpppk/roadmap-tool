import { RPCHandler } from "@orpc/server/fetch";
import { serve } from "bun";
import index from "./index.html";
import { router } from "./router";

const rpcHandler = new RPCHandler(router);

const server = serve({
  routes: {
    "/orpc/*": async (req) => {
      const result = await rpcHandler.handle(req, {
        prefix: "/orpc",
        context: {},
      });
      if (result.matched) return result.response;
      return new Response("Not found", { status: 404 });
    },
    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);
