import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { and, eq, sql } from "drizzle-orm";
import * as z from "zod";
import type { db as DbType } from "./db/index";
import { featureQuarters, features, memberAllocations, quarters } from "./db/schema";

async function getFeatureCapacities(db: typeof DbType) {
  const allFeatures = await db.select().from(features).orderBy(features.id).all();
  const allQuarters = await db
    .select()
    .from(quarters)
    .orderBy(quarters.year, quarters.quarter)
    .all();
  const totals = await db.select().from(featureQuarters).all();
  const assigned = await db
    .select({
      featureId: memberAllocations.featureId,
      quarterId: memberAllocations.quarterId,
      total: sql<number>`sum(${memberAllocations.capacity})`,
    })
    .from(memberAllocations)
    .groupBy(memberAllocations.featureId, memberAllocations.quarterId)
    .all();

  const assignedMap = new Map(
    assigned.map((r) => [`${r.featureId}:${r.quarterId}`, r.total ?? 0]),
  );
  const totalMap = new Map(
    totals.map((r) => [`${r.featureId}:${r.quarterId}`, r.totalCapacity]),
  );

  return {
    quarters: allQuarters,
    features: allFeatures.map((f) => ({
      ...f,
      quarters: allQuarters.map((q) => {
        const key = `${f.id}:${q.id}`;
        const totalCapacity = totalMap.get(key) ?? 0;
        const assignedCapacity = assignedMap.get(key) ?? 0;
        return {
          quarterId: q.id,
          totalCapacity,
          assignedCapacity,
          unassignedCapacity: Math.max(0, totalCapacity - assignedCapacity),
        };
      }),
    })),
  };
}

function createMcpServer(db: typeof DbType, appOrigin: string) {
  const server = new McpServer({
    name: "roadmap-tool-mcp",
    version: "0.1.0",
  });

  registerAppResource(
    server,
    "capacity-ui",
    "ui://capacity/view",
    {
      title: "Feature Capacity UI",
      description: "既存のFeatureキャパシティUIを埋め込んで表示します。",
    },
    async () => ({
      contents: [
        {
          uri: "ui://capacity/view",
          mimeType: "text/html",
          text: `<!doctype html><html><body style=\"margin:0\"><iframe src=\"${appOrigin}/\" style=\"width:100vw;height:100vh;border:0\"></iframe></body></html>`,
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "capacity_feature_view",
    {
      title: "Feature Capacity View",
      description: "Featureベースのキャパシティ情報を取得します。",
      inputSchema: { featureId: z.number().optional() },
      _meta: { ui: { resourceUri: "ui://capacity/view" } },
    },
    async ({ featureId }) => {
      const data = await getFeatureCapacities(db);
      return {
        content: [{ type: "text", text: "Featureキャパシティ情報を取得しました。" }],
        structuredContent: {
          app: "capacity",
          featureId: featureId ?? null,
          uiUrl: `${appOrigin}/`,
          ...data,
        },
      };
    },
  );

  registerAppTool(
    server,
    "capacity_update_total",
    {
      title: "Update Feature Quarter Capacity",
      description: "Feature×Quarterの合計キャパシティを更新します。",
      _meta: {},
      inputSchema: {
        featureId: z.number(),
        quarterId: z.number(),
        totalCapacity: z.number().min(0),
      },
    },
    async ({ featureId, quarterId, totalCapacity }) => {
      const existing = await db
        .select()
        .from(featureQuarters)
        .where(
          and(
            eq(featureQuarters.featureId, featureId),
            eq(featureQuarters.quarterId, quarterId),
          ),
        );
      if (existing.length > 0) {
        await db
          .update(featureQuarters)
          .set({ totalCapacity })
          .where(
            and(
              eq(featureQuarters.featureId, featureId),
              eq(featureQuarters.quarterId, quarterId),
            ),
          );
      } else {
        await db.insert(featureQuarters).values({ featureId, quarterId, totalCapacity });
      }

      return {
        content: [{ type: "text", text: "キャパシティを更新しました。" }],
      };
    },
  );

  return server;
}

export async function handleMcpRequest(req: Request, db: typeof DbType) {
  const appOrigin = new URL(req.url).origin;
  const server = createMcpServer(db, appOrigin);
  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  return transport.handleRequest(req);
}
