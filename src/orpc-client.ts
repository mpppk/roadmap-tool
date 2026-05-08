import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "./router";

export const roadmapClientId = crypto.randomUUID();

const link = new RPCLink({
  url: `${window.location.origin}/orpc`,
  headers: () => ({
    "x-roadmap-client-id": roadmapClientId,
  }),
});

export const orpc = createORPCClient<RouterClient<AppRouter>>(link);
