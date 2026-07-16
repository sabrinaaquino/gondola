# Gondola automated review policy

The automated reviewer is advisory. It should surface high confidence, actionable problems and leave final judgment to a human maintainer.

## Product invariants

1. Venice remains the only model provider. All chat, vision, speech, search, image, video, music, and embedding capabilities must use the Venice API.
2. Gondola remains local first and private. Conversations, memory, transcripts, vectors, generated media, credentials, and personal exports must not be sent to new third parties or committed to the repository.
3. Secrets stay server side. Browser code must never receive a Venice key, admin key, channel token, or connector credential.
4. Destructive file and shell operations remain scoped and confirmation gated. A change must not weaken sandboxing, path validation, approval requirements, or secret protection.
5. Long running and asynchronous work must be cancellable, bounded, and recoverable. Closing a request must not leave hidden inference or media spend running.
6. TypeScript remains strict. Prefer precise types, bounded data structures, explicit validation, and small focused functions.

## Review priorities

Review in this order:

1. Correctness and regressions
2. Security, privacy, permissions, path handling, and secret exposure
3. Unbounded cost, retries, memory, concurrency, or background work
4. Broken cancellation, persistence, recovery, or race conditions
5. Violations of the Venice only architecture
6. Missing tests for changed behavior
7. Maintainability issues that are likely to cause real defects

Do not spend review attention on formatting, personal style preferences, or speculative abstractions unless they create a concrete maintenance or correctness risk.

## Evidence standard

Every finding must:

1. Point to a changed file and, when possible, a changed line.
2. Explain the specific failure mode.
3. Describe the conditions required to trigger it.
4. Suggest the smallest practical correction or test.
5. Include a confidence score.

Do not report a finding when the evidence is weak. Prefer one strong issue over several generic concerns.

## Severity

* `blocker`: likely secret exposure, data loss, unsafe execution, severe privacy failure, or a change that cannot function.
* `high`: probable user facing failure, major regression, unbounded spend, or bypassed safety boundary.
* `medium`: concrete defect with limited impact, meaningful race, missing validation, or important untested behavior.
* `low`: useful but nonblocking improvement. Keep these rare.

## Review outcome

The reviewer never approves or merges a pull request. It may mark the review as `pass` or `needs_attention`, publish inline findings, and update one persistent summary comment. Deterministic CI and a human maintainer remain authoritative.
