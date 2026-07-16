import assert from "node:assert/strict";
import test from "node:test";
import { createEvalTools } from "./eval-tools";

function status(result: { details?: unknown }): string | undefined {
  return (result.details as { status?: string; ok?: boolean } | undefined)?.status;
}
function ok(result: { details?: unknown }): boolean | undefined {
  return (result.details as { ok?: boolean } | undefined)?.ok;
}

test("createEvalTools auto-confirms within budget and caps spend", async () => {
  const [image, analyze, video] = createEvalTools({ budgetUsd: 0.3 });

  // Analyzing before any image exists is a no-op the graders can see failed.
  assert.equal(ok(await analyze.execute("t", {})), false);

  // image (0.02) + analyze (0.005) + video (0.2) all fit inside 0.3.
  assert.equal(status(await image.execute("t", { prompt: "x" })), "ready");
  assert.equal(ok(await analyze.execute("t", {})), true);
  assert.equal(status(await video.execute("t", { prompt: "x" })), "ready");

  // A second video would exceed the budget, so it is refused.
  assert.equal(status(await video.execute("t", { prompt: "x" })), "error");
});

test("createEvalTools exposes the media tools the workflow policy relies on", () => {
  const names = createEvalTools({ budgetUsd: 1 }).map((tool) => tool.name).sort();
  assert.deepEqual(names, ["analyze_media", "generate_image", "generate_video"]);
});
