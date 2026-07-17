import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { flagSignature, listFlags, recordFlag, resolveFlag } from "./flags";

beforeEach(() => {
  process.env.GONDOLA_LAB_ROOT = mkdtempSync(path.join(os.tmpdir(), "gondola-flags-"));
});

test("a flag is always recorded and never silently dropped", async () => {
  const flag = await recordFlag({ reason: "Reels render as landscape, not vertical 9:16", conversationId: "c1" });
  assert.equal(flag.count, 1);
  assert.equal(flag.status, "open");
  const all = await listFlags();
  assert.equal(all.length, 1);
});

test("repeats of the same problem coalesce into a running count", async () => {
  await recordFlag({ reason: "Images do not render inline in the chat.", conversationId: "c1" });
  await recordFlag({ reason: "images do not render inline in the chat", conversationId: "c2" });
  const flags = await listFlags();
  assert.equal(flags.length, 1, "same problem should coalesce");
  assert.equal(flags[0].count, 2);
  assert.deepEqual(flags[0].conversationIds.sort(), ["c1", "c2"]);
});

test("distinct problems stay separate, and resolve marks one addressed", async () => {
  const a = await recordFlag({ reason: "Aspect ratio is wrong for banners" });
  await recordFlag({ reason: "Video never arrives after queuing" });
  assert.equal((await listFlags({ status: "open" })).length, 2);
  assert.equal(await resolveFlag(a.id), true);
  assert.equal((await listFlags({ status: "open" })).length, 1);
});

test("flagSignature normalizes case, punctuation, and whitespace", () => {
  assert.equal(flagSignature("Images DON'T  render!!"), flagSignature("images don't render"));
});
