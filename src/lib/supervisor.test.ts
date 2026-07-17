import assert from "node:assert/strict";
import test from "node:test";
import { chooseRecoveryStrategy, diagnoseFailure, explanationFor, runSupervisorRecovery } from "./supervisor";

test("diagnoseFailure classifies each common failure signature", () => {
  assert.equal(diagnoseFailure("Request timed out after 120000ms").category, "timeout");
  assert.equal(diagnoseFailure(new Error("The stream was aborted")).category, "timeout");
  assert.equal(diagnoseFailure("429 Too Many Requests").category, "rate_limit");
  assert.equal(diagnoseFailure("401 Unauthorized: invalid api key").category, "auth");
  assert.equal(diagnoseFailure("400 Bad Request: maximum context length exceeded").category, "bad_request");
  assert.equal(diagnoseFailure("503 Service Unavailable").category, "server");
  assert.equal(diagnoseFailure("Venice model glm returned an empty reply.").category, "empty");
  assert.equal(diagnoseFailure("fetch failed: ECONNRESET").category, "network");
  assert.equal(diagnoseFailure("something inexplicable happened").category, "generic");
});

test("diagnoseFailure always returns a non-empty reason and suggestion", () => {
  for (const input of ["timed out", "429", "nonsense", "", null, undefined]) {
    const diagnosis = diagnoseFailure(input);
    assert.ok(diagnosis.reason.length > 0, `reason for ${JSON.stringify(input)}`);
    assert.ok(diagnosis.suggestion.length > 0, `suggestion for ${JSON.stringify(input)}`);
  }
});

test("explanationFor mentions the fallback attempt only when a retry happened", () => {
  const diagnosis = diagnoseFailure("timed out");
  assert.ok(explanationFor(diagnosis, true).includes("lighter fallback"));
  assert.ok(!explanationFor(diagnosis, false).includes("lighter fallback"));
  // Always ends with the actionable suggestion.
  assert.ok(explanationFor(diagnosis, false).includes(diagnosis.suggestion));
});

test("chooseRecoveryStrategy resumes media when jobs are still queued on a transient failure", () => {
  const diagnosis = diagnoseFailure("timed out");
  assert.equal(chooseRecoveryStrategy(diagnosis, { canRetry: true, pendingMedia: 2 }), "resume_media");
  assert.equal(chooseRecoveryStrategy(diagnosis, { canRetry: false, pendingMedia: 1 }), "resume_media");
});

test("chooseRecoveryStrategy retries fast for transient failures with no side effects", () => {
  assert.equal(chooseRecoveryStrategy(diagnoseFailure("timed out"), { canRetry: true }), "retry_fast");
  assert.equal(chooseRecoveryStrategy(diagnoseFailure("503 service unavailable"), { canRetry: true, pendingMedia: 0 }), "retry_fast");
});

test("chooseRecoveryStrategy offers a resume point when a tool already ran and a checkpoint exists", () => {
  const diagnosis = diagnoseFailure("something broke");
  const checkpoint = { label: "queued video", createdAt: "2026-07-16T00:00:00.000Z" };
  assert.equal(chooseRecoveryStrategy(diagnosis, { canRetry: false, lastCheckpoint: checkpoint }), "resume_point");
  assert.equal(chooseRecoveryStrategy(diagnosis, { canRetry: false, lastCheckpoint: null }), "explain");
});

test("chooseRecoveryStrategy waits on rate limits and does not retry auth or bad requests", () => {
  assert.equal(chooseRecoveryStrategy(diagnoseFailure("429 rate limit"), { canRetry: true }), "wait_retry");
  assert.equal(chooseRecoveryStrategy(diagnoseFailure("401 invalid api key"), { canRetry: true }), "explain");
  assert.equal(chooseRecoveryStrategy(diagnoseFailure("400 bad request"), { canRetry: true, pendingMedia: 3 }), "explain");
});

test("checkpoint recovery tells the client to resume automatically instead of asking the user to continue", async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runSupervisorRecovery({
    message: "finish the task",
    lastError: "401 invalid api key",
    canRetry: false,
    lastCheckpoint: { label: "tests passed", createdAt: "2026-07-16T00:00:00.000Z" },
    emit: (event) => events.push(event),
  });
  assert.equal(result.strategy, "resume_point");
  assert.equal(result.autoResume, true);
  assert.match(result.text, /resume.*automatically/i);
  assert.doesNotMatch(result.text, /say continue/i);
  assert.equal(events.some((event) => event.type === "recovery" && event.autoResume === true), true);
});
