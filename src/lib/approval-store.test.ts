import assert from "node:assert/strict";
import { test } from "node:test";
import { guardedToolList, hasSessionGrant, toolRisk, type SessionGrant } from "./approval-store";

const grants: SessionGrant[] = [
  { conversationId: "c1", tool: "run_command", grantedAt: "2026-07-16T00:00:00.000Z", grantedBy: "owner" },
  { conversationId: "c1", tool: "delete_path", grantedAt: "2026-07-16T00:00:00.000Z", grantedBy: "owner" },
];

test("hasSessionGrant matches a granted conversation + tool", () => {
  assert.equal(hasSessionGrant(grants, "c1", "run_command"), true);
  assert.equal(hasSessionGrant(grants, "c1", "delete_path"), true);
});

test("hasSessionGrant is scoped to the conversation", () => {
  assert.equal(hasSessionGrant(grants, "c2", "run_command"), false);
});

test("hasSessionGrant is false for ungranted tools and empty grants", () => {
  assert.equal(hasSessionGrant(grants, "c1", "write_file"), false);
  assert.equal(hasSessionGrant([], "c1", "run_command"), false);
});

test("guarded tools declare a risk level and non-guarded tools have none", () => {
  assert.equal(toolRisk("delete_path"), "high");
  assert.equal(toolRisk("run_command"), "high");
  assert.equal(toolRisk("write_file"), "medium");
  assert.equal(toolRisk("read_file"), undefined);
  const list = guardedToolList();
  assert.ok(list.some((entry) => entry.tool === "delete_path" && entry.risk === "high"));
  assert.ok(list.length >= 4);
});
