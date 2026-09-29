import assert from "node:assert/strict";
import test from "node:test";
import { classifyRunOutcome, classifyTerminalFailure, runEndedNormally, scheduleAutomaticRetry } from "../src/failure-policy.mjs";

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

test("uses bounded one, five, fifteen, fifteen and thirty minute retry backoff", () => {
  const failure = { retryable: true };
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 1, maxAttempts: 4, nowMs: 0, safeToRetry: true }).nextRetryAt, "1970-01-01T00:01:00.000Z");
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 2, maxAttempts: 4, nowMs: 0, safeToRetry: true }).nextRetryAt, "1970-01-01T00:05:00.000Z");
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 3, maxAttempts: 4, nowMs: 0, safeToRetry: true }).nextRetryAt, "1970-01-01T00:15:00.000Z");
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 4, maxAttempts: 4, nowMs: 0, safeToRetry: true }).automaticRetry, false);
  // Substrate faults get up to five attempts (runtime SUBSTRATE_MAX_ATTEMPTS).
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 4, maxAttempts: 10, nowMs: 0, safeToRetry: true }).nextRetryAt, "1970-01-01T00:15:00.000Z");
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 5, maxAttempts: 10, nowMs: 0, safeToRetry: true }).nextRetryAt, "1970-01-01T00:30:00.000Z");
  assert.equal(scheduleAutomaticRetry({ failure, failureCount: 6, maxAttempts: 10, nowMs: 0, safeToRetry: true }).automaticRetry, false);
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

// Every failure that landed in the agent_error bucket on V between 2026-09-10
// and 09-17 was transient: seven "Connection error.", six upstream 502s, three
// coordinator timeouts. None was the Agent's own doing, yet all needed a human.
test("the transient failures seen in production are retryable, and real Agent failures are not", () => {
  const classify = (rawError) => classifyTerminalFailure({ message: { stopReason: "error", error: rawError } });
  const transient = [
    ["Connection error.", "connection_reset"],
    ["502 <html> <head><title>502 Bad Gateway</title></head> <body>", "upstream_unavailable"],
    ["503 Service Unavailable", "upstream_unavailable"],
    ["Agent DB process coordinator wait exceeded 5000ms", "database_lock"],
    ["Error:Worker stream acknowledgement timed out", "worker_unavailable"],
  ];
  for (const [rawError, kind] of transient) {
    const failure = classify(rawError);
    assert.equal(failure.kind, kind, rawError);
    assert.equal(failure.retryable, true, rawError);
  }
  for (const rawError of ["tool refused the request", "the plan document is missing a required section"]) {
    const failure = classify(rawError);
    assert.equal(failure.kind, "agent_error", rawError);
    assert.equal(failure.retryable, false, rawError);
  }
});

test("a run that ended normally yields no failure: the Agent's own words decide", () => {
  for (const status of ["completed", "succeeded", "running", "queued", undefined]) {
    assert.equal(classifyRunOutcome({ status }), null, String(status));
  }
  assert.equal(classifyRunOutcome(null), null);
  // Seen once on V: the Session ended normally and only the registry lagged.
  assert.equal(classifyRunOutcome({ status: "failed", error: "session completed before registry settled" }), null);
});

test("every failed or timed-out run seen on V (2026-09-26 to 09-29) is retryable", () => {
  const seen = [
    ["failed", "⚠️ deepseek/deepseek-flash request failed.", "provider_error"],
    ["failed", "Agent run failed", "agent_interrupted"],
    ["failed", "Agent DB process coordinator wait exceeded 5000ms | V_AGENT_DB_PROCESS_COORDINATOR_TIMEOUT", "database_lock"],
    ["timed_out", "Request timed out before a response was generated. Please try again", "connection_reset"],
    ["timed_out", undefined, "agent_interrupted"],
  ];
  for (const [status, error, kind] of seen) {
    const failure = classifyRunOutcome({ status, error });
    assert.equal(failure.kind, kind, `${status}: ${error}`);
    assert.equal(failure.retryable, true, `${status}: ${error}`);
  }
});

test("a cancelled run is not retried by itself", () => {
  const failure = classifyRunOutcome({ status: "cancelled", error: "cancelled by operator" });
  assert.equal(failure.kind, "run_cancelled");
  assert.equal(failure.retryable, false);
});

test("a run ended normally when the Gateway completed it, or only its registry lagged", () => {
  assert.equal(runEndedNormally({ status: "completed" }), true);
  assert.equal(runEndedNormally({ status: "succeeded" }), true);
  assert.equal(runEndedNormally({ status: "failed", error: "session completed before registry settled" }), true);
  for (const outcome of [{ status: "failed", error: "Agent run failed" }, { status: "timed_out" }, { status: "running" }, null]) {
    assert.equal(runEndedNormally(outcome), false, JSON.stringify(outcome));
  }
});

test("a broken tool call from the model is a provider fault, not the Agent's own error", () => {
  const failure = classifyTerminalFailure({ message: { stopReason: "error", errorMessage: "Provider returned an incomplete or malformed tool call" } });
  assert.equal(failure.kind, "provider_error");
  assert.equal(failure.retryable, true);
});
