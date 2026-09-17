import assert from "node:assert/strict";
import test from "node:test";
import { classifyTerminalFailure, scheduleAutomaticRetry } from "../src/failure-policy.mjs";

test("classifies Gateway SQLite lock failures as retryable infrastructure failures", () => {
  assert.deepEqual(classifyTerminalFailure({
    message: { role: "assistant", stopReason: "error", errorMessage: "database is locked" },
  }), {
    kind: "database_lock",
    source: "gateway",
    rawError: "database is locked",
    retryable: true,
  });
});

test("does not mistake a normal terminal stop for an infrastructure failure", () => {
  assert.equal(classifyTerminalFailure({
    message: { role: "assistant", stopReason: "stop", content: "done" },
  }), null);
});

test("uses bounded one, five and fifteen minute retry backoff", () => {
  const failure = { retryable: true };
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 1, maxAttempts: 4, nowMs: 0, safeToRetry: true }).nextRetryAt, "1970-01-01T00:01:00.000Z");
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 2, maxAttempts: 4, nowMs: 0, safeToRetry: true }).nextRetryAt, "1970-01-01T00:05:00.000Z");
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 3, maxAttempts: 4, nowMs: 0, safeToRetry: true }).nextRetryAt, "1970-01-01T00:15:00.000Z");
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 4, maxAttempts: 4, nowMs: 0, safeToRetry: true }).automaticRetry, false);
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 4, maxAttempts: 10, nowMs: 0, safeToRetry: true }).automaticRetry, false);
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 1, maxAttempts: 4, nowMs: 0, safeToRetry: false }).automaticRetry, false);
});

// Both signatures hit live produce cards on V on 2026-09-17. Classified as an
// Agent failure they were marked non-retryable and stayed blocked, although the
// Agent had done nothing wrong.
test("database coordinator waits and unresponsive Workers are infrastructure, not Agent failures", () => {
  const cases = [
    ["Agent DB process coordinator wait exceeded 5000ms", "database_lock"],
    ["Error: Worker stream acknowledgement timed out", "worker_unavailable"],
    ["worker request request-2 made no progress for 120000ms", "worker_unavailable"],
  ];
  for (const [rawError, kind] of cases) {
    const failure = classifyTerminalFailure({ message: { stopReason: "error", error: rawError } });
    assert.equal(failure.kind, kind, rawError);
    assert.equal(failure.retryable, true, rawError);
    assert.equal(failure.source, "gateway");
  }
  // A genuine Agent failure stays non-retryable.
  const agent = classifyTerminalFailure({ message: { stopReason: "error", error: "tool refused the request" } });
  assert.equal(agent.kind, "agent_error");
  assert.equal(agent.retryable, false);
});

// A stage that spends money must not retry itself, whatever the classification.
test("an infrastructure failure still respects the side-effect gate", () => {
  const failure = { kind: "database_lock", retryable: true };
  assert.deepEqual(scheduleAutomaticRetry({ failure, failureCount: 1, maxAttempts: 3, safeToRetry: false }),
    { automaticRetry: false, nextRetryAt: null });
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 1, maxAttempts: 3, safeToRetry: true }).automaticRetry, true);
});
