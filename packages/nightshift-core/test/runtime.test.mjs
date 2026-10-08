import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  NeedsYouTracker,
  NightShiftRuntime,
  NightShiftStore,
} from "../src/index.mjs";
import { instanceCardIds } from "../src/scheduler-pass.mjs";
import { stagesToRedo } from "../src/runtime.mjs";
import { buildAgentBrief } from "../src/orchestrator.mjs";
import { resolveNightShiftOperationKeys } from "../src/card-context.mjs";
import { gatewayIdempotencyLabel } from "../src/workboard-gateway-adapter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");

test("persists a stage card and advances after native completion", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ board: "nightshift-lab", store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-1",
    name: "Runtime test",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    inputs: { targetCount: 1 },
  });

  const first = await runtime.tick("NS-RUNTIME-1");
  assert.equal(first.applied[0].status, "created");
  assert.equal(store.listStageRuns("NS-RUNTIME-1")[0].stageId, "plan");
  workboard.cards[0].status = "done";
  runtime.setContentItems("NS-RUNTIME-1", [
    { id: "video-1", title: "First video", route: "SCENE_EDIT" },
  ]);
  const second = await runtime.tick("NS-RUNTIME-1");
  assert.equal(second.actions[0].stageId, "route");
  assert.equal(second.actions[0].contentItemId, "video-1");
  store.close();
});

test("recovers a terminal Agent Session after validated outputs and advances", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const validated = [];
  const runtime = new NightShiftRuntime({
    store,
    workboard,
    completionValidator: async ({ stageId }) => validated.push(stageId),
  });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-TERMINAL-RECOVERY",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
  });
  workboard.cards.push({
    id: "card-terminal",
    status: "running",
    sessionKey: "agent:main:subagent:workboard-terminal",
    execution: { status: "running", startedAt: 100 },
    labels: ["instance:NS-RUNTIME-TERMINAL-RECOVERY", "stage:plan"],
  });
  workboard.sessions.set("agent:main:subagent:workboard-terminal", {
    messages: [{
      role: "assistant",
      content: [{ type: "text", text: "Plan outputs are complete" }],
      stopReason: "stop",
      timestamp: 200,
    }],
  });

  await runtime.reconcile("NS-RUNTIME-TERMINAL-RECOVERY");

  assert.deepEqual(validated, ["plan"]);
  assert.equal(workboard.cards[0].status, "done");
  assert.equal(workboard.completeCalls.length, 1);
  assert.equal(store.listStageRuns("NS-RUNTIME-TERMINAL-RECOVERY")[0].status, "done");
  assert.ok(store.listEvents("NS-RUNTIME-TERMINAL-RECOVERY").some((event) => event.type === "stage.terminal.recovered"));
  store.close();
});

test("event reconciliation trusts native running state without polling thirty Sessions", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-RUNTIME-THIRTY", workflowSha256: release.workflowSha256 });
  for (let index = 0; index < 30; index += 1) {
    workboard.cards.push({
      id: `running-${index}`,
      status: "running",
      sessionKey: `agent:main:subagent:running-${index}`,
      execution: { status: "running", startedAt: 100 },
      metadata: { attempts: [{ status: "running" }] },
      labels: ["instance:NS-RUNTIME-THIRTY", "stage:plan"],
    });
  }

  await runtime.reconcile("NS-RUNTIME-THIRTY", workboard.cards, { inspectSessions: false });

  assert.equal(workboard.sessionCalls.length, 0);
  assert.equal(store.listStageRuns("NS-RUNTIME-THIRTY").at(-1).status, "running");
  store.close();
});

test("retries a failed terminal completion callback without blocking valid output", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  workboard.completeFailures = 1;
  const runtime = new NightShiftRuntime({ completionValidator: async () => ({ valid: true }), store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-RUNTIME-CALLBACK-RETRY", workflowSha256: release.workflowSha256 });
  workboard.cards.push({
    id: "card-callback-retry",
    status: "running",
    sessionKey: "agent:main:subagent:callback-retry",
    execution: { status: "running", startedAt: 100 },
    labels: ["instance:NS-RUNTIME-CALLBACK-RETRY", "stage:plan"],
  });
  workboard.sessions.set("agent:main:subagent:callback-retry", {
    messages: [{ role: "assistant", content: "Outputs persisted", stopReason: "stop", timestamp: 200 }],
  });

  await runtime.reconcile("NS-RUNTIME-CALLBACK-RETRY");
  assert.equal(workboard.cards[0].status, "running");
  assert.equal(workboard.blockCalls.length, 0);
  assert.ok(store.listEvents("NS-RUNTIME-CALLBACK-RETRY").some((event) => event.type === "stage.terminal.recovery-deferred"));

  await runtime.reconcile("NS-RUNTIME-CALLBACK-RETRY");
  assert.equal(workboard.cards[0].status, "done");
  assert.equal(workboard.completeCalls.length, 2);
  assert.equal(store.listEvents("NS-RUNTIME-CALLBACK-RETRY").filter((event) => event.type === "stage.terminal.recovered").length, 1);
  store.close();
});

test("reuses persisted completion validation and bounds legacy done-card validation", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  let validations = 0;
  const runtime = new NightShiftRuntime({
    completionValidator: async () => { validations += 1; },
    store,
    terminalInspectionMaxStarts: 3,
    workboard,
  });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-DONE-VALIDATION-BUDGET", workflowSha256: release.workflowSha256 });
  for (let index = 0; index < 5; index += 1) {
    workboard.cards.push({
      id: `done-card-${index}`,
      status: "done",
      sessionKey: `agent:main:subagent:done-${index}`,
      labels: ["instance:NS-DONE-VALIDATION-BUDGET", "stage:plan"],
      metadata: { automation: { attempt: 1 } },
    });
  }
  store.appendEvent({
    eventId: "completion-validation:done-card-0:1",
    instanceId: "NS-DONE-VALIDATION-BUDGET",
    type: "stage.completion.validated",
    payload: { cardId: "done-card-0", stageId: "plan" },
  });

  await runtime.reconcile("NS-DONE-VALIDATION-BUDGET");
  await runtime.reconcile("NS-DONE-VALIDATION-BUDGET");

  assert.equal(validations, 3);
  assert.equal(store.listEvents("NS-DONE-VALIDATION-BUDGET").filter((event) => event.type === "stage.completion.validated").length, 4);
  store.close();
});

test("idempotently completes a blocked produce card when persisted artifacts validate", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ completionValidator: async () => ({ deliveryManifest: { valid: true } }), store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-ARTIFACT-RECOVERY",
    workflowSha256: release.workflowSha256,
    inputs: { deliveryMode: "download" },
    contentItems: [{ id: "video-1", title: "Recovered video", route: "AI_GENERATE" }],
  });
  workboard.cards.push({
    id: "card-produce-artifacts",
    sessionKey: "agent:main:workboard:produce",
    status: "blocked",
    labels: ["instance:NS-RUNTIME-ARTIFACT-RECOVERY", "content-item:video-1", "stage:produce"],
    metadata: { automation: { attempt: 2, summary: "Worker callback failed after files were written" } },
  });

  await runtime.reconcile("NS-RUNTIME-ARTIFACT-RECOVERY");
  await runtime.reconcile("NS-RUNTIME-ARTIFACT-RECOVERY");

  assert.equal(workboard.cards[0].status, "done");
  assert.equal(workboard.completeCalls.length, 1);
  assert.equal(store.listContentItemRuns("NS-RUNTIME-ARTIFACT-RECOVERY")[0].status, "done");
  assert.equal(store.listEvents("NS-RUNTIME-ARTIFACT-RECOVERY").filter((event) => event.type === "stage.artifacts.recovered").length, 1);
  store.close();
});

test("does not recover an older terminal message from a previous run", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-RUNTIME-OLD-TERMINAL", workflowSha256: release.workflowSha256 });
  workboard.cards.push({
    id: "card-current-run",
    status: "running",
    sessionKey: "agent:main:subagent:workboard-current-run",
    execution: { status: "running", startedAt: 300 },
    labels: ["instance:NS-RUNTIME-OLD-TERMINAL", "stage:plan"],
  });
  workboard.sessions.set("agent:main:subagent:workboard-current-run", {
    messages: [{ role: "assistant", content: [{ type: "text", text: "Old completion" }], stopReason: "stop", timestamp: 200 }],
  });

  await runtime.reconcile("NS-RUNTIME-OLD-TERMINAL");

  assert.equal(workboard.cards[0].status, "running");
  assert.equal(workboard.completeCalls.length, 0);
  store.close();
});

test("throttles repeated Session inspection and artifact recovery for a blocked card without a terminal message", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-REVIEW-NONTERMINAL", workflowSha256: release.workflowSha256 });
  workboard.cards.push({
    id: "card-review-nonterminal",
    status: "blocked",
    sessionKey: "agent:main:subagent:review-nonterminal",
    runId: "run-review-nonterminal",
    // Recent activity: the Agent is still working, not orphaned.
    execution: { status: "running", startedAt: Date.now() - 60_000 },
    labels: ["instance:NS-REVIEW-NONTERMINAL", "stage:plan"],
  });
  workboard.sessions.set("agent:main:subagent:review-nonterminal", {
    messages: [{ role: "assistant", content: "Still working", timestamp: Date.now() - 1_000 }],
  });

  await runtime.reconcile("NS-REVIEW-NONTERMINAL");
  await runtime.reconcile("NS-REVIEW-NONTERMINAL");

  assert.equal(workboard.cards[0].status, "blocked");
  assert.equal(workboard.sessionCalls.length, 1);
  assert.equal(store.listEvents("NS-REVIEW-NONTERMINAL").filter((event) => event.type === "stage.session.inspected").length, 1);
  store.close();
});

test("globally limits legacy terminal Session inspection without slowing running cards", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard, terminalInspectionMaxStarts: 3 });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-INSPECTION-BUDGET", workflowSha256: release.workflowSha256 });
  for (let index = 0; index < 5; index += 1) {
    const status = index === 4 ? "running" : "review";
    const sessionKey = `agent:main:subagent:inspection-budget-${index}`;
    workboard.cards.push({
      id: `card-inspection-budget-${index}`,
      status,
      sessionKey,
      runId: `run-inspection-budget-${index}`,
      execution: { status: "running", startedAt: 100 },
      labels: ["instance:NS-INSPECTION-BUDGET", "stage:plan"],
    });
    workboard.sessions.set(sessionKey, { messages: [{ role: "assistant", content: "Still working", timestamp: 200 }] });
  }

  await runtime.reconcile("NS-INSPECTION-BUDGET");

  assert.equal(workboard.sessionCalls.length, 4);
  assert.ok(workboard.sessionCalls.includes("agent:main:subagent:inspection-budget-4"));
  store.close();
});

test("blocks a terminal Agent Session when its output contract fails", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({
    store,
    workboard,
    completionValidator: async () => { throw new Error("handoff missing"); },
  });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-RUNTIME-TERMINAL-BLOCK", workflowSha256: release.workflowSha256 });
  workboard.cards.push({
    id: "card-terminal-invalid",
    status: "running",
    sessionKey: "agent:main:subagent:workboard-terminal-invalid",
    execution: { status: "running", startedAt: 100 },
    labels: ["instance:NS-RUNTIME-TERMINAL-BLOCK", "stage:plan"],
  });
  workboard.sessions.set("agent:main:subagent:workboard-terminal-invalid", {
    messages: [{ role: "assistant", content: [{ type: "text", text: "I am done" }], stopReason: "stop", timestamp: 200 }],
  });

  await runtime.reconcile("NS-RUNTIME-TERMINAL-BLOCK");
  await runtime.reconcile("NS-RUNTIME-TERMINAL-BLOCK");

  assert.equal(workboard.cards[0].status, "blocked");
  assert.equal(workboard.blockCalls.length, 1);
  assert.equal(workboard.sessionCalls.length, 1);
  assert.match(workboard.blockCalls[0].reason, /handoff missing/);
  assert.ok(store.listEvents("NS-RUNTIME-TERMINAL-BLOCK").some((event) => event.type === "stage.terminal.blocked"));
  store.close();
});

test("corrects a false review state after an infrastructure failure without running handoff validation", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  let validations = 0;
  const runtime = new NightShiftRuntime({
    store,
    workboard,
    completionValidator: async () => { validations += 1; throw new Error("handoff missing"); },
  });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-INFRA-FAILURE", workflowSha256: release.workflowSha256 });
  workboard.cards.push({
    id: "card-infra-failure",
    status: "review",
    sessionKey: "agent:main:subagent:infra-failure",
    runId: "run-infra-failure",
    execution: { status: "blocked", startedAt: 100 },
    labels: ["instance:NS-INFRA-FAILURE", "stage:plan"],
  });
  workboard.sessions.set("agent:main:subagent:infra-failure", {
    messages: [{ role: "assistant", content: "The agent run failed before producing a reply.", errorMessage: "database is locked", stopReason: "error", timestamp: 200 }],
  });

  await runtime.reconcile("NS-INFRA-FAILURE");
  await runtime.reconcile("NS-INFRA-FAILURE");

  const run = store.listStageRuns("NS-INFRA-FAILURE")[0];
  assert.equal(validations, 0);
  assert.equal(workboard.cards[0].status, "blocked");
  assert.equal(run.status, "blocked");
  assert.equal(run.failure.kind, "database_lock");
  assert.equal(run.failure.source, "gateway");
  assert.equal(run.failure.retryable, true);
  assert.equal(run.failure.automaticRetry, true);
  assert.equal(workboard.sessionCalls.length, 1);
  assert.doesNotMatch(run.summary, /handoff/i);
  assert.ok(store.listEvents("NS-INFRA-FAILURE").some((event) => event.type === "stage.attempt.failed"));
  store.close();
});

test("reuses a persisted terminal failure event without reading the Session again", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-PERSISTED-FAILURE", workflowSha256: release.workflowSha256 });
  workboard.cards.push({
    id: "card-persisted-failure",
    status: "review",
    sessionKey: "agent:main:subagent:persisted-failure",
    runId: "run-persisted-failure",
    execution: { status: "blocked", startedAt: 100 },
    labels: ["instance:NS-PERSISTED-FAILURE", "stage:plan"],
  });
  store.appendEvent({
    eventId: "attempt-failure:card-persisted-failure:run-persisted-failure",
    instanceId: "NS-PERSISTED-FAILURE",
    type: "stage.attempt.failed",
    payload: {
      cardId: "card-persisted-failure",
      failure: {
        kind: "database_lock",
        source: "gateway",
        rawError: "database is locked",
        retryable: true,
        automaticRetry: false,
        nextRetryAt: null,
      },
      stageId: "plan",
      summary: "Gateway database lock",
    },
  });

  await runtime.reconcile("NS-PERSISTED-FAILURE");

  assert.equal(workboard.cards[0].status, "blocked");
  assert.equal(workboard.blockCalls.length, 1);
  assert.equal(workboard.sessionCalls.length, 0);
  assert.equal(store.listStageRuns("NS-PERSISTED-FAILURE")[0].failure.kind, "database_lock");
  store.close();
});

test("automatically reopens a due retryable infrastructure failure on the same card", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-AUTO-RETRY", workflowSha256: release.workflowSha256 });
  workboard.cards.push({
    id: "card-auto-retry",
    status: "review",
    sessionKey: "agent:main:subagent:auto-retry",
    runId: "run-auto-retry",
    execution: { status: "blocked", startedAt: 100 },
    labels: ["instance:NS-AUTO-RETRY", "stage:plan"],
  });
  workboard.sessions.set("agent:main:subagent:auto-retry", {
    messages: [{ role: "assistant", errorMessage: "database is locked", stopReason: "error", timestamp: 200 }],
  });
  await runtime.reconcile("NS-AUTO-RETRY");
  const failed = store.listStageRuns("NS-AUTO-RETRY")[0];
  store.upsertStageRun({ ...failed, failure: { ...failed.failure, nextRetryAt: "1970-01-01T00:00:00.000Z" } });

  await runtime.reconcile("NS-AUTO-RETRY");

  const retried = store.listStageRuns("NS-AUTO-RETRY")[0];
  assert.equal(workboard.cards[0].status, "ready");
  assert.equal(workboard.releaseCalls.length, 1);
  assert.equal(retried.status, "ready");
  assert.equal(retried.failure, null);
  assert.ok(store.listEvents("NS-AUTO-RETRY").some((event) => event.type === "stage.retry.automatic"));
  store.close();
});

// A substrate fault (here a SQLite lock) on a paid stage retries when the
// ledger holds nothing this card left in flight: Agents reserve before a paid
// call, so nothing was spent. Before 2026-09-29 such a card always waited for a
// person, and eight system stops reached people that day.
test("a side-effect stage retries a substrate fault when its ledger holds nothing in flight", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-PAID-UNCERTAIN",
    workflowSha256: release.workflowSha256,
    contentItems: [{ id: "video-1", title: "Paid video", route: "AI_GENERATE" }],
  });
  workboard.cards.push({
    id: "card-paid-uncertain",
    status: "review",
    sessionKey: "agent:main:subagent:paid-uncertain",
    runId: "run-paid-uncertain",
    execution: { status: "blocked", startedAt: 100 },
    labels: ["instance:NS-PAID-UNCERTAIN", "content-item:video-1", "stage:produce"],
  });
  workboard.sessions.set("agent:main:subagent:paid-uncertain", {
    messages: [{ role: "assistant", errorMessage: "database is locked", stopReason: "error", timestamp: 200 }],
  });

  await runtime.reconcile("NS-PAID-UNCERTAIN");

  const run = store.listContentItemRuns("NS-PAID-UNCERTAIN")[0];
  assert.equal(run.failure.retryable, true);
  assert.equal(run.failure.automaticRetry, true);
  assert.ok(run.failure.nextRetryAt);
  store.close();
});

test("does not auto-retry a side-effect stage whose ledger holds an unresolved reservation", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-PAID-RESERVED",
    workflowSha256: release.workflowSha256,
    contentItems: [{ id: "video-1", title: "Paid video", route: "AI_GENERATE" }],
  });
  workboard.cards.push({
    id: "card-paid-reserved",
    status: "review",
    sessionKey: "agent:main:subagent:paid-reserved",
    runId: "run-paid-reserved",
    execution: { status: "blocked", startedAt: 100 },
    labels: ["instance:NS-PAID-RESERVED", "content-item:video-1", "stage:produce"],
  });
  workboard.sessions.set("agent:main:subagent:paid-reserved", {
    messages: [{ role: "assistant", errorMessage: "database is locked", stopReason: "error", timestamp: 200 }],
  });
  store.reserveExternalOperation({
    idempotencyKey: "NS-PAID-RESERVED:video-1:produce",
    instanceId: "NS-PAID-RESERVED",
    contentItemId: "video-1",
    stageId: "produce",
    ownerCardId: "card-paid-reserved",
    requestHash: "request-sha",
  });

  await runtime.reconcile("NS-PAID-RESERVED");

  const run = store.listContentItemRuns("NS-PAID-RESERVED")[0];
  assert.equal(run.failure.retryable, true);
  assert.equal(run.failure.automaticRetry, false);
  assert.equal(run.failure.nextRetryAt, null);
  assert.equal(workboard.releaseCalls.length, 0);
  store.close();
});

test("allows a side-effect retry only when the ledger has a resumable external task", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-PAID-RESUMABLE",
    workflowSha256: release.workflowSha256,
    contentItems: [{ id: "video-1", title: "Paid video", route: "AI_GENERATE" }],
  });
  store.reserveExternalOperation({
    idempotencyKey: "NS-PAID-RESUMABLE:video-1:produce",
    instanceId: "NS-PAID-RESUMABLE",
    contentItemId: "video-1",
    stageId: "produce",
    ownerCardId: "card-paid-resumable",
    requestHash: "request-hash",
  });
  store.checkpointExternalOperation("NS-PAID-RESUMABLE:video-1:produce", {
    status: "executing",
    externalTaskId: "supplier-task-1",
  });
  workboard.cards.push({
    id: "card-paid-resumable",
    status: "review",
    sessionKey: "agent:main:subagent:paid-resumable",
    runId: "run-paid-resumable",
    execution: { status: "blocked", startedAt: "1970-01-01T00:00:00.100Z" },
    labels: ["instance:NS-PAID-RESUMABLE", "content-item:video-1", "stage:produce"],
  });
  workboard.sessions.set("agent:main:subagent:paid-resumable", {
    messages: [{ role: "assistant", errorMessage: "database is locked", stopReason: "ERROR", timestamp: "1970-01-01T00:00:00.200Z" }],
  });

  await runtime.reconcile("NS-PAID-RESUMABLE");

  const run = store.listContentItemRuns("NS-PAID-RESUMABLE")[0];
  assert.equal(run.failure.automaticRetry, true);
  assert.ok(run.failure.nextRetryAt);
  store.close();
});

test("does not automatically retry after a recorded human takeover", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-HUMAN-TAKEOVER", workflowSha256: release.workflowSha256 });
  store.saveHumanAttempt({ cardId: "card-human-takeover", instanceId: "NS-HUMAN-TAKEOVER", status: "started" });
  workboard.cards.push({
    id: "card-human-takeover",
    status: "review",
    sessionKey: "agent:main:subagent:human-takeover",
    runId: "run-human-takeover",
    execution: { status: "blocked", startedAt: 100 },
    labels: ["instance:NS-HUMAN-TAKEOVER", "stage:plan"],
  });
  workboard.sessions.set("agent:main:subagent:human-takeover", {
    messages: [{ role: "assistant", errorMessage: "database is locked", stopReason: "error", timestamp: 200 }],
  });

  await runtime.reconcile("NS-HUMAN-TAKEOVER");

  const run = store.listStageRuns("NS-HUMAN-TAKEOVER")[0];
  assert.equal(run.failure.retryable, true);
  assert.equal(run.failure.automaticRetry, false);
  store.close();
});

test("does not automatically retry after project approval requested changes", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-CHANGES-REQUESTED", workflowSha256: release.workflowSha256 });
  store.recordApproval({
    actor: "Night Shift operator",
    cardId: "card-changes-requested",
    evidence: "Human operator took over the interrupted attempt",
    instanceId: "NS-CHANGES-REQUESTED",
    stageId: "plan",
    status: "changes_requested",
  });
  workboard.cards.push({
    id: "card-changes-requested",
    status: "review",
    sessionKey: "agent:main:subagent:changes-requested",
    runId: "run-changes-requested",
    execution: { status: "blocked", startedAt: 100 },
    labels: ["instance:NS-CHANGES-REQUESTED", "stage:plan"],
  });
  workboard.sessions.set("agent:main:subagent:changes-requested", {
    messages: [{ role: "assistant", errorMessage: "database is locked", stopReason: "error", timestamp: 200 }],
  });

  await runtime.reconcile("NS-CHANGES-REQUESTED");

  const run = store.listStageRuns("NS-CHANGES-REQUESTED")[0];
  assert.equal(run.status, "blocked");
  assert.equal(run.failure.retryable, true);
  assert.equal(run.failure.automaticRetry, false);
  assert.equal(run.failure.nextRetryAt, null);
  assert.equal(workboard.releaseCalls.length, 0);
  store.close();
});

test("cancels a scheduled automatic retry when a human requests changes before it is due", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({ id: "NS-TAKEOVER-BEFORE-RETRY", workflowSha256: release.workflowSha256 });
  workboard.cards.push({
    id: "card-takeover-before-retry",
    status: "blocked",
    labels: ["instance:NS-TAKEOVER-BEFORE-RETRY", "stage:plan"],
  });
  store.upsertStageRun({
    instanceId: "NS-TAKEOVER-BEFORE-RETRY",
    stageId: "plan",
    attempt: 1,
    cardId: "card-takeover-before-retry",
    status: "blocked",
    summary: "Gateway database lock",
    failure: {
      kind: "database_lock",
      source: "gateway",
      rawError: "database is locked",
      retryable: true,
      automaticRetry: true,
      attempt: 1,
      nextRetryAt: "1970-01-01T00:00:00.000Z",
    },
  });
  store.recordApproval({
    actor: "Night Shift operator",
    cardId: "card-takeover-before-retry",
    evidence: "Human operator took over after the failure",
    instanceId: "NS-TAKEOVER-BEFORE-RETRY",
    stageId: "plan",
    status: "changes_requested",
  });

  await runtime.reconcile("NS-TAKEOVER-BEFORE-RETRY");

  const run = store.listStageRuns("NS-TAKEOVER-BEFORE-RETRY")[0];
  assert.equal(run.status, "blocked");
  assert.equal(run.failure.automaticRetry, false);
  assert.equal(run.failure.nextRetryAt, null);
  assert.equal(workboard.releaseCalls.length, 0);
  store.close();
});

test("approval card completion does not skip the guarded agent stage", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-2",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
  });
  store.upsertStageRun({ instanceId: "NS-RUNTIME-2", stageId: "plan", status: "done" });
  runtime.setContentItems("NS-RUNTIME-2", [{ id: "video-1", title: "First video", route: "AI_GENERATE" }]);
  for (const stageId of ["route", "materials", "brief"]) {
    store.upsertContentItemRun({ instanceId: "NS-RUNTIME-2", contentItemId: "video-1", stageId, status: "done" });
  }
  const requested = await runtime.tick("NS-RUNTIME-2");
  assert.equal(requested.actions[0].type, "request_approval");
  const cardId = requested.applied[0].card.id;
  await runtime.approve({
    actor: "tianyi",
    cardId,
    contentItemId: "video-1",
    effect: "paid-production",
    instanceId: "NS-RUNTIME-2",
    scope: "content-item",
    stageId: "produce",
  });
  const after = await runtime.tick("NS-RUNTIME-2");
  assert.equal(after.actions[0].type, "create_workboard_card");
  assert.equal(after.actions[0].stageId, "produce");
  store.close();
});

test("reopens a completed approval card when exact authorization is still missing", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-APPROVAL-RECOVERY",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    contentItems: [{ id: "video-1", title: "First video", route: "SCENE_EDIT" }],
  });
  store.upsertStageRun({ instanceId: "NS-RUNTIME-APPROVAL-RECOVERY", stageId: "plan", status: "done" });
  for (const stageId of ["route", "materials", "brief", "produce", "review"]) {
    store.upsertContentItemRun({ instanceId: "NS-RUNTIME-APPROVAL-RECOVERY", contentItemId: "video-1", stageId, status: "done" });
  }
  const staleApprovalCard = {
    id: "approval-stale",
    labels: [
      "instance:NS-RUNTIME-APPROVAL-RECOVERY",
      "content-item:video-1",
      "stage:publish-feedback",
      "nightshift:approval",
    ],
    status: "done",
  };
  workboard.cards.push(staleApprovalCard);
  workboard.applyPlan = async (actions) => actions.map((action) => ({ action, card: staleApprovalCard, status: "reused" }));

  const result = await runtime.tick("NS-RUNTIME-APPROVAL-RECOVERY");

  assert.equal(result.actions[0].type, "request_approval");
  assert.equal(result.actions[0].approval.effect, "external-publication");
  assert.deepEqual(result.actions[0].approval.missingFields, ["publicationTarget"]);
  assert.equal(staleApprovalCard.status, "review");
  assert.ok(store.listEvents("NS-RUNTIME-APPROVAL-RECOVERY").some((event) => event.type === "approval.reopened"));
  store.close();
});

test("confirmation resumes a blocked guarded stage and retry cannot bypass approval", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-CONFIRM-EXECUTION",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    inputs: { publicationTarget: publicationTarget() },
    contentItems: [{ id: "video-1", title: "First video", route: "SCENE_EDIT" }],
  });
  store.upsertContentItemRun({
    instanceId: "NS-RUNTIME-CONFIRM-EXECUTION",
    contentItemId: "video-1",
    stageId: "publish-feedback",
    cardId: "execution-blocked",
    status: "blocked",
  });
  workboard.cards.push({
    id: "execution-blocked",
    labels: [
      "instance:NS-RUNTIME-CONFIRM-EXECUTION",
      "content-item:video-1",
      "stage:publish-feedback",
    ],
    status: "blocked",
  });
  workboard.cards.push({
    id: "approval-review",
    labels: [
      "instance:NS-RUNTIME-CONFIRM-EXECUTION",
      "content-item:video-1",
      "stage:publish-feedback",
      "nightshift:approval",
    ],
    status: "review",
  });

  await assert.rejects(
    runtime.retry({
      actor: "tester",
      cardId: "execution-blocked",
      contentItemId: "video-1",
      instanceId: "NS-RUNTIME-CONFIRM-EXECUTION",
      stageId: "publish-feedback",
    }),
    /confirmation is required/i,
  );
  await runtime.approve({
    actor: "tianyi",
    cardId: "approval-review",
    contentItemId: "video-1",
    effect: "external-publication",
    evidence: "Confirmed in Workboard",
    instanceId: "NS-RUNTIME-CONFIRM-EXECUTION",
    scope: "asset-and-account",
    stageId: "publish-feedback",
  });

  assert.equal(workboard.cards.find((card) => card.id === "approval-review").status, "done");
  assert.equal(workboard.cards.find((card) => card.id === "execution-blocked").status, "ready");
  assert.equal(store.listContentItemRuns("NS-RUNTIME-CONFIRM-EXECUTION")[0].status, "ready");
  store.close();
});

test("request changes records a distinct decision and blocks the stage", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-3",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
  });
  store.upsertStageRun({
    instanceId: "NS-RUNTIME-3",
    stageId: "review",
    cardId: "card-review",
    status: "review",
  });
  workboard.cards.push({
    id: "card-review",
    labels: ["instance:NS-RUNTIME-3", "stage:review"],
    status: "review",
  });

  const decision = await runtime.requestChanges({
    actor: "tianyi",
    cardId: "card-review",
    evidence: "revise opening",
    instanceId: "NS-RUNTIME-3",
    stageId: "review",
  });

  assert.equal(decision.status, "changes_requested");
  assert.equal(workboard.cards[0].status, "blocked");
  assert.equal(store.listStageRuns("NS-RUNTIME-3")[0].status, "blocked");
  store.close();
});

test("reconciles a shared Workboard snapshot without another Gateway read", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-4",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
  });
  const cards = [{
    id: "shared-card",
    labels: ["instance:NS-RUNTIME-4", "stage:plan"],
    status: "done",
  }];
  workboard.listCards = async () => { throw new Error("unexpected Gateway read"); };

  await runtime.reconcile("NS-RUNTIME-4", cards);

  assert.equal(store.listStageRuns("NS-RUNTIME-4")[0].status, "done");
  store.close();
});

test("updates persisted instance inputs before a downstream side effect", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-5",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    inputs: { targetCount: 1 },
  });

  const updated = runtime.updateInstanceInputs("NS-RUNTIME-5", {
    accountId: "account-1",
    assetHash: "asset-sha",
  });

  assert.equal(updated.inputs.accountId, "account-1");
  assert.equal(updated.inputs.assetHash, "asset-sha");
  assert.deepEqual(store.listEvents("NS-RUNTIME-5", 1)[0].payload.keys, [
    "accountId",
    "assetHash",
  ]);
  store.close();
});

test("re-dispatches a previously ready content-item card", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-READY",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    contentItems: [{ id: "video-1", title: "Ready video", route: "SCENE_EDIT" }],
  });
  store.upsertStageRun({ instanceId: "NS-RUNTIME-READY", stageId: "plan", status: "done" });
  workboard.cards.push({
    id: "card-ready",
    labels: ["instance:NS-RUNTIME-READY", "content-item:video-1", "stage:route"],
    status: "ready",
  });
  workboard.cards.push({
    id: "card-unrelated",
    labels: ["instance:NS-OTHER", "stage:plan"],
    status: "ready",
  });
  const result = await runtime.tick("NS-RUNTIME-READY", { dispatch: true });
  assert.deepEqual(result.actions, []);
  assert.deepEqual(workboard.dispatchCalls, [{
    maxStarts: 1,
    options: { cardIds: ["card-ready"] },
  }]);
  store.close();
});

test("allows high steady concurrency without adding a lower per-project Session cap", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-BURST-LIMIT",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    contentItems: [
      { id: "video-1", title: "Video one", route: "SCENE_EDIT" },
      { id: "video-2", title: "Video two", route: "SCENE_EDIT" },
      { id: "video-3", title: "Video three", route: "SCENE_EDIT" },
    ],
  });
  store.upsertStageRun({ instanceId: "NS-RUNTIME-BURST-LIMIT", stageId: "plan", status: "done" });
  workboard.cards.push(
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `other-running-${index}`,
      labels: [`instance:NS-OTHER-${index}`, "stage:produce"],
      status: "running",
    })),
    { id: "ready-1", labels: ["instance:NS-RUNTIME-BURST-LIMIT", "content-item:video-1", "stage:route"], status: "ready" },
    { id: "ready-2", labels: ["instance:NS-RUNTIME-BURST-LIMIT", "content-item:video-2", "stage:route"], status: "ready" },
    { id: "ready-3", labels: ["instance:NS-RUNTIME-BURST-LIMIT", "content-item:video-3", "stage:route"], status: "ready" },
  );

  await runtime.tick("NS-RUNTIME-BURST-LIMIT", { dispatch: true });

  assert.deepEqual(workboard.dispatchCalls, [{
    maxStarts: 3,
    options: { cardIds: ["ready-1", "ready-2", "ready-3"] },
  }]);
  store.close();
});

test("global active capacity blocks another project, preserves live claims, and ignores expired claims", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ maxWorkboardActive: 4, store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-GLOBAL-CAP",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    contentItems: [{ id: "video-1", title: "Ready video", route: "SCENE_EDIT" }],
  });
  store.upsertStageRun({ instanceId: "NS-RUNTIME-GLOBAL-CAP", stageId: "plan", status: "done" });
  workboard.cards.push(
    { id: "other-running-1", labels: ["instance:NS-OTHER-1", "stage:produce"], status: "running" },
    { id: "other-running-2", labels: ["instance:NS-OTHER-2", "stage:produce"], execution: { status: "running" }, status: "blocked" },
    { id: "other-running-3", labels: ["instance:NS-OTHER-3", "stage:produce"], status: "running" },
    { id: "other-running-4", labels: ["instance:NS-OTHER-4", "stage:produce"], execution: { status: "running" }, status: "review" },
    {
      id: "expired-ready",
      labels: ["instance:NS-RUNTIME-GLOBAL-CAP", "content-item:video-1", "stage:route"],
      metadata: { claim: { expiresAt: Date.now() - 1 } },
      status: "ready",
    },
  );

  await runtime.tick("NS-RUNTIME-GLOBAL-CAP", { dispatch: true });
  assert.deepEqual(workboard.dispatchCalls, []);

  workboard.cards.length = 0;
  workboard.cards.push(
    { id: "other-running-1", labels: ["instance:NS-OTHER-1", "stage:produce"], status: "running" },
    { id: "other-running-2", labels: ["instance:NS-OTHER-2", "stage:produce"], execution: { status: "running" }, status: "blocked" },
    {
      id: "live-claim-ready",
      labels: ["instance:NS-RUNTIME-GLOBAL-CAP", "content-item:video-1", "stage:route"],
      metadata: { claim: { expiresAt: Date.now() + 60_000 } },
      status: "ready",
    },
    {
      id: "expired-ready",
      labels: ["instance:NS-RUNTIME-GLOBAL-CAP", "content-item:video-1", "stage:route"],
      metadata: { claim: { expiresAt: Date.now() - 1 } },
      status: "ready",
    },
  );
  await runtime.tick("NS-RUNTIME-GLOBAL-CAP", { dispatch: true });
  assert.deepEqual(workboard.dispatchCalls, [{ maxStarts: 1, options: { cardIds: ["expired-ready"] } }]);
  store.close();
});

test("dispatches a newly created plan card without touching unrelated ready cards", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-SCOPED-DISPATCH",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
  });
  workboard.cards.push({
    id: "card-unrelated",
    labels: ["instance:NS-OTHER", "stage:plan"],
    status: "ready",
  });

  const result = await runtime.tick("NS-RUNTIME-SCOPED-DISPATCH", { dispatch: true });

  assert.equal(result.applied[0].card.id, "card-2");
  assert.deepEqual(workboard.dispatchCalls, [{
    maxStarts: 1,
    options: { cardIds: ["card-2"] },
  }]);
  store.close();
});

test("rejects a done card when its declared delivery fails validation", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  let deliveryValid = false;
  const runtime = new NightShiftRuntime({
    completionValidator: async () => { if (!deliveryValid) throw new Error("invalid delivery manifest"); },
    store,
    workboard,
  });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-INVALID-DELIVERY",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    inputs: { nightshift: { instanceDir: "/srv/nightshift/NS-RUNTIME-INVALID-DELIVERY" } },
    contentItems: [{ id: "video-1", title: "Invalid delivery", route: "AI_GENERATE" }],
  });
  workboard.cards.push({
    id: "card-produce-done",
    labels: ["instance:NS-RUNTIME-INVALID-DELIVERY", "content-item:video-1", "stage:produce"],
    status: "done",
    metadata: {
      claim: { ownerId: "main", token: "stale-token", expiresAt: Date.now() + 60_000 },
      // Past the stage's retry budget: the native board would never start it.
      failureCount: 3,
    },
  });
  workboard.cards.push({
    id: "card-review-stale",
    labels: ["instance:NS-RUNTIME-INVALID-DELIVERY", "content-item:video-1", "stage:review"],
    status: "review",
  });
  await runtime.reconcile("NS-RUNTIME-INVALID-DELIVERY");
  assert.equal(workboard.cards[0].status, "blocked");
  assert.equal(workboard.cards[1].status, "blocked");
  assert.ok(store.listContentItemRuns("NS-RUNTIME-INVALID-DELIVERY").every((run) => run.status === "blocked"));
  assert.ok(store.listEvents("NS-RUNTIME-INVALID-DELIVERY").some((event) => event.type === "stage.completion.rejected"));
  assert.ok(store.listEvents("NS-RUNTIME-INVALID-DELIVERY").some((event) => event.type === "stage.downstream.blocked"));
  store.recordApproval({
    actor: "tester",
    contentItemId: "video-1",
    effect: "paid-production",
    instanceId: "NS-RUNTIME-INVALID-DELIVERY",
    scope: "content-item",
    stageId: "produce",
    status: "approved",
  });
  await runtime.retry({
    actor: "tester",
    cardId: "card-produce-done",
    contentItemId: "video-1",
    evidence: "manifest fixed",
    instanceId: "NS-RUNTIME-INVALID-DELIVERY",
    stageId: "produce",
  });
  assert.equal(workboard.cards[0].status, "ready");
  assert.equal(workboard.cards[0].metadata.claim, undefined);
  assert.equal(workboard.cards[0].metadata.failureCount, 0);
  assert.deepEqual(workboard.resetCalls.map(({ id, beforeRelease }) => ({ id, beforeRelease })), [
    { id: "card-produce-done", beforeRelease: workboard.releaseCalls.length - 1 },
  ]);
  assert.deepEqual(workboard.releaseCalls.at(-1), { id: "card-produce-done", status: "ready" });
  assert.match(workboard.updateCalls.at(-1).patch.idempotencyKey, /^nightshift:[a-f0-9]{64}$/);
  assert.ok(workboard.updateCalls.at(-1).patch.idempotencyKey.length <= 160);
  assert.equal(workboard.cards[0].maxRuntimeSeconds, 14_400);
  assert.match(workboard.cards[0].notes, /\{"version":1/);
  assert.match(workboard.cards[0].notes, /reused\+executing/);
  deliveryValid = true;
  workboard.cards[0].status = "done";
  await runtime.reconcile("NS-RUNTIME-INVALID-DELIVERY");
  assert.equal(workboard.cards[0].status, "done");
  assert.equal(workboard.cards[1].status, "review");
  assert.ok(store.listEvents("NS-RUNTIME-INVALID-DELIVERY").some((event) => event.type === "stage.downstream.reopened"));
  store.close();
});

test("moves a terminal project to done and subsequent scheduler ticks stay idle", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-TERMINAL",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    contentItems: [{ id: "video-1", title: "Terminal video", route: "AI_GENERATE" }],
  });
  store.upsertStageRun({ instanceId: "NS-RUNTIME-TERMINAL", stageId: "plan", status: "done" });
  for (const stage of release.manifest.spec.stages.filter((entry) => entry.scope === "content-item")) {
    store.upsertContentItemRun({
      instanceId: "NS-RUNTIME-TERMINAL",
      contentItemId: "video-1",
      stageId: stage.id,
      status: "done",
    });
  }
  const terminal = await runtime.tick("NS-RUNTIME-TERMINAL");
  assert.equal(terminal.instance.status, "done");
  const idle = await runtime.tick("NS-RUNTIME-TERMINAL", { dispatch: true });
  assert.deepEqual(idle.actions, []);
  assert.deepEqual(workboard.dispatchCalls, []);
  store.close();
});

test("download workflow completes without review or publication runs after aggregate delivery", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-DOWNLOAD-DONE",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    inputs: { deliveryMode: "download" },
    contentItems: [{ id: "video-1", title: "Download video", route: "AI_GENERATE" }],
  });
  store.upsertStageRun({ instanceId: "NS-RUNTIME-DOWNLOAD-DONE", stageId: "plan", status: "done" });
  store.upsertStageRun({ instanceId: "NS-RUNTIME-DOWNLOAD-DONE", stageId: "deliver-download", status: "done" });
  for (const stageId of ["route", "materials", "brief", "produce"]) {
    store.upsertContentItemRun({ instanceId: "NS-RUNTIME-DOWNLOAD-DONE", contentItemId: "video-1", stageId, status: "done" });
  }

  const result = await runtime.tick("NS-RUNTIME-DOWNLOAD-DONE");

  assert.equal(result.instance.status, "done");
  assert.deepEqual(result.actions, []);
  assert.ok(!store.listContentItemRuns("NS-RUNTIME-DOWNLOAD-DONE").some((run) => ["review", "publish-feedback"].includes(run.stageId)));
  store.close();
});

function publicationTarget() {
  return {
    accountRecordId: "account-1",
    tiktokHandle: "@fixture",
    geelarkDeviceId: "device-1",
    platform: "TikTok",
    market: "US",
    language: "en-US",
    timezone: "America/New_York",
  };
}

class FakeWorkboard {
  constructor() {
    this.cards = [];
    this.blockCalls = [];
    this.releaseCalls = [];
    this.resetCalls = [];
    this.completeCalls = [];
    this.completeFailures = 0;
    this.dispatchCalls = [];
    this.updateCalls = [];
    this.sessions = new Map();
    this.sessionCalls = [];
    this.runOutcomes = new Map();
    this.runOutcomeCalls = [];
  }

  async listCards() {
    return this.cards;
  }

  // Mirrors the real adapter: a card carrying this action's idempotency marker
  // is reused. Without this the fake accepted every duplicate, which is why the
  // suite stayed green while production built 2,254 duplicate approval cards.
  async applyPlan(actions, { cards = null } = {}) {
    const known = cards ? [...cards] : [...this.cards];
    return actions.map((action) => {
      const marker = gatewayIdempotencyLabel(action.idempotencyKey ?? `${action.instanceId}:${action.stageId}:${action.contentItemId ?? ""}`);
      const existing = known.find((card) => (card.labels ?? []).includes(marker));
      if (existing) return { action, card: existing, status: "reused" };
      const card = action.card ?? {
        title: "Approval",
        status: "review",
        labels: [
          `instance:${action.instanceId}`,
          `stage:${action.stageId}`,
          ...(action.contentItemId ? [`content-item:${action.contentItemId}`] : []),
          "nightshift:approval",
        ],
      };
      // Mirrors the native board: a card whose release time has not arrived is
      // created in "scheduled", not in the status the plan asked for, and the
      // time lives under metadata.automation where the board keeps it.
      const { scheduledAt, ...rest } = card;
      const held = Number.isFinite(scheduledAt) && scheduledAt > this.now();
      const created = {
        id: `card-${this.cards.length + 1}`,
        ...rest,
        status: held ? "scheduled" : rest.status,
        // Like the native board: automation fields it does not know, such as
        // the attempt, do not come back in metadata.automation.
        ...(Number.isFinite(scheduledAt)
          ? { metadata: { ...(rest.metadata ?? {}), automation: { ...(rest.metadata?.automation ?? {}), scheduledAt } } }
          : {}),
        labels: [...new Set([...(card.labels ?? []), marker])],
      };
      this.cards.push(created);
      known.push(created);
      return { action, card: created, status: "created" };
    });
  }

  async moveCard(id, status) {
    const card = this.cards.find((entry) => entry.id === id);
    // Mirrors the native board's hold: a card still waiting for its release
    // time cannot be moved anywhere but "done".
    const at = card.metadata?.automation?.scheduledAt;
    if (status !== "done" && Number.isFinite(at) && at > this.now()) {
      throw new Error("card is scheduled for later.");
    }
    card.status = status;
    return card;
  }

  async updateCard(id, patch) {
    this.updateCalls.push({ id, patch });
    const card = this.cards.find((entry) => entry.id === id);
    Object.assign(card, patch);
    return card;
  }

  // Mirrors the native board's reassign reset: failureCount goes to zero.
  async resetCardFailures(id, reason) {
    this.resetCalls.push({ id, reason, beforeRelease: this.releaseCalls.length });
    const card = this.cards.find((entry) => entry.id === id);
    card.metadata = { ...(card.metadata ?? {}), failureCount: 0 };
    return card;
  }

  async releaseCard(id, status) {
    this.releaseCalls.push({ id, status });
    const card = this.cards.find((entry) => entry.id === id);
    card.status = status;
    card.metadata = { ...(card.metadata ?? {}), claim: undefined };
    return card;
  }

  now() {
    return this.clock ?? Date.now();
  }

  // Mirrors the native board: the scoped dispatch RPC first promotes cards whose
  // release time has passed, then refuses to start any card still held.
  async dispatch(maxStarts, options) {
    this.dispatchCalls.push({ maxStarts, options });
    const now = this.now();
    const promoted = [];
    for (const card of this.cards) {
      if (card.status !== "scheduled") continue;
      const at = card.metadata?.automation?.scheduledAt;
      if (Number.isFinite(at) && at > now) continue;
      card.status = "ready";
      promoted.push(card);
    }
    const scoped = options?.cardIds ? new Set(options.cardIds) : null;
    const startable = this.cards.filter((card) =>
      card.status === "ready" && (!scoped || scoped.has(card.id)));
    if (this.startOnDispatch !== true) return { promoted, started: [] };
    const started = startable.slice(0, maxStarts ?? 1).map((card) => {
      card.status = "running";
      return { card };
    });
    return { promoted, started };
  }



  async getRunOutcome({ runId }) {
    this.runOutcomeCalls.push(runId);
    return this.runOutcomes.get(runId) ?? null;
  }

  async getSession(sessionKey) {
    this.sessionCalls.push(sessionKey);
    return this.sessions.get(sessionKey) ?? { messages: [] };
  }

  async completeCard(id, input) {
    this.completeCalls.push({ id, ...input });
    if (this.completeFailures > 0) {
      this.completeFailures -= 1;
      throw new Error("completion callback unavailable");
    }
    const card = this.cards.find((entry) => entry.id === id);
    card.status = "done";
    card.execution = { ...(card.execution ?? {}), status: "done" };
    return card;
  }

  async blockCard(id, input) {
    this.blockCalls.push({ id, ...input });
    const card = this.cards.find((entry) => entry.id === id);
    card.status = "blocked";
    card.execution = { ...(card.execution ?? {}), status: "blocked" };
    return card;
  }
}

test("instance concurrency accounts for occupied native and human slots", async () => {
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(await readFile(workflowPath, "utf8"));
  const id = "NS-OCCUPIED";
  runtime.startInstance({ id, workflowSha256: release.workflowSha256, agentBindings: { "content-operator": "main" } });
  for (let index = 0; index < release.manifest.spec.concurrency.perInstance; index++) {
    workboard.cards.push({ id: `occupied-${index}`, status: "running", labels: [`instance:${id}`] });
  }
  await runtime.tick(id, { dispatch: true });
  assert.deepEqual(workboard.dispatchCalls, []);
  store.close();
});

test("artifact recovery applies to plan and retains exact missing-output diagnostics", async () => {
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  let complete = false;
  const runtime = new NightShiftRuntime({ store, workboard, completionValidator: async () => {
    if (!complete) throw new Error("Completion artifact not found: content-items.json");
  } });
  const release = runtime.publish(await readFile(workflowPath, "utf8"));
  runtime.startInstance({ id: "NS-RECOVERY", workflowSha256: release.workflowSha256 });
  workboard.cards.push({ id: "plan", status: "blocked", sessionKey: "native-session", runId: "native-run", labels: ["instance:NS-RECOVERY", "stage:plan"] });
  await runtime.reconcile("NS-RECOVERY");
  assert.match(store.listStageRuns("NS-RECOVERY")[0].summary, /content-items.json/);
  assert.equal(workboard.cards[0].status, "blocked");
  complete = true;
  await runtime.reconcile("NS-RECOVERY");
  assert.equal(workboard.cards[0].status, "done");
  store.close();
});


test("deferred completion validation cannot unlock downstream work", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({store, workboard, completionValidator: async () => { throw new Error("artifact missing"); }});
  const release = runtime.publish(source);
  runtime.startInstance({id: "NS-DEFERRED", workflowSha256: release.workflowSha256, agentBindings: {"content-operator": "main"}, inputs: {targetCount: 1}});
  await runtime.tick("NS-DEFERRED");
  workboard.cards[0].status = "done";
  workboard.cards[0].sessionKey = "agent:main:subagent:deferred";
  runtime.setContentItems("NS-DEFERRED", [{id: "item", title: "Item", route: "SCENE_EDIT"}]);
  runtime.terminalInspectionStarts = Array(3).fill(Date.now());
  const result = await runtime.tick("NS-DEFERRED");
  assert(result.retryAfterMs > 0 && result.retryAfterMs <= 30000);
  assert.equal(result.actions.length, 0);
  assert.notEqual(store.listStageRuns("NS-DEFERRED")[0].status, "done");
  runtime.terminalInspectionStarts = [];
  const checked = await runtime.tick("NS-DEFERRED");
  assert.equal(checked.retryAfterMs, null);
  assert.equal(store.listStageRuns("NS-DEFERRED")[0].status, "blocked");
  store.close();
});


test("never marks a cancelled legacy card done without a persisted output contract", async () => {
  const source = (await readFile(workflowPath, "utf8"))
    .replace("  completion: {mode: strict-v1}\n", "")
    .replace("  handoff: {version: 1, mode: stage-input-output}\n", "");
  const store = new NightShiftStore(), workboard = new FakeWorkboard();
  let validations = 0;
  const runtime = new NightShiftRuntime({ store, workboard, completionValidator: async () => { validations++; return {execution: {status: "reused"}}; } });
  const release = runtime.publish(source);
  runtime.startInstance({id: "NS-CANCELLED-LEGACY", workflowSha256: release.workflowSha256});
  workboard.cards.push({id: "cancelled-legacy", status: "blocked", sessionKey: "agent:main:subagent:cancelled-legacy", runId: "cancelled-run", execution: {status: "blocked", startedAt: 100}, labels: ["instance:NS-CANCELLED-LEGACY", "stage:plan"]});
  workboard.sessions.set("agent:main:subagent:cancelled-legacy", {messages: [{role: "toolResult", content: [{type: "text", text: "Aborted"}], timestamp: 200}]});
  await runtime.reconcile("NS-CANCELLED-LEGACY");
  assert.equal(validations, 0);
  assert.equal(workboard.cards[0].status, "blocked");
  assert.equal(workboard.completeCalls.length, 0);
  assert.notEqual(store.listStageRuns("NS-CANCELLED-LEGACY")[0].status, "done");
  store.close();
});

// Production carried 2,288 cards; a tick that lists the whole board costs the
// shared Gateway a main-thread walk of every card. A project reads by exact ID.
test("ticks and retries after the first read the board by the project's card ids", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const listCalls = [];
  const original = workboard.listCards.bind(workboard);
  workboard.listCards = async (options) => { listCalls.push(options); return original(options); };
  const runtime = new NightShiftRuntime({ board: "nightshift-lab", store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-SCOPED",
    name: "Scoped reads",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    inputs: { targetCount: 1 },
  });
  await runtime.tick("NS-RUNTIME-SCOPED");
  const created = workboard.cards.map((card) => card.id);
  assert.ok(created.length > 0);
  await runtime.tick("NS-RUNTIME-SCOPED");
  assert.ok(listCalls.length >= 2);
  assert.deepEqual(listCalls[0], { cardIds: [] });
  assert.deepEqual(listCalls.at(-1), { cardIds: created });
  assert.ok(listCalls.every((call) => Array.isArray(call?.cardIds)), "every board read is scoped");
});

// Native Workboard creates a dependent human card in todo and promotes it to
// ready once its upstream completes. On the shared VLab six review cards were
// dispatched that way and blocked with "Dispatcher could not start worker".
test("a human stage card promoted to ready natively is returned to review and never dispatched", async () => {
  const source = await readFile(resolve(here, "./fixtures/auditable-attempt.workflow.md"), "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ board: "nightshift-lab", store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-HUMAN-READY",
    name: "Human stage promotion",
    workflowSha256: release.workflowSha256,
    agentBindings: { operator: "main" },
    inputs: { row: "one" },
  });
  await runtime.tick("NS-HUMAN-READY", { dispatch: true });
  const plan = workboard.cards.find((card) => card.labels.includes("stage:plan"));
  assert.ok(plan);
  plan.status = "done";
  plan.sessionKey = "agent:main:subagent:plan";
  await runtime.tick("NS-HUMAN-READY", { dispatch: true });
  const review = workboard.cards.find((card) => card.labels.includes("stage:review"));
  assert.ok(review, "review card is created after plan completes");
  assert.equal(review.status, "review");
  review.status = "ready";
  workboard.dispatchCalls.length = 0;
  await runtime.tick("NS-HUMAN-READY", { dispatch: true });
  assert.equal(review.status, "review");
  assert.equal(store.listStageRuns("NS-HUMAN-READY").find((run) => run.stageId === "review")?.status, "review");
  assert.ok(workboard.dispatchCalls.every((call) => !call.options.cardIds.includes(review.id)), "human card is never dispatched");
});

// PR #33 scoped the board read to the cards recorded on stage and content-item
// runs. An approval card is neither, so the idempotency scan stopped seeing it
// and built another one on every pass: TK-0917-02 reached 1,346 duplicates in a
// day, while a project from before the change held 8 across 181,032 passes.
test("an approval card is reused when the board read is scoped to this project", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-APPROVAL-SCOPE",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
  });
  store.upsertStageRun({ instanceId: "NS-APPROVAL-SCOPE", stageId: "plan", status: "done" });
  runtime.setContentItems("NS-APPROVAL-SCOPE", [{ id: "video-1", title: "First video", route: "AI_GENERATE" }]);
  for (const stageId of ["route", "materials", "brief"]) {
    store.upsertContentItemRun({ instanceId: "NS-APPROVAL-SCOPE", contentItemId: "video-1", stageId, status: "done" });
  }
  const first = await runtime.tick("NS-APPROVAL-SCOPE");
  assert.equal(first.actions[0].type, "request_approval");
  assert.equal(first.applied[0].status, "created");
  const approvalCardId = first.applied[0].card.id;

  // The ledger is what a scoped read has to go on: the approval card carries no run.
  const scoped = instanceCardIds(store, "NS-APPROVAL-SCOPE");
  assert.ok(scoped.includes(approvalCardId), "the approval card must be reachable by a scoped read");

  // Replay the scheduler: hand the tick only the cards that scope resolves to.
  for (let pass = 0; pass < 3; pass += 1) {
    const cards = workboard.cards.filter((card) => instanceCardIds(store, "NS-APPROVAL-SCOPE").includes(card.id));
    const again = await runtime.tick("NS-APPROVAL-SCOPE", { cards });
    assert.equal(again.applied[0].status, "reused", `pass ${pass + 1} rebuilt the approval card`);
    assert.equal(again.applied[0].card.id, approvalCardId);
  }
  assert.equal(
    workboard.cards.filter((card) => (card.labels ?? []).includes("nightshift:approval")).length,
    1,
    "three further passes must not add approval cards",
  );
  store.close();
});

const timedReleasePath = resolve(here, "./fixtures/timed-release.workflow.md");

// End to end, through the board: a finished video whose publication must wait
// for the evening window in New York. The card exists the whole time, the board
// holds it, and the same scoped dispatch that Night Shift already makes is what
// releases it.
async function timedRelease(clock) {
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  workboard.clock = clock;
  workboard.startOnDispatch = true;
  const runtime = new NightShiftRuntime({ board: "nightshift-lab", store, workboard });
  const release = runtime.publish(await readFile(timedReleasePath, "utf8"));
  const id = "NS-TIMED";
  runtime.startInstance({
    id,
    workflowSha256: release.workflowSha256,
    agentBindings: { operator: "main" },
    inputs: { timezone: "America/New_York" },
  });
  // The first stage is done; publication is the only thing left.
  await runtime.tick(id, { dispatch: false, now: clock });
  const finish = workboard.cards.find((card) => (card.labels ?? []).includes("stage:finish"));
  finish.status = "done";
  finish.execution = { status: "done" };
  await runtime.reconcile(id, workboard.cards, { inspectSessions: false });
  return { store, workboard, runtime, id };
}

const EVENING = Date.parse("2026-09-18T01:00:00Z"); // 21:00 in New York
const AFTERNOON = Date.parse("2026-09-17T18:00:00Z");

test("a publication card is held by the board until its release moment, not withheld from it", async () => {
  const { store, workboard, runtime, id } = await timedRelease(AFTERNOON);
  const result = await runtime.tick(id, { dispatch: true, inspectSessions: false, now: AFTERNOON });
  const publish = workboard.cards.find((card) => (card.labels ?? []).includes("stage:publish"));

  // The card is on the board, visible, carrying its moment.
  assert.ok(publish, "the publication card must exist while it waits");
  assert.equal(publish.status, "scheduled");
  assert.equal(publish.metadata.automation.scheduledAt, EVENING);
  // And nothing started it.
  assert.deepEqual(result.dispatch?.started ?? [], []);
  assert.equal(publish.status, "scheduled");
  store.close();
});

test("the board refuses to start a held publication card early", async () => {
  const { store, workboard, runtime, id } = await timedRelease(AFTERNOON);
  await runtime.tick(id, { dispatch: true, inspectSessions: false, now: AFTERNOON });
  const publish = workboard.cards.find((card) => (card.labels ?? []).includes("stage:publish"));
  await assert.rejects(workboard.moveCard(publish.id, "running"), /scheduled for later/);
  store.close();
});

test("a held publication card is not planned again on the next pass", async () => {
  const { store, workboard, runtime, id } = await timedRelease(AFTERNOON);
  await runtime.tick(id, { dispatch: true, inspectSessions: false, now: AFTERNOON });
  const before = workboard.cards.length;
  await runtime.tick(id, { dispatch: true, inspectSessions: false, now: AFTERNOON });
  await runtime.tick(id, { dispatch: true, inspectSessions: false, now: AFTERNOON });
  assert.equal(workboard.cards.length, before, "three passes must not leave three cards");
  store.close();
});

test("the pass asks to be woken at the release moment", async () => {
  const { store, runtime, id } = await timedRelease(AFTERNOON);
  const result = await runtime.tick(id, { dispatch: true, inspectSessions: false, now: AFTERNOON });
  // The scheduler turns this into its next wake, so the release lands on time
  // instead of waiting for the five-minute repair pass.
  const wakeAt = AFTERNOON + result.retryAfterMs;
  assert.ok(Math.abs(wakeAt - EVENING) < 5_000, `expected a wake near the release moment, got ${new Date(wakeAt).toISOString()}`);
  store.close();
});

test("the wake survives a restart, because it is read back off the held card", async () => {
  const { store, workboard, runtime, id } = await timedRelease(AFTERNOON);
  await runtime.tick(id, { dispatch: true, inspectSessions: false, now: AFTERNOON });
  // A second runtime over the same store and board, as after a service restart:
  // no planned action carries the moment any more, only the card does.
  const restarted = new NightShiftRuntime({ board: "nightshift-lab", store, workboard });
  const result = await restarted.tick(id, { dispatch: true, inspectSessions: false, now: AFTERNOON });
  const wakeAt = AFTERNOON + result.retryAfterMs;
  assert.ok(Math.abs(wakeAt - EVENING) < 5_000, `restart lost the release wake, got ${result.retryAfterMs}`);
  store.close();
});

test("the release happens on the scoped dispatch Night Shift already makes", async () => {
  const { store, workboard, runtime, id } = await timedRelease(AFTERNOON);
  await runtime.tick(id, { dispatch: true, inspectSessions: false, now: AFTERNOON });
  const publish = workboard.cards.find((card) => (card.labels ?? []).includes("stage:publish"));
  assert.equal(publish.status, "scheduled");

  // The evening arrives. No new RPC, no cron job: the same dispatch call.
  workboard.clock = EVENING;
  const result = await runtime.tick(id, { dispatch: true, inspectSessions: false, now: EVENING });
  assert.deepEqual(result.dispatch.promoted.map((card) => card.id), [publish.id]);
  assert.deepEqual(result.dispatch.started.map((entry) => entry.card.id), [publish.id]);
  assert.equal(publish.status, "running");
  store.close();
});

test("a human stage cannot be given a release time it would never come back from", async () => {
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  workboard.clock = AFTERNOON;
  const runtime = new NightShiftRuntime({ board: "nightshift-lab", store, workboard });
  const source = (await readFile(timedReleasePath, "utf8")).replace("actor: agent\nscope: project\nskills: [background-worker-contract]\nneeds: [finish]", "actor: human\nscope: project\nneeds: [finish]");
  // Only agent and system cards enter the dispatch scope, and the dispatch scope
  // is the only thing that promotes a held card. A human stage with a release
  // time would sit in scheduled forever, so refuse it at publish time.
  assert.throws(() => runtime.publish(source), (error) => (error.issues ?? []).some((issue) => issue.code === "stage.releaseAt.actor"));
  store.close();
});

// On V (2026-09-28) two paid produce cards sat blocked for two hours: their
// Worker exited while the Agent was polling Makaron, so the Session never got a
// terminal message and every inspection read "not terminal".
function orphanedCard({ id, instanceId, stageId, contentItemId, silentMinutes }) {
  const now = Date.now();
  return {
    card: {
      id,
      status: "blocked",
      sessionKey: `agent:main:subagent:${id}`,
      runId: `run-${id}`,
      execution: { status: "running", startedAt: now - (silentMinutes + 10) * 60_000 },
      labels: [`instance:${instanceId}`, `stage:${stageId}`, ...(contentItemId ? [`content-item:${contentItemId}`] : [])],
    },
    session: { messages: [{ role: "toolResult", content: "still running", timestamp: now - silentMinutes * 60_000 }] },
  };
}

async function orphanFixture({ id, stageId, contentItemId = "video-1", silentMinutes = 50, runtimeOptions = {} }) {
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard, ...runtimeOptions });
  const release = runtime.publish(await readFile(workflowPath, "utf8"));
  runtime.startInstance({ id, workflowSha256: release.workflowSha256, agentBindings: { "content-operator": "main" } });
  const item = stageId === "plan" ? null : contentItemId;
  if (item) runtime.setContentItems(id, [{ id: item, title: "Orphaned video", route: "SCENE_EDIT" }]);
  const { card, session } = orphanedCard({ id: `card-${id}`, instanceId: id, stageId, contentItemId: item, silentMinutes });
  workboard.cards.push(card);
  workboard.sessions.set(card.sessionKey, session);
  return { card, runtime, store, workboard };
}

function attemptFailures(store, instanceId) {
  return store.listEvents(instanceId).filter((event) => event.type === "stage.attempt.failed");
}

test("a blocked card whose Session has gone silent is failed as interrupted and scheduled for retry", async () => {
  const { runtime, store } = await orphanFixture({ id: "NS-ORPHAN-PLAN", stageId: "plan" });
  await runtime.reconcile("NS-ORPHAN-PLAN");
  const [event] = attemptFailures(store, "NS-ORPHAN-PLAN");
  assert.equal(event.payload.failure.kind, "agent_interrupted");
  assert.match(event.payload.failure.rawError, /silent for 50 min/);
  assert.equal(event.payload.failure.automaticRetry, true);
  assert.ok(event.payload.failure.nextRetryAt);
  store.close();
});

test("a recently active blocked Session is left alone", async () => {
  const { runtime, store, workboard } = await orphanFixture({ id: "NS-ORPHAN-RECENT", stageId: "plan", silentMinutes: 10 });
  await runtime.reconcile("NS-ORPHAN-RECENT");
  assert.equal(attemptFailures(store, "NS-ORPHAN-RECENT").length, 0);
  assert.equal(workboard.cards[0].status, "blocked");
  store.close();
});

test("an orphaned paid card is not retried automatically without a ledger entry", async () => {
  const { runtime, store } = await orphanFixture({ id: "NS-ORPHAN-UNPAID", stageId: "produce" });
  await runtime.reconcile("NS-ORPHAN-UNPAID");
  const [event] = attemptFailures(store, "NS-ORPHAN-UNPAID");
  assert.equal(event.payload.failure.kind, "agent_interrupted");
  assert.equal(event.payload.failure.automaticRetry, false);
  assert.match(event.payload.summary, /需要人工检查后重试/);
  store.close();
});

test("an orphaned paid card whose provider task is on the ledger resumes automatically", async () => {
  const { card, runtime, store } = await orphanFixture({ id: "NS-ORPHAN-PAID", stageId: "produce" });
  const operation = {
    idempotencyKey: "NS-ORPHAN-PAID:video-1:produce",
    instanceId: "NS-ORPHAN-PAID",
    contentItemId: "video-1",
    stageId: "produce",
    ownerCardId: card.id,
    requestHash: "request-sha",
  };
  store.reserveExternalOperation(operation);
  store.checkpointExternalOperation(operation.idempotencyKey, { status: "executing", externalTaskId: "makaron-task-1" });
  await runtime.reconcile("NS-ORPHAN-PAID");
  const [event] = attemptFailures(store, "NS-ORPHAN-PAID");
  assert.equal(event.payload.failure.automaticRetry, true);
  store.close();
});

// On V (2026-09-29) a brief card was blocked 7 s after dispatch with an empty
// Session, and reached a person as "the handoff is missing".
async function notStartedFixture({ id, stageId, startedMinutesAgo = 5 }) {
  const fixture = await orphanFixture({ id, stageId });
  fixture.card.execution.startedAt = Date.now() - startedMinutesAgo * 60_000;
  fixture.workboard.sessions.set(fixture.card.sessionKey, { messages: [] });
  return fixture;
}

test("a blocked card whose Agent never took a turn is retried as a start failure, not sent to a person", async () => {
  const { runtime, store, workboard } = await notStartedFixture({ id: "NS-NOT-STARTED", stageId: "plan" });
  await runtime.reconcile("NS-NOT-STARTED");
  const [event] = attemptFailures(store, "NS-NOT-STARTED");
  assert.equal(event.payload.failure.kind, "agent_not_started");
  assert.equal(event.payload.failure.automaticRetry, true);
  assert.match(event.payload.summary, /Agent 没能启动/);
  assert.equal(store.listEvents("NS-NOT-STARTED").some((entry) => entry.type === "stage.completion.rejected"), false);
  assert.equal(workboard.cards[0].status, "blocked");
  store.close();
});

test("an empty Session is not read as a start failure while its transcript may still be arriving", async () => {
  const { runtime, store } = await notStartedFixture({ id: "NS-NOT-STARTED-FRESH", stageId: "plan", startedMinutesAgo: 1 });
  await runtime.reconcile("NS-NOT-STARTED-FRESH");
  assert.equal(attemptFailures(store, "NS-NOT-STARTED-FRESH").length, 0);
  store.close();
});

test("a paid card that never started retries without a ledger entry: it cannot have spent anything", async () => {
  const { runtime, store } = await notStartedFixture({ id: "NS-NOT-STARTED-PAID", stageId: "produce" });
  await runtime.reconcile("NS-NOT-STARTED-PAID");
  const [event] = attemptFailures(store, "NS-NOT-STARTED-PAID");
  assert.equal(event.payload.failure.kind, "agent_not_started");
  assert.equal(event.payload.failure.automaticRetry, true);
  store.close();
});

test("a paid card that never started still waits for a person when an earlier attempt left a reservation open", async () => {
  const { card, runtime, store } = await notStartedFixture({ id: "NS-NOT-STARTED-RESERVED", stageId: "produce" });
  store.reserveExternalOperation({
    idempotencyKey: "NS-NOT-STARTED-RESERVED:video-1:produce",
    instanceId: "NS-NOT-STARTED-RESERVED",
    contentItemId: "video-1",
    stageId: "produce",
    ownerCardId: card.id,
    requestHash: "request-sha",
  });
  await runtime.reconcile("NS-NOT-STARTED-RESERVED");
  const [event] = attemptFailures(store, "NS-NOT-STARTED-RESERVED");
  assert.equal(event.payload.failure.automaticRetry, false);
  assert.match(event.payload.summary, /需要人工检查后重试/);
  store.close();
});

test("blocked-card inspection has its own budget and a deferred card is read on the next ordinary pass", async () => {
  // An injected clock: a 1 ms real-time window let a slow machine reset the
  // budget between the two cards of one pass and read both (flaky on CI).
  let clock = Date.now();
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({
    store, workboard, terminalInspectionMaxStarts: 1, terminalInspectionWindowMs: 30_000, now: () => clock,
  });
  const release = runtime.publish(await readFile(workflowPath, "utf8"));
  runtime.startInstance({ id: "NS-ORPHAN-BUDGET", workflowSha256: release.workflowSha256 });
  for (const suffix of ["a", "b"]) {
    const { card, session } = orphanedCard({ id: `budget-${suffix}`, instanceId: "NS-ORPHAN-BUDGET", stageId: "plan", silentMinutes: 50 });
    workboard.cards.push(card);
    workboard.sessions.set(card.sessionKey, session);
  }
  // Completion validation exhausting its budget does not touch this one.
  runtime.consumeTerminalInspectionBudget();
  await runtime.reconcile("NS-ORPHAN-BUDGET", null, { inspectSessions: true });
  assert.equal(workboard.sessionCalls.length, 1);
  clock += 31_000;
  await runtime.reconcile("NS-ORPHAN-BUDGET", null, { inspectSessions: false });
  assert.equal(workboard.sessionCalls.length, 2, "the deferred card is read without waiting for a repair pass");
  assert.equal(attemptFailures(store, "NS-ORPHAN-BUDGET").length, 2);
  store.close();
});

// Only stops a person can act on reach 需要你. On V (2026-09-28/29) eight of ten
// requests were runs the Gateway had recorded as failed, timed out or still
// running; the engine read the transcripts instead and sent them to people.
async function stoppedRun({ id, stageId, outcome, session, runtimeOptions = {}, validator = async () => { throw new Error("Stage handoff is required: plan"); } }) {
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  let clock = Date.now();
  const needsYou = new NeedsYouTracker({ store, now: () => clock });
  const runtime = new NightShiftRuntime({ store, workboard, needsYou, completionValidator: validator, now: () => clock, ...runtimeOptions });
  const release = runtime.publish(await readFile(workflowPath, "utf8"));
  runtime.startInstance({ id, workflowSha256: release.workflowSha256, agentBindings: { "content-operator": "main" } });
  const item = stageId === "plan" ? null : "video-1";
  if (item) runtime.setContentItems(id, [{ id: item, title: "Video", route: "SCENE_EDIT" }]);
  const card = {
    id: `card-${id}`,
    status: "blocked",
    sessionKey: `agent:main:subagent:${id}`,
    runId: `run-${id}`,
    execution: { status: "blocked", startedAt: clock - 5 * 60_000 },
    labels: [`instance:${id}`, `stage:${stageId}`, ...(item ? [`content-item:${item}`] : [])],
  };
  workboard.cards.push(card);
  workboard.sessions.set(card.sessionKey, session ?? { messages: [
    { role: "assistant", content: [{ type: "text", text: "Now let me build the four outputs + handoff." }], stopReason: "toolUse", timestamp: clock - 3 * 60_000 },
    { role: "toolResult", content: "wrote content-items.json", timestamp: clock - 3 * 60_000 },
  ] });
  if (outcome) workboard.runOutcomes.set(card.runId, outcome);
  return { card, needsYou, runtime, store, workboard, advance: (ms) => { clock += ms; } };
}

function openRequests(store, instanceId) {
  return store.listDecisionRequests({ instanceId });
}

test("a run the Gateway recorded as failed on an Agent DB lease is retried and never announced", async () => {
  const { runtime, store } = await stoppedRun({
    id: "NS-RUN-LEASE", stageId: "plan",
    outcome: { status: "failed", error: "Agent DB process coordinator wait exceeded 5000ms | V_AGENT_DB_PROCESS_COORDINATOR_TIMEOUT" },
  });
  await runtime.reconcile("NS-RUN-LEASE", null, { inspectSessions: true });
  const [event] = attemptFailures(store, "NS-RUN-LEASE");
  assert.equal(event.payload.failure.kind, "database_lock");
  assert.equal(event.payload.failure.automaticRetry, true);
  assert.equal(store.listEvents("NS-RUN-LEASE").some((entry) => entry.type === "stage.completion.rejected"), false);
  assert.equal(openRequests(store, "NS-RUN-LEASE").length, 0);
  store.close();
});

test("a run that failed with no named cause is an interruption, not the Agent's verdict", async () => {
  const { runtime, store } = await stoppedRun({ id: "NS-RUN-FAILED", stageId: "plan", outcome: { status: "failed", error: "Agent run failed" } });
  await runtime.reconcile("NS-RUN-FAILED", null, { inspectSessions: true });
  const [event] = attemptFailures(store, "NS-RUN-FAILED");
  assert.equal(event.payload.failure.kind, "agent_interrupted");
  assert.equal(event.payload.failure.automaticRetry, true);
  assert.equal(openRequests(store, "NS-RUN-FAILED").length, 0);
  store.close();
});

test("a paid card whose run timed out before any reservation is retried: the ledger says nothing was spent", async () => {
  const { runtime, store } = await stoppedRun({
    id: "NS-RUN-PAID-TIMEOUT", stageId: "produce",
    outcome: { status: "timed_out", error: "Request timed out before a response was generated." },
  });
  await runtime.reconcile("NS-RUN-PAID-TIMEOUT", null, { inspectSessions: true });
  const [event] = attemptFailures(store, "NS-RUN-PAID-TIMEOUT");
  assert.equal(event.payload.failure.automaticRetry, true);
  assert.equal(openRequests(store, "NS-RUN-PAID-TIMEOUT").length, 0);
  store.close();
});

test("a paid card whose run failed before submitting goes on by itself as one fresh, paid attempt", async () => {
  // wsfood-es-28 on V, 2026-10-08: the run died on a model error after
  // registering its paid call and before submitting it. Retrying the same card
  // met the same registration; only a fresh attempt can go on. That is the
  // one extra payment the engine may make by itself (Tianyi, 2026-10-08).
  const { card, runtime, store, workboard, advance } = await stoppedRun({
    id: "NS-RUN-PAID-OPEN", stageId: "produce", outcome: { status: "failed", error: "Agent run failed" },
  });
  store.reserveExternalOperation({
    idempotencyKey: "NS-RUN-PAID-OPEN:video-1:produce",
    instanceId: "NS-RUN-PAID-OPEN",
    contentItemId: "video-1",
    stageId: "produce",
    ownerCardId: card.id,
    requestHash: "request-sha",
  });
  store.upsertContentItemRun({ instanceId: "NS-RUN-PAID-OPEN", contentItemId: "video-1", stageId: "produce", attempt: 1, cardId: card.id, status: "blocked" });
  await runtime.reconcile("NS-RUN-PAID-OPEN", null, { inspectSessions: true });
  const [event] = attemptFailures(store, "NS-RUN-PAID-OPEN");
  assert.equal(event.payload.failure.automaticRetry, false);
  assert.equal(openRequests(store, "NS-RUN-PAID-OPEN").length, 0, "nothing a person can do");
  advance(3 * 60_000);
  await runtime.reconcile("NS-RUN-PAID-OPEN", null, { inspectSessions: true });
  const [recovered] = store.listEvents("NS-RUN-PAID-OPEN").filter((entry) => entry.type === "stage.stop.recovered");
  assert.deepEqual([recovered.payload.how, recovered.payload.paid], ["fresh", true]);
  assert.equal(store.listContentItemRevisions("NS-RUN-PAID-OPEN").length, 1);
  assert.equal(card.status, "blocked", "the stopped card is left; the planner makes the new one");
  assert.equal(workboard.cards.length, 1);
  store.close();
});


test("a blocked card whose run is still going is left alone: not failed, not salvaged, not announced", async () => {
  // DL-0929-01 item 9: blocked at 16:38 while its Agent kept working; it
  // finished the video at 16:41, three minutes after reaching a person.
  const { runtime, store, workboard, advance } = await stoppedRun({ id: "NS-RUN-ACTIVE", stageId: "produce", outcome: { status: "running" } });
  let validations = 0;
  runtime.completionValidator = async () => { validations += 1; throw new Error("External side effect has no succeeded Night Shift operation checkpoint"); };
  await runtime.reconcile("NS-RUN-ACTIVE", null, { inspectSessions: true });
  await runtime.reconcile("NS-RUN-ACTIVE", null, { inspectSessions: false });
  assert.equal(attemptFailures(store, "NS-RUN-ACTIVE").length, 0);
  assert.equal(validations, 0);
  assert.equal(workboard.sessionCalls.length, 0, "the Gateway's answer is enough; the transcript is not read");
  advance(10 * 60_000);
  await runtime.reconcile("NS-RUN-ACTIVE", null, { inspectSessions: true });
  assert.equal(openRequests(store, "NS-RUN-ACTIVE").length, 0);
  store.close();
});

test("a run that ended normally is still judged by the Agent's report and reaches a person", async () => {
  // DL-0928-07 item 1: the Agent blocked because Makaron failed twice; its run
  // ended normally. This is what 需要你 is for.
  const { runtime, store } = await stoppedRun({
    id: "NS-RUN-REPORT", stageId: "plan", outcome: { status: "completed" },
    session: { messages: [{ role: "assistant", stopReason: "stop", timestamp: Date.now() - 60_000, content: [{ type: "text", text: "需要人做：请在 Scene 里补至少 5 段不同的视频素材\n原因：只有 1 段视频，撑不起 30 条混剪" }] }] },
  });
  await runtime.reconcile("NS-RUN-REPORT", null, { inspectSessions: true });
  const [request] = openRequests(store, "NS-RUN-REPORT");
  assert.ok(request, "the Agent's own stop is announced");
  assert.equal(request.problem, "请在 Scene 里补至少 5 段不同的视频素材");
  assert.equal(request.cause, "只有 1 段视频，撑不起 30 条混剪");
  store.close();
});

test("without the Gateway's answer, outputs that are not there are no verdict: the card waits, the board says what is missing", async () => {
  const { runtime, store, advance } = await stoppedRun({ id: "NS-RUN-UNKNOWN", stageId: "plan", outcome: null });
  await runtime.reconcile("NS-RUN-UNKNOWN", null, { inspectSessions: true });
  assert.equal(attemptFailures(store, "NS-RUN-UNKNOWN").length, 0);
  assert.equal(store.listEvents("NS-RUN-UNKNOWN").some((entry) => entry.type === "stage.completion.rejected"), false);
  assert.match(store.listStageRuns("NS-RUN-UNKNOWN")[0].summary, /Outputs not found yet: Stage handoff is required/);
  advance(10 * 60_000);
  await runtime.reconcile("NS-RUN-UNKNOWN", null, { inspectSessions: true });
  assert.equal(openRequests(store, "NS-RUN-UNKNOWN").length, 0, "no request while the engine can still explain it");
  store.close();
});

test("a run the Gateway saw end normally is never read as a start failure, even with an empty transcript", async () => {
  // Shared VLab, 2026-09-29 (NS-S4-STOP-0929): the run completed at 09:40:13
  // after three model calls, the transcript read back empty, and the empty-Session
  // rule failed it as never started. The Agent had stopped on purpose.
  const { runtime, store } = await stoppedRun({
    id: "NS-RUN-EMPTY-DONE", stageId: "plan", outcome: { status: "completed", endedAt: Date.now() - 4 * 60_000 },
    session: { messages: [] },
  });
  await runtime.reconcile("NS-RUN-EMPTY-DONE", null, { inspectSessions: true });
  assert.equal(attemptFailures(store, "NS-RUN-EMPTY-DONE").length, 0, "not a failure of the substrate");
  assert.ok(store.listEvents("NS-RUN-EMPTY-DONE").some((entry) => entry.type === "stage.terminal.blocked"));
  // It asked no person for anything: the engine goes on with it by itself.
  assert.equal(openRequests(store, "NS-RUN-EMPTY-DONE").length, 0);
  store.close();
});

test("a run that ended normally is judged on its outputs even when the transcript stops mid-tool", async () => {
  let complete = true;
  const { runtime, store, workboard } = await stoppedRun({
    id: "NS-RUN-DONE-MIDTOOL", stageId: "plan", outcome: { status: "succeeded" },
    validator: async () => { if (!complete) throw new Error("Stage handoff is required: plan"); },
  });
  await runtime.reconcile("NS-RUN-DONE-MIDTOOL", null, { inspectSessions: true });
  assert.equal(workboard.cards[0].status, "done");
  assert.equal(attemptFailures(store, "NS-RUN-DONE-MIDTOOL").length, 0);
  store.close();
});

// A project's own session limit, set while it runs (nightshiftctl projects
// concurrency). Unset, the Workflow's perInstance applies as before.
async function limitedProject({ id, workflowLimit, running }) {
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const source = (await readFile(workflowPath, "utf8")).replace("concurrency: {perInstance: 8}", `concurrency: {perInstance: ${workflowLimit}}`);
  const release = runtime.publish(source);
  runtime.startInstance({ id, workflowSha256: release.workflowSha256, agentBindings: { "content-operator": "main" } });
  for (let index = 0; index < running; index++) {
    workboard.cards.push({ id: `${id}-running-${index}`, status: "running", labels: [`instance:${id}`] });
  }
  return { runtime, store, workboard };
}

test("a project's own limit lowers its concurrency below the Workflow's", async () => {
  const { runtime, store, workboard } = await limitedProject({ id: "NS-LIMIT-LOW", workflowLimit: 8, running: 1 });
  store.setInstanceControl("NS-LIMIT-LOW", { perInstanceLimit: 1 });
  await runtime.tick("NS-LIMIT-LOW", { dispatch: true });
  assert.deepEqual(workboard.dispatchCalls, [], "one card already runs and the project allows one");
  store.close();
});

test("a project's own limit raises its concurrency above the Workflow's, and default restores it", async () => {
  const { runtime, store, workboard } = await limitedProject({ id: "NS-LIMIT-HIGH", workflowLimit: 1, running: 1 });
  await runtime.tick("NS-LIMIT-HIGH", { dispatch: true });
  assert.deepEqual(workboard.dispatchCalls, [], "the Workflow allows one");
  store.setInstanceControl("NS-LIMIT-HIGH", { perInstanceLimit: 3 });
  await runtime.tick("NS-LIMIT-HIGH", { dispatch: true });
  assert.equal(workboard.dispatchCalls.length, 1);
  assert.ok(workboard.dispatchCalls[0].maxStarts >= 1 && workboard.dispatchCalls[0].maxStarts <= 2);
  store.setInstanceControl("NS-LIMIT-HIGH", { perInstanceLimit: null });
  workboard.dispatchCalls.length = 0;
  await runtime.tick("NS-LIMIT-HIGH", { dispatch: true });
  assert.deepEqual(workboard.dispatchCalls, [], "back to the Workflow's one");
  store.close();
});

test("a paid card whose transcript ends on a lease timeout retries when its ledger holds nothing", async () => {
  // V, 2026-09-29 20:21: read while the board still showed the card running,
  // so the Gateway's run record was not consulted; the transcript's own error
  // is the same substrate fault and gets the same ledger rule.
  const { card, runtime, store, workboard } = await stoppedRun({
    id: "NS-TRANSCRIPT-LEASE", stageId: "produce", outcome: null,
    session: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "Agent DB process coordinator wait exceeded 5000ms", timestamp: Date.now() - 60_000, content: [] }] },
  });
  card.status = "running";
  card.execution.status = "running";
  await runtime.reconcile("NS-TRANSCRIPT-LEASE", null, { inspectSessions: true });
  const [event] = attemptFailures(store, "NS-TRANSCRIPT-LEASE");
  assert.equal(event.payload.failure.kind, "database_lock");
  assert.equal(event.payload.failure.automaticRetry, true);
  assert.equal(openRequests(store, "NS-TRANSCRIPT-LEASE").length, 0);
  store.close();
});

test("an Agent error read from the transcript is not a substrate fault: a paid card still waits for a person", async () => {
  const { card, runtime, store } = await stoppedRun({
    id: "NS-TRANSCRIPT-AGENT", stageId: "produce", outcome: null,
    session: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "tool refused the request", timestamp: Date.now() - 60_000, content: [] }] },
  });
  card.status = "running";
  card.execution.status = "running";
  await runtime.reconcile("NS-TRANSCRIPT-AGENT", null, { inspectSessions: true });
  const [event] = attemptFailures(store, "NS-TRANSCRIPT-AGENT");
  assert.equal(event.payload.failure.kind, "agent_error");
  assert.equal(event.payload.failure.automaticRetry, false);
  store.close();
});

test("a transcript that ends on an error is read against the Gateway's run record when the card still shows running", async () => {
  // V, 2026-09-29 21:05: the transcript said "incomplete or malformed tool call",
  // the Gateway said the provider request failed; either way a substrate fault.
  const { card, runtime, store, workboard } = await stoppedRun({
    id: "NS-RUNNING-ERROR", stageId: "plan",
    outcome: { status: "failed", error: "⚠️ deepseek/deepseek-flash request failed." },
    session: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider returned an incomplete or malformed tool call", timestamp: Date.now() - 60_000, content: [] }] },
  });
  card.status = "running";
  card.execution.status = "running";
  await runtime.reconcile("NS-RUNNING-ERROR", null, { inspectSessions: true });
  const [event] = attemptFailures(store, "NS-RUNNING-ERROR");
  assert.equal(event.payload.failure.kind, "provider_error");
  assert.equal(event.payload.failure.source, "provider");
  assert.equal(event.payload.failure.automaticRetry, true);
  assert.ok(workboard.runOutcomeCalls.includes(card.runId));
  assert.equal(openRequests(store, "NS-RUNNING-ERROR").length, 0);
  store.close();
});

test("an error in the transcript of a run the Gateway still has running is left alone", async () => {
  const { card, runtime, store } = await stoppedRun({
    id: "NS-RUNNING-RETRYING", stageId: "plan", outcome: { status: "running" },
    session: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "Connection error.", timestamp: Date.now() - 60_000, content: [] }] },
  });
  card.status = "running";
  card.execution.status = "running";
  await runtime.reconcile("NS-RUNNING-RETRYING", null, { inspectSessions: true });
  assert.equal(attemptFailures(store, "NS-RUNNING-RETRYING").length, 0);
  store.close();
});

test("faults of the substrate do not use up a stage's own retries", async () => {
  // V, 2026-09-29: e3f71162's third interruption (a Gateway restart) exhausted
  // produce's three attempts and opened a request.
  const { card, runtime, store } = await stoppedRun({
    id: "NS-SUBSTRATE-BUDGET", stageId: "produce",
    outcome: { status: "failed", error: "subagent run lost active execution context" },
  });
  for (const n of [1, 2, 3]) {
    store.appendEvent({ instanceId: "NS-SUBSTRATE-BUDGET", type: "stage.attempt.failed",
      payload: { cardId: card.id, stageId: "produce", failure: { kind: "database_lock", retryable: true, attempt: `old-${n}` } } });
  }
  await runtime.reconcile("NS-SUBSTRATE-BUDGET", null, { inspectSessions: true });
  const failures = attemptFailures(store, "NS-SUBSTRATE-BUDGET");
  const latest = failures.find((event) => event.payload.failure.attempt === card.runId);
  assert.equal(latest.payload.failure.automaticRetry, true, "a fourth substrate fault still retries");
  assert.equal(openRequests(store, "NS-SUBSTRATE-BUDGET").length, 0);
  store.close();
});

// A person may skip one content item: the rest of the project delivers
// without it (Tianyi, 2026-09-30, DL-0929-10's missing smoke-test footage).
async function deliveryProject(id) {
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(await readFile(workflowPath, "utf8"));
  runtime.startInstance({ id, workflowSha256: release.workflowSha256, agentBindings: { "content-operator": "main" }, inputs: { deliveryMode: "download" } });
  runtime.setContentItems(id, [
    { id: "kept", title: "Kept video", route: "SCENE_EDIT" },
    { id: "gone", title: "Smoke test video", route: "SCENE_EDIT" },
  ]);
  store.upsertStageRun({ instanceId: id, stageId: "plan", attempt: 1, cardId: `${id}-plan`, status: "done", summary: null });
  for (const stageId of ["route", "materials", "brief", "produce"]) {
    store.upsertContentItemRun({ instanceId: id, contentItemId: "kept", stageId, attempt: 1, cardId: `${id}-kept-${stageId}`, status: "done", summary: null });
  }
  for (const stageId of ["route", "materials"]) {
    store.upsertContentItemRun({ instanceId: id, contentItemId: "gone", stageId, attempt: 1, cardId: `${id}-gone-${stageId}`, status: "done", summary: null });
  }
  store.upsertContentItemRun({ instanceId: id, contentItemId: "gone", stageId: "brief", attempt: 1, cardId: `${id}-gone-brief`, status: "blocked", summary: "no footage" });
  return { release, runtime, store, workboard };
}

test("delivery waits for every item until one is skipped, then goes ahead without it", async () => {
  const { runtime, store } = await deliveryProject("NS-SKIP-DELIVER");
  let result = await runtime.tick("NS-SKIP-DELIVER", { dispatch: false });
  assert.equal(result.actions.some((action) => action.stageId === "deliver-download"), false, "the skipped-to-be item still holds delivery");
  store.skipContentItem({ instanceId: "NS-SKIP-DELIVER", contentItemId: "gone", reason: "素材库没有烟雾测试画面", actor: "local:Tianyi" });
  result = await runtime.tick("NS-SKIP-DELIVER", { dispatch: false });
  const delivery = result.actions.find((action) => action.stageId === "deliver-download");
  assert.ok(delivery, "delivery is planned once the only unfinished item is skipped");
  assert.equal(result.actions.some((action) => action.contentItemId === "gone"), false, "nothing more is planned for the skipped item");
  assert.match(delivery.card.notes, /Skipped content items.*gone 「Smoke test video」 — 素材库没有烟雾测试画面.*this delivery has 1 items/s);
  store.close();
});

test("skipping from a request records the item, closes the request and does not reopen it", async () => {
  const { card, runtime, store } = await stoppedRun({
    id: "NS-SKIP-DECIDE", stageId: "produce", outcome: { status: "completed" },
    session: { messages: [{ role: "assistant", stopReason: "stop", timestamp: Date.now() - 60_000, content: [{ type: "text", text: "需要人做：素材库里没有这条要的画面，请补拍上传，或者这条不做\n原因：Scene 检索为 0" }] }] },
  });
  await runtime.reconcile("NS-SKIP-DECIDE", null, { inspectSessions: true });
  const [request] = openRequests(store, "NS-SKIP-DECIDE");
  assert.deepEqual(request.options.map((option) => option.id), ["continue", "skip", "pause"]);
  const decided = await runtime.decide({ decisionId: request.id, optionId: "skip", note: "没有素材，这条不做", actor: "local:Tianyi" });
  assert.equal(decided.request.status, "decided");
  assert.deepEqual(store.listSkippedContentItems("NS-SKIP-DECIDE").map((entry) => [entry.contentItemId, entry.reason]), [["video-1", "没有素材，这条不做"]]);
  assert.ok(store.listEvents("NS-SKIP-DECIDE").some((event) => event.type === "decision.skipped"));
  assert.equal(store.getInstance("NS-SKIP-DECIDE").status, "active", "skipping does not pause the project");
  await runtime.reconcile("NS-SKIP-DECIDE", null, { inspectSessions: true });
  assert.equal(openRequests(store, "NS-SKIP-DECIDE").length, 0, "the stopped card of a skipped item is nobody's matter");
  assert.equal(card.status, "blocked");
  store.close();
});

test("a stop on a project-wide stage cannot be skipped", async () => {
  const { runtime, store } = await stoppedRun({
    id: "NS-SKIP-PROJECT", stageId: "plan", outcome: { status: "completed" },
    session: { messages: [{ role: "assistant", stopReason: "stop", timestamp: Date.now() - 60_000, content: [{ type: "text", text: "需要人做：请给 V 开策划案文档的阅读权限\n原因：链接无权限" }] }] },
  });
  await runtime.reconcile("NS-SKIP-PROJECT", null, { inspectSessions: true });
  const [request] = openRequests(store, "NS-SKIP-PROJECT");
  assert.deepEqual(request.options.map((option) => option.id), ["continue", "pause"]);
  assert.equal(request.options[0].label, "处理好了，继续");
  await assert.rejects(runtime.decide({ decisionId: request.id, optionId: "skip", actor: "local:Tianyi" }), /Unknown option skip/);
  store.close();
});

// Gateway restart pickup (GatewayRestartHold -> runtime.resumeAfterGatewayRestart).
async function restartedRun({ id, stageId = "produce", cardStatus = "blocked", outcome, approve = true }) {
  const fixture = await stoppedRun({ id, stageId });
  const { card, store, workboard } = fixture;
  card.status = cardStatus;
  card.execution = { status: cardStatus, startedAt: Date.parse("2026-09-30T04:40:00Z") };
  workboard.runOutcomes.set(card.runId, outcome);
  const item = stageId === "plan" ? null : "video-1";
  if (item) store.upsertContentItemRun({ instanceId: id, contentItemId: item, stageId, attempt: 1, cardId: card.id, status: cardStatus });
  else store.upsertStageRun({ instanceId: id, stageId, attempt: 1, cardId: card.id, status: cardStatus });
  if (approve && stageId === "produce") {
    store.recordApproval({ actor: "tester", contentItemId: item, effect: "paid-production", instanceId: id, scope: "content-item", stageId, status: "approved" });
  }
  return fixture;
}

const restartWindow = {
  from: "2026-09-30T04:53:00.000Z",
  to: "2026-09-30T04:54:10.000Z",
  reason: "gateway restarting",
  fromBootId: "boot-a",
  bootId: "boot-b",
  bootChanged: true,
};

function paidOperation(store, card, id, patch = null) {
  const operation = store.reserveExternalOperation({
    idempotencyKey: `${id}:video-1:produce`,
    instanceId: id,
    contentItemId: "video-1",
    stageId: "produce",
    ownerCardId: card.id,
    requestHash: "request-sha",
  });
  if (patch) store.checkpointExternalOperation(operation.idempotencyKey, patch);
  return operation;
}

test("a run the Gateway killed while restarting is resumed without spending a retry or reaching a person", async () => {
  // V, 2026-09-30 12:53: the drain ended two produce runs with "subagent run
  // terminated" and one reached the group as a decision.
  const { card, runtime, store, workboard } = await restartedRun({
    id: "NS-RESTART-KILLED",
    outcome: { status: "cancelled", error: "subagent run terminated", endedAt: Date.parse("2026-09-30T04:53:31Z") },
  });
  paidOperation(store, card, "NS-RESTART-KILLED", { status: "executing", externalTaskId: "makaron-task-1" });
  const outcome = await runtime.resumeAfterGatewayRestart(restartWindow);
  assert.equal(outcome.resumed.length, 1);
  assert.equal(card.status, "ready");
  assert.equal(attemptFailures(store, "NS-RESTART-KILLED").length, 0, "not a failure of the card");
  assert.equal(openRequests(store, "NS-RESTART-KILLED").length, 0);
  assert.ok(store.listEvents("NS-RESTART-KILLED").some((event) => event.type === "stage.gateway-restart.resumed"));
  assert.equal(workboard.blockCalls.length, 0, "already blocked");
  store.close();
});

test("a run the old Gateway still lists as running is lost: it is blocked and resumed", async () => {
  // V, 2026-09-30 08:26: the registry kept the run "running" after the restart
  // and the card waited for it until someone blocked and retried it by hand.
  const { card, runtime, store, workboard } = await restartedRun({
    id: "NS-RESTART-LOST", cardStatus: "running",
    outcome: { status: "running", startedAt: Date.parse("2026-09-30T04:40:00Z"), updatedAt: Date.parse("2026-09-30T04:52:50Z") },
  });
  const outcome = await runtime.resumeAfterGatewayRestart(restartWindow);
  assert.equal(outcome.resumed.length, 1);
  assert.equal(workboard.blockCalls.length, 1);
  assert.equal(card.status, "ready");
  store.close();
});

test("without a new Gateway boot a running run is not presumed lost", async () => {
  const { card, runtime, store } = await restartedRun({
    id: "NS-RESTART-BLIP", cardStatus: "running",
    outcome: { status: "running", startedAt: Date.parse("2026-09-30T04:40:00Z"), updatedAt: Date.parse("2026-09-30T04:52:50Z") },
  });
  const outcome = await runtime.resumeAfterGatewayRestart({ ...restartWindow, bootChanged: false });
  assert.equal(outcome.resumed.length, 0);
  assert.equal(card.status, "running");
  store.close();
});

test("a run that kept going on the new Gateway is left alone", async () => {
  const { card, runtime, store } = await restartedRun({
    id: "NS-RESTART-ALIVE", cardStatus: "running",
    outcome: { status: "running", startedAt: Date.parse("2026-09-30T04:40:00Z"), updatedAt: Date.parse("2026-09-30T04:55:00Z") },
  });
  assert.equal((await runtime.resumeAfterGatewayRestart(restartWindow)).resumed.length, 0);
  assert.equal(card.status, "running");
  store.close();
});

test("a run that ended before the restart, or ended normally, is not the restart's", async () => {
  for (const [id, outcome] of [
    ["NS-RESTART-EARLIER", { status: "cancelled", error: "subagent run terminated", endedAt: Date.parse("2026-09-30T04:30:00Z") }],
    ["NS-RESTART-NORMAL", { status: "succeeded", endedAt: Date.parse("2026-09-30T04:53:20Z") }],
  ]) {
    const { card, runtime, store } = await restartedRun({ id, outcome });
    assert.equal((await runtime.resumeAfterGatewayRestart(restartWindow)).resumed.length, 0, id);
    assert.equal(card.status, "blocked", id);
    store.close();
  }
});

test("a paid card with a reservation not yet recorded as submitted goes to a person: it may have been charged", async () => {
  const { card, runtime, store } = await restartedRun({
    id: "NS-RESTART-PAID-OPEN",
    outcome: { status: "cancelled", error: "subagent run terminated", endedAt: Date.parse("2026-09-30T04:53:31Z") },
  });
  paidOperation(store, card, "NS-RESTART-PAID-OPEN");
  const outcome = await runtime.resumeAfterGatewayRestart(restartWindow);
  assert.equal(outcome.handedOver.length, 1);
  assert.equal(card.status, "blocked");
  const [event] = attemptFailures(store, "NS-RESTART-PAID-OPEN");
  assert.equal(event.payload.failure.kind, "gateway_restart");
  assert.equal(event.payload.failure.automaticRetry, false);
  store.close();
});

test("a card is resumed once per interrupted attempt", async () => {
  const { runtime, store } = await restartedRun({
    id: "NS-RESTART-ONCE",
    outcome: { status: "cancelled", error: "subagent run terminated", endedAt: Date.parse("2026-09-30T04:53:31Z") },
  });
  assert.equal((await runtime.resumeAfterGatewayRestart(restartWindow)).resumed.length, 1);
  assert.equal((await runtime.resumeAfterGatewayRestart(restartWindow)).resumed.length, 0);
  store.close();
});


// 要求修改 redoes the item (runtime.redoForChanges).
async function reviewedItem(id) {
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  let clock = Date.now();
  const needsYou = new NeedsYouTracker({ store, now: () => clock });
  const runtime = new NightShiftRuntime({ store, workboard, needsYou, now: () => clock });
  const release = runtime.publish(await readFile(workflowPath, "utf8"));
  runtime.startInstance({ id, workflowSha256: release.workflowSha256, agentBindings: { "content-operator": "main" } });
  runtime.setContentItems(id, [{ id: "video-1", title: "Video", route: "SCENE_EDIT" }]);
  store.upsertStageRun({ instanceId: id, stageId: "plan", attempt: 1, cardId: "card-plan", status: "done" });
  workboard.cards.push({ id: "card-plan", status: "done", labels: [`instance:${id}`, "stage:plan"] });
  for (const stageId of ["route", "materials", "brief", "produce"]) {
    store.upsertContentItemRun({ instanceId: id, contentItemId: "video-1", stageId, attempt: 1, cardId: `card-${stageId}-old`, status: "done" });
    workboard.cards.push({ id: `card-${stageId}-old`, status: "done", labels: [`instance:${id}`, `stage:${stageId}`, "content-item:video-1"] });
  }
  store.upsertContentItemRun({ instanceId: id, contentItemId: "video-1", stageId: "review", attempt: 1, cardId: "card-review-old", status: "review" });
  workboard.cards.push({ id: "card-review-old", status: "review", labels: [`instance:${id}`, "stage:review", "content-item:video-1"] });
  store.recordApproval({ actor: "tester", contentItemId: "video-1", effect: "paid-production", instanceId: id, scope: "content-item", stageId: "produce", status: "approved" });
  return { runtime, store, workboard, advance: (ms) => { clock += ms; } };
}

test("要求修改 redoes the item: a new produce card carrying the person's note, then a new review", async () => {
  // V, 2026-09-30: ref1 and ref2 of NS-BATCHV2-0929-01 waited five hours after
  // a person asked for changes; nothing could redo a finished video.
  const id = "NS-REDO";
  const { runtime, store, workboard, advance } = await reviewedItem(id);
  const decision = await runtime.requestChanges({
    actor: "张寒冰", cardId: "card-review-old", contentItemId: "video-1", evidence: "时长≤15s，只用 BGM", instanceId: id, stageId: "review",
  });
  assert.equal(decision.status, "changes_requested");
  assert.deepEqual(decision.redo, { redone: true, revision: 1, stageIds: ["produce", "review"] });

  await runtime.tick(id, { dispatch: false });
  const produce = workboard.cards.filter((card) => (card.labels ?? []).includes("stage:produce"));
  assert.equal(produce.length, 2, "a new card, the old one untouched");
  const fresh = produce.find((card) => card.id !== "card-produce-old");
  assert.equal(fresh.status, "ready");
  const itemRuns = () => store.listContentItemRuns(id).filter((run) => run.contentItemId === "video-1");
  assert.equal(itemRuns().find((run) => run.stageId === "produce" && run.attempt === 2).cardId, fresh.id);
  assert.match(fresh.notes, /Redo requested \(revision 1\).*时长≤15s，只用 BGM/);
  assert.equal(workboard.cards.find((card) => card.id === "card-produce-old").status, "done");
  assert.equal(workboard.cards.filter((card) => (card.labels ?? []).includes("stage:review")).length, 1, "the review waits for the new video");

  // The old review a person sent back is nobody's matter.
  advance(2 * 60 * 60_000);
  await runtime.reconcile(id, null, { inspectSessions: false });
  assert.equal(store.listDecisionRequests({ instanceId: id }).filter((entry) => entry.status === "open").length, 0);

  // A pass reads the new card back: it stays attempt 2, the first attempt keeps its card.
  await runtime.reconcile(id, null, { inspectSessions: false });
  assert.equal(itemRuns().find((run) => run.stageId === "produce" && run.attempt === 1).cardId, "card-produce-old");
  assert.equal(itemRuns().find((run) => run.stageId === "produce" && run.attempt === 2).status, "ready");

  fresh.status = "done";
  await runtime.tick(id, { dispatch: false });
  assert.equal(itemRuns().find((run) => run.stageId === "produce" && run.attempt === 2).status, "done");
  const reviews = workboard.cards.filter((card) => (card.labels ?? []).includes("stage:review"));
  assert.equal(reviews.length, 2);
  const newReview = reviews.find((card) => card.id !== "card-review-old");
  assert.equal(newReview.status, "review");
  assert.equal(itemRuns().find((run) => run.stageId === "review" && run.attempt === 2).cardId, newReview.id);
  assert.ok(store.listEvents(id).some((event) => event.type === "content-item.redo.requested"));
  store.close();
});

test("a second request for changes while the redo is under way does not stack another", async () => {
  const id = "NS-REDO-TWICE";
  const { runtime, store } = await reviewedItem(id);
  await runtime.requestChanges({ actor: "a", cardId: "card-review-old", contentItemId: "video-1", evidence: "one", instanceId: id, stageId: "review" });
  const again = await runtime.requestChanges({ actor: "a", cardId: "card-review-old", contentItemId: "video-1", evidence: "two", instanceId: id, stageId: "review" });
  assert.equal(again.redo.redone, false);
  assert.equal(store.listContentItemRevisions(id).length, 1);
  store.close();
});

test("an approval card cannot be retried: it is a gate, not work", async () => {
  const id = "NS-RETRY-APPROVAL";
  const { runtime, store, workboard } = await reviewedItem(id);
  workboard.cards.push({ id: "card-approval", status: "blocked", labels: [`instance:${id}`, "stage:produce", "content-item:video-1", "nightshift:approval"] });
  await assert.rejects(
    runtime.retry({ actor: "operator", cardId: "card-approval", contentItemId: "video-1", instanceId: id, stageId: "produce" }),
    /approval card, not work/,
  );
  store.close();
});

test("the stages a review redoes run from the first stage it checks to the review", () => {
  const stages = [
    { id: "skillize", actor: "agent", scope: "project" },
    { id: "persona-match", actor: "agent", scope: "content-item", needs: ["skillize"] },
    { id: "produce", actor: "agent", scope: "content-item", needs: ["persona-match", "skillize"] },
    { id: "qc-learn", actor: "agent", scope: "content-item", needs: ["produce"] },
    { id: "review", actor: "human", scope: "content-item", needs: ["produce", "qc-learn"] },
    { id: "package", actor: "agent", scope: "content-item", needs: ["review"] },
    { id: "check", actor: "human", scope: "content-item", needs: ["package"] },
  ];
  const byId = (id) => stages.find((stage) => stage.id === id);
  assert.deepEqual(stagesToRedo(stages, byId("review"), {}), ["produce", "qc-learn", "review"]);
  assert.deepEqual(stagesToRedo(stages, byId("check"), {}), ["package", "check"]);
});


test("a redo card that stops reaches a person like any card: it is the newest attempt", async () => {
  const id = "NS-REDO-STOP";
  const { runtime, store, workboard, advance } = await reviewedItem(id);
  await runtime.requestChanges({ actor: "a", cardId: "card-review-old", contentItemId: "video-1", evidence: "redo", instanceId: id, stageId: "review" });
  await runtime.tick(id, { dispatch: false });
  const fresh = workboard.cards.find((card) => (card.labels ?? []).includes("stage:produce") && card.id !== "card-produce-old");
  fresh.status = "blocked";
  fresh.metadata = { ...(fresh.metadata ?? {}), automation: { ...(fresh.metadata?.automation ?? {}), summary: "Makaron export failed" } };
  store.upsertContentItemRun({ instanceId: id, contentItemId: "video-1", stageId: "produce", attempt: 2, cardId: fresh.id, status: "blocked",
    failure: { kind: "contract_error", retryable: false, automaticRetry: false, rawError: "Makaron export failed", agentReport: "需要人做：请在 Makaron 后台看一下导出为什么失败\n原因：导出失败" } });
  advance(2 * 60 * 60_000);
  await runtime.reconcile(id, null, { inspectSessions: false });
  const open = store.listDecisionRequests({ instanceId: id }).filter((entry) => entry.status === "open");
  assert.deepEqual(open.map((entry) => entry.cardId), [fresh.id]);
  store.close();
});

// A stopped paid stage (2026-10-08, DL-1008-04). The ledger key carries the
// item's revision, so the same card retried meets the same reserved, failed or
// succeeded operation every time; going on after a failed or never-submitted
// call takes a fresh attempt.
async function stoppedPaidItem(id, operationStatus, { report = "需要人做：无\n原因：480p generation failed", observe = true } = {}) {
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  let clock = Date.now();
  const needsYou = new NeedsYouTracker({ store, now: () => clock });
  const runtime = new NightShiftRuntime({ store, workboard, needsYou, now: () => clock });
  const release = runtime.publish(await readFile(workflowPath, "utf8"));
  runtime.startInstance({ id, workflowSha256: release.workflowSha256, agentBindings: { "content-operator": "main" }, inputs: { authorizationScope: { paidProduction: true } } });
  runtime.setContentItems(id, [{ id: "video-1", title: "Video", route: "AI_GENERATE" }]);
  store.upsertStageRun({ instanceId: id, stageId: "plan", attempt: 1, cardId: "card-plan", status: "done" });
  workboard.cards.push({ id: "card-plan", status: "done", labels: [`instance:${id}`, "stage:plan"] });
  for (const stageId of ["route", "materials", "brief"]) {
    store.upsertContentItemRun({ instanceId: id, contentItemId: "video-1", stageId, attempt: 1, cardId: `card-${stageId}`, status: "done" });
    workboard.cards.push({ id: `card-${stageId}`, status: "done", labels: [`instance:${id}`, `stage:${stageId}`, "content-item:video-1"] });
  }
  const failure = { kind: "contract_error", retryable: false, automaticRetry: false, rawError: "External side effect has no succeeded Night Shift operation checkpoint", agentReport: report };
  store.upsertContentItemRun({ instanceId: id, contentItemId: "video-1", stageId: "produce", attempt: 1, cardId: "card-produce-old", status: "blocked", failure });
  workboard.cards.push({ id: "card-produce-old", status: "blocked", runId: "run-old", updatedAt: clock, labels: [`instance:${id}`, "stage:produce", "content-item:video-1"] });
  const oldKey = `${release.workflowSha256}:run:old`;
  store.reserveExternalOperation({ idempotencyKey: oldKey, instanceId: id, contentItemId: "video-1", stageId: "produce", ownerCardId: "card-produce-old", requestHash: "a".repeat(64) });
  if (operationStatus !== "reserved") store.checkpointExternalOperation(oldKey, { status: operationStatus, externalTaskId: "task-1", result: { reason: "480p generation failed" } });
  const stage = release.manifest.spec.stages.find((entry) => entry.id === "produce");
  const request = observe ? needsYou.observe({
    card: workboard.cards.at(-1), instance: store.getInstance(id), stage, stageId: "produce", contentItemId: "video-1", status: "blocked", failure,
    operation: store.getExternalOperation(oldKey),
  }) : null;
  return { release, request, runtime, store, workboard, oldKey, advance: (ms) => { clock += ms; } };
}

const produceCards = (workboard) => workboard.cards.filter((card) => (card.labels ?? []).includes("stage:produce"));
const recoveries = (store, id) => store.listEvents(id).filter((event) => event.type === "stage.stop.recovered");

test("继续 after a failed paid call starts a fresh attempt under a new revision, so its paid call is a new operation", async () => {
  const id = "NS-STOP-FRESH";
  const { release, request, runtime, store, workboard, oldKey, advance } = await stoppedPaidItem(id, "failed");
  assert.deepEqual(request.options.map((option) => option.id), ["continue", "skip", "pause"]);
  assert.match(request.options[0].description, /会再付一次钱/);
  const decided = await runtime.decide({ decisionId: request.id, optionId: "continue", note: "已充值", actor: "local:Tianyi" });
  assert.equal(decided.request.status, "decided");

  await runtime.tick(id, { dispatch: false });
  assert.equal(produceCards(workboard).length, 2, "a new card; the stopped one is left as it was");
  const fresh = produceCards(workboard).find((card) => card.id !== "card-produce-old");
  assert.equal(fresh.status, "ready");
  assert.match(fresh.notes, /Redo requested \(revision 1\): local:Tianyi started a fresh attempt after the previous attempt of this item stopped at produce/);
  assert.match(fresh.notes, /已充值/);

  // The new card's ledger key carries the revision: reserving it is a fresh operation.
  const contentItem = runtime.contentItemsWithRevisions(id).find((entry) => entry.id === "video-1");
  const keys = resolveNightShiftOperationKeys({ card: fresh, release: release.manifest, instance: store.getInstance(id), contentItem });
  assert.match(keys.logicalIdempotencyKey, /:revision-1$/);
  const reserved = store.reserveExternalOperation({ idempotencyKey: keys.preferredIdempotencyKey, instanceId: id, contentItemId: "video-1", stageId: "produce", ownerCardId: fresh.id, requestHash: "a".repeat(64) });
  assert.equal(reserved.reused, false);
  assert.equal(store.getExternalOperation(oldKey).status, "failed", "the old operation is left as it was");

  advance(2 * 60 * 60_000);
  await runtime.reconcile(id, null, { inspectSessions: false });
  assert.equal(store.listDecisionRequests({ instanceId: id, status: "open" }).length, 0, "the old stop is nobody's matter");
  store.close();
});

test("a paid result that did not pass its checks offers to use it or to pay for a new one; the old success stays immutable", async () => {
  const id = "NS-STOP-REDO-OK";
  const { request, runtime, store, oldKey } = await stoppedPaidItem(id, "succeeded", { report: "需要人做：请看一下这条视频能不能用：https://example.com/v.mp4\n原因：开头 2.8 秒黑屏" });
  assert.equal(request.problem, "请看一下这条视频能不能用：https://example.com/v.mp4");
  assert.deepEqual(request.options.map((option) => option.label), ["用这次的结果", "重新生成", "这条不做了", "暂停项目"]);
  await runtime.decide({ decisionId: request.id, optionId: "redo", actor: "local:Tianyi" });
  assert.equal(store.getExternalOperation(oldKey).status, "succeeded");
  assert.throws(() => store.checkpointExternalOperation(oldKey, { status: "failed" }), /immutable/);
  store.close();
});

test("a fresh attempt is refused where it does not apply, and twice in a row does not stack", async () => {
  const id = "NS-STOP-REDO-TWICE";
  const { request, runtime, store, workboard } = await stoppedPaidItem(id, "reserved");
  await runtime.decide({ decisionId: request.id, optionId: "continue", actor: "a" });
  assert.equal(store.listContentItemRevisions(id).length, 1);
  await assert.rejects(runtime.redoStoppedStage({ actor: "a", cardId: "card-produce-old", contentItemId: "video-1", instanceId: id, stageId: "produce" }), /already being redone/);
  workboard.cards.find((card) => card.id === "card-brief").status = "done";
  await assert.rejects(runtime.redoStoppedStage({ actor: "a", cardId: "card-brief", contentItemId: "video-1", instanceId: id, stageId: "brief" }), /stopped card/);
  await assert.rejects(runtime.redoStoppedStage({ actor: "a", cardId: "card-plan", contentItemId: null, instanceId: id, stageId: "plan" }), /content item/);
  store.close();
});

test("a stop that asks nothing of a person goes on by itself, paying for at most one fresh attempt, then reaches a person", async () => {
  const id = "NS-STOP-SELF";
  const { runtime, store, workboard, advance } = await stoppedPaidItem(id, "failed", { observe: false });
  await runtime.reconcile(id, null, { inspectSessions: false });
  assert.equal(store.listDecisionRequests({ instanceId: id }).length, 0);
  assert.equal(recoveries(store, id).length, 0, "it waits first: the Agent may still be working");
  advance(3 * 60_000);
  await runtime.reconcile(id, null, { inspectSessions: false });
  assert.deepEqual(recoveries(store, id).map((event) => [event.payload.how, event.payload.paid]), [["fresh", true]]);
  await runtime.tick(id, { dispatch: false });
  const fresh = produceCards(workboard).find((card) => card.id !== "card-produce-old");
  assert.match(fresh.notes, /Night Shift started a fresh attempt/);

  // The fresh attempt fails the same way: the one extra payment is spent.
  fresh.status = "blocked";
  fresh.runId = "run-fresh";
  const failure = { kind: "contract_error", retryable: false, automaticRetry: false, rawError: "External side effect has no succeeded Night Shift operation checkpoint", agentReport: "需要人做：无\n原因：480p generation failed" };
  store.upsertContentItemRun({ instanceId: id, contentItemId: "video-1", stageId: "produce", attempt: 2, cardId: fresh.id, status: "blocked", failure });
  store.reserveExternalOperation({ idempotencyKey: "fresh-key", instanceId: id, contentItemId: "video-1", stageId: "produce", ownerCardId: fresh.id, requestHash: "b".repeat(64) });
  store.checkpointExternalOperation("fresh-key", { status: "failed", externalTaskId: "task-2" });
  await runtime.reconcile(id, null, { inspectSessions: false });
  advance(3 * 60_000);
  await runtime.reconcile(id, null, { inspectSessions: false });
  assert.equal(recoveries(store, id).length, 1, "no second payment by itself");
  const [request] = store.listDecisionRequests({ instanceId: id, status: "open" });
  assert.equal(request.cardId, fresh.id);
  assert.equal(request.problem, "这一条没做成：要再试一次，还是不做了？");
  assert.equal(request.cause, "480p generation failed");
  assert.deepEqual(request.options.map((option) => option.label), ["再试一次", "这条不做了", "暂停项目"]);
  assert.match(request.options[0].description, /会再付一次钱/);
  store.close();
});

test("a stop that asks a person for something reaches them at once and is never retried by itself", async () => {
  const id = "NS-STOP-ASK";
  const { runtime, store, advance } = await stoppedPaidItem(id, "failed", { observe: false, report: "需要人做：请给 seedance 视频服务充值\n原因：额度不足，两次提交都被拒" });
  await runtime.reconcile(id, null, { inspectSessions: false });
  advance(3 * 60_000);
  await runtime.reconcile(id, null, { inspectSessions: false });
  assert.equal(recoveries(store, id).length, 0);
  const [request] = store.listDecisionRequests({ instanceId: id, status: "open" });
  assert.equal(request.problem, "请给 seedance 视频服务充值");
  assert.equal(request.options[0].label, "处理好了，继续");
  store.close();
});

test("a stop with nothing paid goes on with the same card, at most twice", async () => {
  const id = "NS-STOP-SAME";
  const { runtime, store, workboard, advance } = await stoppedRun({
    id, stageId: "plan", outcome: { status: "completed" },
    session: { messages: [{ role: "assistant", stopReason: "stop", timestamp: Date.now() - 60_000, content: [{ type: "text", text: "需要人做：无\n原因：模型返回了不完整的工具调用" }] }] },
  });
  const card = workboard.cards[0];
  store.upsertStageRun({ instanceId: id, stageId: "plan", attempt: 1, cardId: card.id, status: "blocked" });
  for (let round = 0; round < 3; round += 1) {
    await runtime.reconcile(id, null, { inspectSessions: true });
    advance(3 * 60_000);
    await runtime.reconcile(id, null, { inspectSessions: true });
    if (card.status === "ready") {
      card.status = "blocked";
      card.runId = `run-${round}`;
    }
  }
  assert.deepEqual(recoveries(store, id).map((event) => event.payload.how), ["same", "same"]);
  assert.equal(store.listDecisionRequests({ instanceId: id, status: "open" }).length, 1, "the third stop reaches a person");
  store.close();
});

// V, 2026-10-09 01:01: after the deploy the four open GeeLark requests kept
// their old words. The engine remembers which reports it has read only in
// memory; after a restart every stopped card with an open request waited for a
// report it would never read again, and was never observed.
test("after a restart, a stop already in front of a person is observed and its request rewritten", async () => {
  const id = "NS-STOP-RESTART";
  const { runtime, store, workboard } = await stoppedRun({ id, stageId: "plan", outcome: { status: "completed" } });
  const card = workboard.cards[0];
  const failure = { kind: "contract_error", retryable: false, automaticRetry: false, rawError: "External side effect has no succeeded Night Shift operation checkpoint", validationPhase: "side_effect" };
  store.upsertStageRun({ instanceId: id, stageId: "plan", attempt: 1, cardId: card.id, status: "blocked", failure });
  const opened = store.openDecisionRequest({
    instanceId: id, cardId: card.id, stageId: "plan", attempt: String(card.runId), source: "engine",
    problem: "外部操作（付费生成、发布或上传）没有成功记录，无法确认它是否真的完成了", scope: "project",
    options: [{ id: "retry", label: "重新执行", effect: "retry" }], groupKey: "g",
    evidence: { failure: { ...failure, agentReport: "Card completed cleanly." }, describeVersion: 2 },
  });
  await runtime.reconcile(id, null, { inspectSessions: false });
  const rewritten = store.getDecisionRequest(opened.id);
  assert.equal(rewritten.evidence.describeVersion, 4);
  assert.deepEqual(rewritten.options.map((option) => option.label), ["再试一次", "暂停项目"]);
  assert.equal(rewritten.cause, "Card completed cleanly.", "the Agent's words read before the restart stay");
  assert.equal(store.listEvents(id).filter((event) => event.type === "stage.stop.recovered").length, 0, "still the person's");
  store.close();
});

// Shared VLab, 2026-10-09: the third stop was judged at 16:55 and its request
// opened at 17:00. The two-minute wait guards the engine acting by itself; a
// stop the engine will not act on has nothing to wait for.
test("a stop with no recovery left reaches a person on the pass that first sees it", async () => {
  const id = "NS-STOP-SPENT";
  const { runtime, store, workboard } = await stoppedRun({
    id, stageId: "plan", outcome: { status: "completed" },
    session: { messages: [{ role: "assistant", stopReason: "stop", timestamp: Date.now() - 60_000, content: [{ type: "text", text: "需要人做：无\n原因：模型返回了不完整的工具调用" }] }] },
  });
  const card = workboard.cards[0];
  store.upsertStageRun({ instanceId: id, stageId: "plan", attempt: 1, cardId: card.id, status: "blocked" });
  for (const how of ["same", "same"]) {
    store.appendEvent({ instanceId: id, type: "stage.stop.recovered", payload: { cardId: card.id, contentItemId: null, stageId: "plan", how, paid: false } });
  }
  await runtime.reconcile(id, null, { inspectSessions: true });
  assert.equal(store.listDecisionRequests({ instanceId: id, status: "open" }).length, 1);
  store.close();
});

test("every Agent brief asks for the stop report; a paid one says what a failed or unusable result means", async () => {
  const id = "NS-STOP-BRIEF";
  const { release, runtime, store } = await stoppedPaidItem(id, "failed", { observe: false });
  const stages = release.manifest.spec.stages;
  const item = runtime.contentItemsWithRevisions(id)[0];
  const brief = buildAgentBrief(release.manifest, store.getInstance(id), stages.find((stage) => stage.id === "brief"), item);
  assert.match(brief, /begin your final message with two lines in Chinese, written for someone who is not technical: 需要人做：.*or 无 when no person is needed.* 原因：/);
  assert.match(brief, /not the name of a Night Shift rule/);
  assert.doesNotMatch(brief, /reused\+failed/, "a stage without side effects has no ledger rules");
  const paid = buildAgentBrief(release.manifest, store.getInstance(id), stages.find((stage) => stage.id === "produce"), item);
  assert.match(paid, /If it is reused\+failed, .*do not submit again/);
  assert.match(paid, /reused\+succeeded.*does not pass this stage's checks, block.*asking a person to look at the result/);
  store.close();
});
