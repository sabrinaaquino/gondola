import assert from "node:assert/strict";
import test from "node:test";
import { takeEarlySpeechSegment } from "./voice-latency";

test("starts speech after one complete natural sentence", () => {
  assert.deepEqual(
    takeEarlySpeechSegment("Here is the answer you need. The second sentence is still streaming."),
    {
      segment: "Here is the answer you need.",
      rest: "The second sentence is still streaming.",
    },
  );
});

test("does not treat a trailing abbreviation as a completed sentence", () => {
  assert.equal(takeEarlySpeechSegment("The tournament is hosted in the U.S."), undefined);
  assert.equal(takeEarlySpeechSegment("The U.S. team plays next"), undefined);
});

test("breaks a very long opening at a natural pause", () => {
  const input = `${"This opening keeps adding useful context and details ".repeat(3)}, then the response continues with more information.`;
  const result = takeEarlySpeechSegment(input);
  assert.ok(result);
  assert.ok(result.segment.length >= 80);
  assert.ok(result.rest.length > 0);
  assert.equal(`${result.segment} ${result.rest}`, input.replace(/\s+/g, " "));
});
