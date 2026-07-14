import assert from "node:assert/strict";
import test from "node:test";
import { createMcpAgentTools } from "./mcp";
import type { McpServerConfig } from "./workspace";

test("blocks an MCP mutation until a later user confirmation", async () => {
  const server: McpServerConfig = {
    id: "test-server",
    name: "Test server",
    transport: "http",
    url: "http://127.0.0.1:9/mcp",
    headers: {},
    env: {},
    tools: [{
      name: "delete_record",
      description: "Delete a record",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      readOnly: false,
      destructive: true,
    }],
    status: "connected",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  let currentMessage = "delete record 123";
  const [tool] = createMcpAgentTools([server], {
    sessionId: "test-session",
    currentUserMessage: () => currentMessage,
  });
  const execute = tool.execute as unknown as (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: { token?: string } }>;
  const first = await execute("call-1", { id: "123" }, new AbortController().signal);
  assert.match(first.content[0]?.text ?? "", /No external action was taken/);
  assert.match(first.details?.token ?? "", /^MCP-/);

  currentMessage = "try it again";
  const second = await execute("call-2", { id: "123" }, new AbortController().signal);
  assert.equal(second.details?.token, first.details?.token);
});
