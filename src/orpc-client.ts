import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "./router";

const link = new RPCLink({ url: `${window.location.origin}/orpc` });

export const orpc = createORPCClient<RouterClient<AppRouter>>(link);
