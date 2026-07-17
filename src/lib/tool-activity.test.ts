import assert from "node:assert/strict";
import test from "node:test";
import { describeToolActivity, redactToolArgs } from "./tool-activity";

test("file and command activities say exactly what is happening", () => {
  assert.deepEqual(describeToolActivity("edit_file", { path: "src/app.ts" }), {
    label: "Editing a file", detail: "src/app.ts", category: "files", risk: "medium", mutates: true,
  });
  const command = describeToolActivity("run_command", { command: "npm test" });
  assert.equal(command.label, "Running a command");
  assert.equal(command.detail, "npm test");
  assert.equal(command.risk, "high");
});

test("activity descriptions cover Lab and unknown connected tools without a vague Venice fallback", () => {
  assert.equal(describeToolActivity("propose_harness_change", { reason: "timeouts repeat" }).label, "Consulting Gondola Lab");
  assert.equal(describeToolActivity("mcp_linear_create_issue").label, "Linear Create Issue");
  assert.equal(describeToolActivity("custom_capability").label, "Custom Capability");
});

test("user-visible tool args redact secret-looking fields", () => {
  assert.deepEqual(redactToolArgs({ path: "/tmp/a", apiKey: "secret", nested: { authorization: "Bearer token" } }), {
    path: "/tmp/a", apiKey: "[redacted]", nested: { authorization: "[redacted]" },
  });
});

test("guarded Venice mutations are labeled high risk while reads stay read-only", () => {
  const guarded = describeToolActivity("venice_api", { method: "DELETE", path: "/api_keys/key-1" });
  assert.equal(guarded.mutates, true);
  assert.equal(guarded.risk, "high");
  const read = describeToolActivity("venice_api", { method: "GET", path: "/models" });
  assert.equal(read.mutates, false);
  assert.equal(read.risk, undefined);
});
