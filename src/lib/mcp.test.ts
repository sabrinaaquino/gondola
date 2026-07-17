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

test("routes MCP mutations through the shared approval card when the runtime provides it", async () => {
  const server: McpServerConfig = {
    id: "test-server-card",
    name: "Issue tracker",
    transport: "http",
    url: "http://127.0.0.1:9/mcp",
    headers: {}, env: {}, status: "connected",
    tools: [{
      name: "create_issue", description: "Create an issue",
      inputSchema: { type: "object", properties: { title: { type: "string" }, apiKey: { type: "string" } } },
      readOnly: false, destructive: false,
    }],
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
  let requested: { tool: string; summary: string } | undefined;
  const [tool] = createMcpAgentTools([server], {
    sessionId: "card-session",
    currentUserMessage: () => "create it",
    requestApproval: async (input) => {
      requested = input;
      return { approved: false, approvalId: "approval-1", risk: "medium" };
    },
  });
  const result = await tool.execute("call-card", { title: "Fix bug", apiKey: "do-not-show" }, new AbortController().signal) as {
    details?: Record<string, unknown>;
  };
  assert.equal(result.details?.needsConfirmation, true);
  assert.equal(result.details?.approvalId, "approval-1");
  assert.equal(requested?.tool, "mcp_issue_tracker_create_issue");
  assert.match(requested?.summary ?? "", /Fix bug/);
  assert.doesNotMatch(requested?.summary ?? "", /do-not-show/);
});
