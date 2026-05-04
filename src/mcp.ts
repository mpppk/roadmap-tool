import { and, eq, sql } from "drizzle-orm";
import type { db as DbType } from "./db/index";
import { featureQuarters, features, memberAllocations, quarters } from "./db/schema";

type JsonRpcRequest = {
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

function jsonRpc(id: JsonRpcRequest["id"], result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

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

export async function handleMcpRequest(req: Request, db: typeof DbType) {
  const body = (await req.json()) as JsonRpcRequest;
  const id = body.id ?? null;

  if (body.method === "initialize") {
    return jsonRpc(id, {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "roadmap-tool-mcp", version: "0.1.0" },
      capabilities: { tools: {} },
    });
  }

  if (body.method === "tools/list") {
    return jsonRpc(id, {
      tools: [
        {
          name: "capacity_feature_view",
          description:
            "Featureベースのキャパシティ情報を取得し、既存UIをMCP AppsのAI Agent上で開くための情報を返します。",
          inputSchema: {
            type: "object",
            properties: {
              featureId: { type: "number", description: "対象Feature ID（任意）" },
            },
            additionalProperties: false,
          },
        },
        {
          name: "capacity_update_total",
          description: "Feature×Quarterの合計キャパシティを更新します。",
          inputSchema: {
            type: "object",
            properties: {
              featureId: { type: "number" },
              quarterId: { type: "number" },
              totalCapacity: { type: "number", minimum: 0 },
            },
            required: ["featureId", "quarterId", "totalCapacity"],
            additionalProperties: false,
          },
        },
      ],
    });
  }

  if (body.method === "tools/call") {
    const toolName = body.params?.name;
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;

    if (toolName === "capacity_feature_view") {
      const data = await getFeatureCapacities(db);
      const featureId = typeof args.featureId === "number" ? args.featureId : undefined;
      const uiUrl = new URL(req.url);
      uiUrl.pathname = "/";
      if (featureId) uiUrl.searchParams.set("featureId", String(featureId));

      return jsonRpc(id, {
        content: [
          {
            type: "text",
            text: "既存のFeatureキャパシティUIを利用して、表示・編集できます。",
          },
        ],
        structuredContent: {
          app: "capacity",
          uiUrl: uiUrl.toString(),
          ...data,
        },
      });
    }

    if (toolName === "capacity_update_total") {
      const featureId = Number(args.featureId);
      const quarterId = Number(args.quarterId);
      const totalCapacity = Number(args.totalCapacity);
      if (
        !Number.isFinite(featureId) ||
        !Number.isFinite(quarterId) ||
        !Number.isFinite(totalCapacity) ||
        totalCapacity < 0
      ) {
        return jsonRpcError(id, -32602, "Invalid arguments");
      }

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
        await db.insert(featureQuarters).values({
          featureId,
          quarterId,
          totalCapacity,
        });
      }

      return jsonRpc(id, {
        content: [{ type: "text", text: "キャパシティを更新しました。" }],
      });
    }

    return jsonRpcError(id, -32601, "Unknown tool");
  }

  return jsonRpcError(id, -32601, "Method not found");
}
