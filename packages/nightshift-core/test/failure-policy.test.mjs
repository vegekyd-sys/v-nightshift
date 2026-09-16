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
