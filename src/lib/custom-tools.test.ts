import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  approveCustomTool,
  createCustomTool,
  deleteCustomTool,
  listApprovedCustomTools,
  listCustomTools,
  materializeCustomTools,
  normalizeToolName,
  type CustomToolDef,
} from "./custom-tools";
import { MAX_SUBAGENT_DEPTH, scopeToolsForWorker } from "./subagent";

function fakeTool(name: string, label?: string): AgentTool {
  return {
    name,
    label: label ?? name,
    description: name,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "" }], details: {} };
    },
  };
}

test("normalizeToolName produces safe snake_case", () => {
  assert.equal(normalizeToolName("My Cool Ability!"), "my_cool_ability");
  assert.equal(normalizeToolName("  spaced  out  "), "spaced_out");
});

test("creates, lists, and deletes a custom ability (roundtrip)", async () => {
  const agentId = `test-${crypto.randomUUID()}`;
  try {
    const def = await createCustomTool({
      agentId,
      name: "My Ability!",
      description: "  Do   a thing  ",
      playbook: "Step 1. Do it.",
      inputs: ["Topic", "topic", "9bad"],
      allowedTools: ["search_web", "search_web", "delete_path"],
    });
    assert.equal(def.name, "my_ability");
    assert.equal(def.description, "Do a thing");
    // Governance: a newly authored ability is pending, never live.
    assert.equal(def.status, "pending");
    // "Topic"/"topic" collapse; "9bad" is dropped for starting with a digit.
    assert.deepEqual(def.inputs, ["topic"]);
    // The author's allow-list is preserved verbatim; safety scoping happens at
    // run time, not at authoring time.
    assert.deepEqual(def.allowedTools, ["search_web", "delete_path"]);

    const listed = await listCustomTools(agentId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "my_ability");

    const removed = await deleteCustomTool({ agentId, name: "my_ability" });
    assert.equal(removed, true);
    assert.equal((await listCustomTools(agentId)).length, 0);
  } finally {
    await deleteCustomTool({ agentId, name: "my_ability" }).catch(() => undefined);
  }
});

test("rejects invalid names, duplicates, and reserved names", async () => {
  const agentId = `test-${crypto.randomUUID()}`;
  try {
    await assert.rejects(() => createCustomTool({ agentId, name: "!", description: "d", playbook: "playbook text" }));
    await assert.rejects(() => createCustomTool({
      agentId,
      name: "search_web",
      description: "shadow a built-in",
      playbook: "playbook text",
      reservedNames: ["search_web"],
    }));

    await createCustomTool({ agentId, name: "unique_one", description: "ok", playbook: "playbook text" });
    await assert.rejects(() => createCustomTool({ agentId, name: "unique_one", description: "again", playbook: "playbook text" }));
  } finally {
    await deleteCustomTool({ agentId, name: "unique_one" }).catch(() => undefined);
  }
});

test("abilities are pending until approved, and only approved ones are listed as live", async () => {
  const agentId = `test-${crypto.randomUUID()}`;
  try {
    await createCustomTool({ agentId, name: "gated_ability", description: "needs approval", playbook: "Do the thing." });

    // Pending on creation: not part of the live (approved) set.
    assert.equal((await listApprovedCustomTools(agentId)).length, 0);
    assert.equal((await listCustomTools(agentId, "pending")).length, 1);

    const approved = await approveCustomTool({ agentId, name: "gated_ability", approvedBy: "owner" });
    assert.ok(approved);
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvedBy, "owner");

    // Now it counts as live.
    const live = await listApprovedCustomTools(agentId);
    assert.equal(live.length, 1);
    assert.equal(live[0].name, "gated_ability");
    assert.equal((await listCustomTools(agentId, "pending")).length, 0);

    // Approving a missing ability is a no-op (returns undefined).
    assert.equal(await approveCustomTool({ agentId, name: "does_not_exist" }), undefined);
  } finally {
    await deleteCustomTool({ agentId, name: "gated_ability" }).catch(() => undefined);
  }
});

test("materializes a def into a callable tool exposing its inputs", () => {
  const def: CustomToolDef = {
    id: "1",
    agentId: "a",
    name: "digest",
    description: "Summarize a topic",
    inputs: ["topic", "depth"],
    playbook: "Research then summarize.",
    allowedTools: ["search_web"],
    status: "approved",
    createdAt: new Date().toISOString(),
  };
  const [tool] = materializeCustomTools([def], {
    model: "test-model",
    parentDepth: 0,
    maxDepth: MAX_SUBAGENT_DEPTH,
    buildWorkerTools: () => [],
    reserveWorker: () => true,
  });
  assert.equal(tool.name, "digest");
  assert.equal(tool.executionMode, "sequential");
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  assert.deepEqual(Object.keys(properties).sort(), ["depth", "topic"]);
});

test("a maxed-out ability refuses to spawn instead of recursing", async () => {
  const def: CustomToolDef = {
    id: "2",
    agentId: "a",
    name: "team",
    description: "Coordinate a team",
    inputs: [],
    playbook: "Delegate widely.",
    allowedTools: ["orchestrate"],
    status: "approved",
    createdAt: new Date().toISOString(),
  };
  const [tool] = materializeCustomTools([def], {
    model: "test-model",
    parentDepth: MAX_SUBAGENT_DEPTH,
    maxDepth: MAX_SUBAGENT_DEPTH,
    buildWorkerTools: () => [],
    reserveWorker: () => true,
  });
  const result = await tool.execute("call", {}, undefined, undefined);
  const details = result.details as { blocked?: string } | undefined;
  assert.equal(details?.blocked, "max_depth");
});

test("scopeToolsForWorker gates coordination and abilities by depth", () => {
  const tools = [
    fakeTool("read_file"),
    fakeTool("delete_path"),
    fakeTool("run_command"),
    fakeTool("generate_image"),
    fakeTool("delegate_task"),
    fakeTool("orchestrate"),
    fakeTool("my_ability", "Ability: my_ability"),
  ];

  const shallow = scopeToolsForWorker(tools, 0).map((tool) => tool.name);
  assert.ok(shallow.includes("read_file"));
  assert.ok(!shallow.includes("delete_path"));
  assert.ok(!shallow.includes("run_command"));
  assert.ok(!shallow.includes("generate_image"));
  assert.ok(shallow.includes("delegate_task"));
  assert.ok(shallow.includes("orchestrate"));
  assert.ok(shallow.includes("my_ability"));

  const deep = scopeToolsForWorker(tools, MAX_SUBAGENT_DEPTH).map((tool) => tool.name);
  assert.ok(deep.includes("read_file"));
  assert.ok(!deep.includes("delegate_task"));
  assert.ok(!deep.includes("orchestrate"));
  assert.ok(!deep.includes("my_ability"));
});
