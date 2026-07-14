import assert from "node:assert/strict";
import test from "node:test";
import { clearApiTraces, listApiTraces } from "./api-trace";
import { veniceFetch, veniceJson } from "./venice";

test("does not retry non-idempotent POST requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.VENICE_API_KEY;
  let calls = 0;
  process.env.VENICE_API_KEY = "test-key";
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("connection lost");
  };
  try {
    await assert.rejects(() => veniceFetch("/video/queue", { method: "POST" }, { trace: false }));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalKey;
  }
});

test("marks an invalid successful JSON response as an API trace error", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = "test-key";
  clearApiTraces();
  globalThis.fetch = async () => new Response("not json", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  try {
    await assert.rejects(() => veniceJson("/image/generate", { model: "test" }));
    const trace = listApiTraces()[0];
    assert.equal(trace?.status, "error");
    assert.match(trace?.error?.message ?? "", /json|unexpected/i);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiTraces();
    if (originalKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalKey;
  }
});
