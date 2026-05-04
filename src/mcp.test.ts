import { describe, expect, test } from "bun:test";
import { handleMcpRequest } from "./mcp";

describe("MCP handler", () => {
  test("initialize returns protocol info", async () => {
    const req = new Request("http://localhost:3000/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    const res = await handleMcpRequest(req, {} as never);
    const body = await res.json();

    expect(body.jsonrpc).toBe("2.0");
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.serverInfo.name).toBe("roadmap-tool-mcp");
  });

  test("tools/list exposes capacity tools", async () => {
    const req = new Request("http://localhost:3000/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    const res = await handleMcpRequest(req, {} as never);
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);

    expect(names).toContain("capacity_feature_view");
    expect(names).toContain("capacity_update_total");
  });
});
