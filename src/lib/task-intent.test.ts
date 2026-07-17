import assert from "node:assert/strict";
import test from "node:test";
import { shouldPersistTask } from "./task-intent";

test("actionable implementation and repair requests enter persistent mode", () => {
  assert.equal(shouldPersistTask("Please fix the broken approval flow and verify it"), true);
  assert.equal(shouldPersistTask("Implement the new settings panel"), true);
  assert.equal(shouldPersistTask("Research the repository and write a report"), true);
});

test("conversation, approval replies, commands, and paid media stay single-turn", () => {
  assert.equal(shouldPersistTask("hello"), false);
  assert.equal(shouldPersistTask("Allow that action"), false);
  assert.equal(shouldPersistTask("/goal ship the feature"), false);
  assert.equal(shouldPersistTask("Create a video of the ocean"), false);
});
