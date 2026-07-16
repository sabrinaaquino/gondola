import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { LIVE_CONFIG_VERSION, recordLiveTrace } from "./ingest";
import { listTraces } from "./store";

test("recordLiveTrace writes a draft trace the Lab can read back", async () => {
  process.env.GONDOLA_LAB_ROOT = await mkdtemp(path.join(tmpdir(), "gondola-lab-ingest-"));

  const trace = await recordLiveTrace({
    goal: "  make   a poster  ",
    modelsSelected: ["zai-org-glm-5-2", "zai-org-glm-5-2"],
    modelCosts: [
      { model: "zai-org-glm-5-2", costUsd: 0.0012 },
      { model: "zai-org-glm-5-2", costUsd: 0.0008 },
    ],
    toolCalls: [
      { tool: "generate_image", ok: true },
      { tool: "search_web", ok: false, error: "timeout" },
    ],
    latencyMs: 1234.6,
    completed: true,
    finalOutput: "done",
  });

  assert.ok(trace, "a trace should be returned");
  // Observation only: live traces are drafts, never finalized by the runtime.
  assert.equal(trace.finalized, false);
  // Live runs are tagged so the Lab can tell them from champion/challenger runs.
  assert.equal(trace.configVersionId, LIVE_CONFIG_VERSION);
  // Goal is normalized (collapsed whitespace, trimmed).
  assert.equal(trace.goal, "make a poster");
  // Duplicate model ids are de-duplicated; cost is summed across calls.
  assert.deepEqual(trace.modelsSelected, ["zai-org-glm-5-2"]);
  assert.equal(trace.costUsd, 0.002);
  assert.equal(trace.latencyMs, 1235);
  // Failed tools surface as errors; media tools become artifacts.
  assert.deepEqual(trace.toolErrors, ["timeout"]);
  assert.equal(trace.artifacts.length, 1);
  assert.equal(trace.artifacts[0].kind, "image");
  assert.equal(trace.artifacts[0].approved, false);

  const traces = await listTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].runId, trace.runId);
  assert.equal(traces[0].goal, "make a poster");
});
