import assert from "node:assert/strict";
import test from "node:test";
import { removeEmDashes } from "./text-style";

test("replaces em dashes in natural conversation copy", () => {
  assert.equal(
    removeEmDashes("I found it — the request completed."),
    "I found it, the request completed.",
  );
  assert.equal(removeEmDashes("Fast—clear—natural"), "Fast, clear, natural");
});

test("removes leading and trailing em dashes cleanly", () => {
  assert.equal(removeEmDashes("— Ready when you are —"), "Ready when you are");
  assert.equal(removeEmDashes("&mdash; I can see you."), "I can see you.");
});

test("does not change code operators or ordinary hyphens", () => {
  assert.equal(removeEmDashes("A && B, seven-day view"), "A && B, seven-day view");
});
