import assert from "node:assert/strict";
import { test } from "node:test";
import { selectResumableTasks, type MediaTask } from "./media-tasks";

function task(overrides: Partial<MediaTask>): MediaTask {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    providerTaskId: overrides.providerTaskId ?? `q-${overrides.id ?? "x"}`,
    kind: overrides.kind ?? "video",
    type: overrides.type ?? "video",
    status: overrides.status ?? "queued",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

test("selectResumableTasks returns only queued/running tasks", () => {
  const tasks = [
    task({ id: "a", status: "queued" }),
    task({ id: "b", status: "running" }),
    task({ id: "c", status: "succeeded" }),
    task({ id: "d", status: "failed" }),
    task({ id: "e", status: "cancelled" }),
  ];
  assert.deepEqual(selectResumableTasks(tasks).map((entry) => entry.id).sort(), ["a", "b"]);
});

test("selectResumableTasks scopes by conversationId", () => {
  const tasks = [
    task({ id: "a", status: "queued", conversationId: "conv-1" }),
    task({ id: "b", status: "running", conversationId: "conv-2" }),
    task({ id: "c", status: "queued", conversationId: "conv-1" }),
  ];
  assert.deepEqual(selectResumableTasks(tasks, { conversationId: "conv-1" }).map((entry) => entry.id).sort(), ["a", "c"]);
});

test("selectResumableTasks respects the limit", () => {
  const tasks = [
    task({ id: "a", status: "queued" }),
    task({ id: "b", status: "queued" }),
    task({ id: "c", status: "queued" }),
  ];
  assert.equal(selectResumableTasks(tasks, { limit: 2 }).length, 2);
});
