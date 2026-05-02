import { os } from "@orpc/server";
import * as z from "zod";

export const router = {
  hello: {
    get: os
      .input(z.object({}))
      .handler(async () => ({ message: "Hello, world!", method: "GET" })),

    put: os
      .input(z.object({}))
      .handler(async () => ({ message: "Hello, world!", method: "PUT" })),

    helloName: os
      .input(z.object({ name: z.string().min(1) }))
      .handler(async ({ input }) => ({ message: `Hello, ${input.name}!` })),
  },
};

export type AppRouter = typeof router;
