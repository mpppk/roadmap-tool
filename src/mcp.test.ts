import { describe, expect, test } from "bun:test";
import { handleMcpRequest } from "./mcp";

function parseSseJson(text: string) {
  const line = text
    .split("\n")
    .find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`No SSE data payload: ${text}`);
  return JSON.parse(line.replace("data: ", ""));
}

describe("MCP handler", () => {
  test("initialize returns protocol info", async () => {
    const req = new Request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });

    const res = await handleMcpRequest(req, {} as never);
    const body = parseSseJson(await res.text());

    expect(body.jsonrpc).toBe("2.0");
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("roadmap-tool-mcp");
  });

  test("tools/list exposes capacity tools", async () => {
    const req = new Request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    const res = await handleMcpRequest(req, {} as never);
    const body = parseSseJson(await res.text());
    const names = body.result.tools.map((t: { name: string }) => t.name);

    expect(names).toContain("capacity_feature_view");
    expect(names).toContain("capacity_update_total");
  });
});
