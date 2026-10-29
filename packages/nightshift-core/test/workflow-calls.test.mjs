import assert from "node:assert/strict";
import test from "node:test";
import { NightShiftRuntime } from "../src/runtime.mjs";
import { NightShiftStore } from "../src/store.mjs";

export const flow = (id, stages, extra = {}) => JSON.stringify({
  apiVersion: "nightshift.versa.ai/v1alpha1", kind: "Workflow",
  metadata: { id, version: "1.0.0", name: id },
  spec: { ownerAgentRole: "operator", ...extra, stages },
});
export const system = (id, extra = {}) => ({ id, title: id, actor: "system", timeout: "10m", outputs: ["result"], ...extra });

test("published workflows can be called with an immutable SHA and bounded result routing", () => {
  const store = new NightShiftStore();
  try {
    const runtime = new NightShiftRuntime({ store, workboard: {} });
    const child = runtime.publish(flow("child", [system("verify")], { outputs: { result: { stage: "verify", output: "result" } } }));
    const parent = runtime.publish(flow("parent", [system("acquire", {
      actor: "workflow", call: { workflow: child.workflowSha256, inputs: {} },
      repeat: { until: { output: "result.passed", equals: true }, while: { output: "result.again", equals: true }, maxIterations: 2, maxDuration: "1h", maxOperations: 2 },
    })]));
    assert.equal(parent.manifest.spec.stages[0].call.workflow, child.workflowSha256);
  } finally { store.close(); }
});

import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { actionKey, nativeActionKey } from "../src/orchestrator.mjs";
import { schedulerCardIds, instanceCardIds } from "../src/scheduler-pass.mjs";
import { gatewayIdempotencyLabel } from "../src/workboard-gateway-adapter.mjs";
import { handoffManifestExample } from "../src/handoff.mjs";
import { publicCallSummary } from "../src/workflow-calls.mjs";
import { validateDeclaredCompletion } from "../src/completion.mjs";

test("explicit export repairs revalidate completion instead of trusting its old validated event", async t => {
  const f = await fixture(t, { childSpec: { completion: { mode: "strict-v1" } },
    childStages: [system("verify", { completeWhen: ["output.result.ready"], outputContracts: { result: { type: "json", equals: { ready: true } } } })] });
  let validations = 0;
  f.runtime.completionValidator = async ({ instance, release, stageId }) => {
    if (instance.id === "ROOT") return {};
    validations++;
    const root = instance.inputs.nightshift.instanceDir;
    return validateDeclaredCompletion({ instanceCreatedAt: instance.createdAt,
      stage: release.spec.stages.find(stage => stage.id === stageId),
      manifest: JSON.parse(await readFile(join(root, "handoffs", `${stageId}.json`), "utf8")),
      loadArtifact: async artifact => ({ exists: true, json: JSON.parse(await readFile(join(root, artifact), "utf8")) }) });
  };
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  await f.finish(call, { ready: true, passed: false, again: false });
  await f.tick();
  assert.equal(f.store.getCall(call.id).state, "held");
  assert.equal(validations, 1);
  // This changed file would now match until, but no longer meets its own
  // output contract. A persisted stage.completion.validated event is stale.
  await f.finish(call, { ready: "false", passed: true, again: false });
  await f.runtime.resume({ actor: "V", cardId: call.cardId });
  await f.tick();
  assert.equal(f.store.getCall(call.id).state, "held");
  assert.match(f.store.getCall(call.id).reason, /output-contract/);
  assert.equal(validations, 2);
  await f.finish(call, { ready: true, passed: true, again: false });
  await f.runtime.resume({ actor: "V", cardId: call.cardId });
  await f.tick();
  assert.equal(f.store.getCall(call.id).state, "succeeded");
  assert.equal(validations, 3);
  await f.runtime.resume({ actor: "V", cardId: call.cardId });
  await f.tick();
  assert.equal(validations, 3, "succeeded controllers retain the accepted snapshot");
  assert.equal(f.store.listCalls("ROOT").length, 1);
  assert.equal(f.store.listExternalOperations(call.childId).length, 0);
});

export class CallBoard {
  cards = [];
  starts = [];
  async listCards({ cardIds } = {}) { return this.cards.filter(card => !cardIds || cardIds.includes(card.id)); }
  async applyPlan(actions) {
    return actions.map(action => {
      const label = gatewayIdempotencyLabel(action.idempotencyKey);
      let card = this.cards.find(card => card.labels.includes(label));
      if (card) return { action, card, status: "reused" };
      card = { ...action.card, id: `card-${this.cards.length + 1}`, labels: [...action.card.labels, label] };
      assert(card.labels.every(label => label.length <= 40));
      this.cards.push(card);
      return { action, card, status: "created" };
    });
  }
  async moveCard(id, status) { const card = this.cards.find(card => card.id === id); card.status = status; return card; }
  async dispatch(count, { cardIds }) {
    const started = cardIds.slice(0, count).map(id => { this.cards.find(card => card.id === id).status = "running"; this.starts.push(id); return { cardId: id }; });
    return { started };
  }
  async updateCard(id, patch) { const card = this.cards.find(card => card.id === id); Object.assign(card, patch); return card; }
  async resetCardFailures() {}
  async releaseCard(id, status) { return this.moveCard(id, status); }
}

async function failedRecoveryFixture(t, options = {}) {
  const f = await fixture(t, { repeat: false, maxOperations: 1, childSpec: { limits: { maxOperations: 1 } }, parentSpec: { limits: { maxOperations: 4 } }, ...options });
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  const failed = f.reserve(call);
  f.store.checkpointExternalOperation(failed.idempotencyKey, { status: "failed", result: { terminal: true, evidence: "synthetic-provider-response", code: 45006 } });
  const old = f.store.listStageRuns(call.childId)[0];
  await f.board.moveCard(old.cardId, "blocked");
  f.store.upsertStageRun({ ...old, attempt: 2, cardId: "retry-card", status: "ready" });
  const operation = { idempotencyKey: "retry-key", instanceId: call.childId, stageId: old.stageId, ownerCardId: "retry-card", requestHash: "b".repeat(64) };
  const request = { ...operation, failedOperationKey: failed.idempotencyKey, actor: "V", reason: "correct request shape", authorization: "synthetic approval, unchanged project budget", evidence: "synthetic-provider-response" };
  return { ...f, get store() { return f.store; }, call, failed, operation, request };
}

test("known failed recovery gets exactly one card/hash-bound allowance, preserving counts and immutable releases", async t => {
  const f = await failedRecoveryFixture(t);
  assert.throws(() => f.store.reserveExternalOperation(f.operation), /operation limit/i);
  const grant = f.store.authorizeOperationRecovery(f.request);
  assert.equal(grant.additionalOperations, 1);
  assert.equal(f.store.authorizeOperationRecovery(f.request).id, grant.id);
  assert.throws(() => f.store.authorizeOperationRecovery({ ...f.request, requestHash: "c".repeat(64) }), /different|bound/i);
  assert.throws(() => f.store.reserveExternalOperation({ ...f.operation, requestHash: "c".repeat(64) }), /hash|operation limit/i);
  f.store.checkpointExternalOperation(f.failed.idempotencyKey, { status: "failed" }, new Date(Date.now() + 1));
  f.reopen();
  const op = f.store.reserveExternalOperation(f.operation);
  assert.equal(f.store.reserveExternalOperation(f.operation).reused, true);
  assert.equal(f.store.listExternalOperations(f.call.childId).length, 2);
  assert.equal(f.store.getExternalOperation(f.failed.idempotencyKey).status, "failed");
  assert.throws(() => f.store.reserveExternalOperation({ ...f.operation, idempotencyKey: "third", ownerCardId: "other-card" }), /operation limit/i);
  assert.equal(f.store.getRelease(f.child.workflowSha256).manifest.spec.limits.maxOperations, 1);
  const summary = publicCallSummary(f.store, "ROOT")[0];
  assert.equal(summary.totalOperations, 2);
  assert.equal(summary.baseMaxOperations, 1);
  assert.equal(summary.recoveryOperations, 1);
  assert.equal(summary.maxOperations, 2);
  assert.equal(op.ownerCardId, "retry-card");
});

test("recovery cannot enlarge root budget, zero-operation calls, or unknown outcomes", async t => {
  const full = await failedRecoveryFixture(t, { parentSpec: { limits: { maxOperations: 1 } } });
  assert.throws(() => full.store.authorizeOperationRecovery(full.request), /Root|Project/i);
  full.store.resetRetryWindow({ instanceId: full.call.childId, cardId: "retry-card", stageId: "verify", targetAttempt: 2,
    nativeAttempt: "fixture", failedOperationKey: full.failed.idempotencyKey, actor: "V", note: "retry within original scope" });
  assert.throws(() => full.store.reserveExternalOperation(full.operation), /Project external-operation limit/);
  assert.equal(full.store.listOperationRecoveries("ROOT").length, 0, "automatic retry slot cannot expand the root allowance");
  const unknown = await failedRecoveryFixture(t);
  unknown.store.checkpointExternalOperation(unknown.failed.idempotencyKey, { status: "unknown" });
  assert.throws(() => unknown.store.authorizeOperationRecovery(unknown.request), /failed|unknown/i);
  const normal = await failedRecoveryFixture(t);
  assert.throws(() => normal.store.authorizeOperationRecovery({ ...normal.request, ownerCardId: normal.failed.ownerCardId }), /new|latest|attempt/i);
  assert.throws(() => normal.store.authorizeOperationRecovery({ ...normal.request, authorization: "" }), /authorization/i);
  normal.store.updateInstanceStatus("ROOT", "paused");
  assert.throws(() => normal.store.authorizeOperationRecovery(normal.request), /paused/i);
});

test("root decision listing includes nested child requests without changing their execution ownership", async t => {
  const f = await fixture(t);
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  const run = f.store.listStageRuns(call.childId)[0];
  const request = f.store.openDecisionRequest({ instanceId: call.childId, cardId: run.cardId, stageId: run.stageId, attempt: 1, source: "failure", problem: "test", scope: "project", options: [], groupKey: "test" });
  assert.equal(f.store.listDecisionRequests({ instanceId: "ROOT" })[0]?.id, request.id);
  assert.equal(f.store.listDecisionRequests({ instanceId: "ROOT" })[0].instanceId, call.childId);
  assert.equal(f.store.listDecisionRequests({ instanceId: "ROOT", includeDescendants: false }).length, 0);
  assert.equal(f.store.listDecisionRequests({ instanceId: "unrelated" }).length, 0);
  f.store.decideRequest(request.id, { actor: "V", optionId: "continue" });
  assert.equal(f.store.listDecisionRequests({ instanceId: "ROOT" }).length, 0);
  assert.equal(f.store.listDecisionRequests({ instanceId: "ROOT", status: "decided" }).length, 1);
});

test("recovery cannot enable zero scopes, accept changed evidence or lift paused/superseded calls", async t => {
  const f = await failedRecoveryFixture(t);
  const zero = { ...f.call, maxOperations: 0 };
  f.store.saveCall(zero);
  assert.throws(() => f.store.authorizeOperationRecovery(f.request), /Zero-operation/);
  f.store.saveCall(f.call);
  f.store.authorizeOperationRecovery(f.request);
  f.store.checkpointExternalOperation(f.failed.idempotencyKey, { status: "failed", result: { terminal: true, evidence: "changed evidence" } });
  assert.throws(() => f.store.reserveExternalOperation(f.operation), /operation limit/);
  const g = await failedRecoveryFixture(t);
  g.store.authorizeOperationRecovery(g.request);
  g.store.updateInstanceStatus("ROOT", "paused");
  assert.throws(() => g.store.reserveExternalOperation(g.operation), /paused/);
  g.store.updateInstanceStatus("ROOT", "active");
  assert.throws(() => g.store.reserveExternalOperation(g.operation, new Date(Date.now() + 2 * 60 * 60 * 1000)), /duration|expired/);
  const run = g.store.listStageRuns("ROOT")[0];
  g.store.upsertStageRun({ ...run, attempt: 2, cardId: "superseding-controller", status: "ready" });
  assert.throws(() => g.store.reserveExternalOperation(g.operation), /superseded/);
});

test("nested instance limits are enforced even when the parent call has spare capacity", async t => {
  const f = await failedRecoveryFixture(t, { maxOperations: 4 });
  assert.throws(() => f.store.reserveExternalOperation(f.operation), /operation limit/);
  const grant = f.store.authorizeOperationRecovery(f.request);
  assert.deepEqual(grant.scopeIds, [`instance:${f.call.childId}`]);
  assert(f.store.reserveExternalOperation(f.operation));
});

test("independent root work may remain in flight, but pausing the recovering child still blocks its permit", async t => {
  const f = await failedRecoveryFixture(t);
  const other = f.store.reserveExternalOperation({ instanceId: "ROOT", stageId: "other", ownerCardId: "other-card", idempotencyKey: "other-in-flight", requestHash: "d".repeat(64) });
  f.store.checkpointExternalOperation(other.idempotencyKey, { status: "executing", externalTaskId: "independent-task" });
  f.store.authorizeOperationRecovery(f.request);
  f.store.updateInstanceStatus(f.call.childId, "paused");
  assert.throws(() => f.store.reserveExternalOperation(f.operation), /paused/);
  f.store.updateInstanceStatus(f.call.childId, "active");
  assert(f.store.reserveExternalOperation(f.operation));
  assert.equal(f.store.getExternalOperation(other.idempotencyKey).status, "executing");
});
async function fixture(t, { repeat = true, items = false, maxOperations = 2, childStages = [system("verify")], childInputs = {}, childSpec = {}, parentSpec = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ns-calls-"));
  const board = new CallBoard();
  let store = new NightShiftStore(join(dir, "store.sqlite"));
  let clock = Date.now();
  let runtime = new NightShiftRuntime({ store, workboard: board, now: () => clock });
  const child = runtime.publish(flow("child", childStages, { inputs: childInputs, outputs: { result: { stage: "verify", output: "result" } }, ...childSpec }));
  const callStage = system("acquire", { actor: "workflow", scope: items ? "content-item" : "project", requiresRoute: false,
    call: { workflow: child.workflowSha256, inputs: { seed: { from: "input.seed" }, slot: { from: "item.id" }, resource: { from: "previous.result.resource" } }, maxOperations },
    ...(repeat ? { repeat: { until: { output: "result.passed", equals: true }, while: { output: "result.again", equals: true }, maxIterations: 2, maxDuration: "1h", maxOperations } } : {}),
  });
  const parent = runtime.publish(flow("parent", [callStage, system("deliver", { needs: ["acquire"] })], { concurrency: { perInstance: 1 }, ...(items ? { contentItems: { maxItems: 5, routes: ["TEST"] } } : {}), ...parentSpec }));
  runtime.startInstance({ id: "ROOT", name: "root", workflowSha256: parent.workflowSha256, inputs: { seed: false, authorizationScope: { paidProduction: true }, nightshift: { instanceDir: dir } },
    ...(items ? { contentItems: [{ id: "one", title: "one", route: "TEST" }, { id: "two", title: "two", route: "TEST" }] } : {}) });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const api = {
    board, dir, child, parent,
    get store() { return store; }, get runtime() { return runtime; },
    tick: (options = {}) => runtime.tick("ROOT", { inspectSessions: false, now: clock, ...options }),
    advance: ms => { clock += ms; },
    reopen: () => { store.close(); store = new NightShiftStore(join(dir, "store.sqlite")); runtime = new NightShiftRuntime({ store, workboard: board, now: () => clock }); },
    finish: async (call, facts, stageId = "verify") => {
      const instance = store.getInstance(call.childId);
      const stage = child.manifest.spec.stages.find(stage => stage.id === stageId);
      const root = instance.inputs.nightshift.instanceDir;
      await mkdir(join(root, "handoffs"), { recursive: true });
      await writeFile(join(root, `${stageId}.json`), JSON.stringify(facts));
      const handoff = handoffManifestExample({ instanceId: instance.id, release: child.manifest, stageId });
      handoff.outputs = stage.outputs.map(name => ({ name, sourceStage: stageId, artifact: `${stageId}.json`, summary: "test evidence" }));
      await writeFile(join(root, "handoffs", `${stageId}.json`), JSON.stringify(handoff));
      const run = store.listStageRuns(instance.id).filter(run => run.stageId === stageId).at(-1);
      assert(run, `stage ${stageId} should have been planned`);
      await board.moveCard(run.cardId, "done");
    },
    reserve: (call, hash = "a".repeat(64)) => {
      const instance = store.getInstance(call.childId);
      const stage = child.manifest.spec.stages[0];
      const run = store.listStageRuns(instance.id).find(run => run.stageId === stage.id);
      return store.reserveExternalOperation({ idempotencyKey: nativeActionKey(actionKey(child.manifest, instance, stage, "run")), requestHash: hash, instanceId: instance.id, stageId: stage.id, ownerCardId: run.cardId }, new Date(clock));
    },
  };
  return api;
}

test("ordinary retry renews an expired attempt and its operation slot, not the project budget", async t => {
  const f = await fixture(t, { repeat: false, maxOperations: 1,
    childStages: [system("verify", { sideEffects: ["external-call"], retry: { maxAttempts: 1, idempotencyKey: "static" } })],
    childSpec: { limits: { maxOperations: 1, maxDuration: "10m" } }, parentSpec: { limits: { maxOperations: 3, maxDuration: "8h" } } });
  await f.tick();
  const call = f.store.listCalls("ROOT")[0], old = f.store.listStageRuns(call.childId)[0];
  const op = f.reserve(call);
  f.store.checkpointExternalOperation(op.idempotencyKey, { status: "failed", result: { code: 45006, terminal: true } });
  const original = f.store.getExternalOperation(op.idempotencyKey);
  await f.board.moveCard(old.cardId, "blocked");
  f.store.upsertStageRun({ ...old, status: "blocked" });
  f.advance(11 * 60000); await f.tick();
  assert.equal(f.store.listCalls("ROOT")[0].reason, "duration-limit");
  await f.runtime.resume({ actor: "V", cardId: old.cardId, allowNewOperation: true, note: "correct request within existing scope" });
  const renewed = f.store.listCalls("ROOT")[0];
  assert.equal(renewed.deadline, call.deadline + 11 * 60000);
  assert.equal(renewed.childId, call.childId);
  await f.tick();
  const retry = f.store.listStageRuns(call.childId).find(run => run.attempt === 2);
  const request = { instanceId: call.childId, stageId: "verify", ownerCardId: retry.cardId, idempotencyKey: "corrected", requestHash: "b".repeat(64) };
  assert.equal(f.store.reserveExternalOperation(request, new Date(renewed.deadline - 1)).reused, false);
  assert.equal(f.store.reserveExternalOperation(request).reused, true);
  assert.equal(f.store.listExternalOperations(call.childId).length, 2);
  assert.deepEqual(f.store.getExternalOperation(op.idempotencyKey), original);
  f.advance(60000); await f.runtime.resume({ actor: "V", cardId: old.cardId, allowNewOperation: true });
  assert.equal(f.store.listCalls("ROOT")[0].deadline, renewed.deadline, "duplicate/stale retry never extends time");
  f.reopen();
  assert.equal(f.store.listCalls("ROOT")[0].deadline, renewed.deadline);
  assert.equal(f.store.getRelease(f.parent.workflowSha256).manifest.spec.limits.maxOperations, 3);
});

async function stoppedRetryFixture(t, options = {}) {
  const f = await fixture(t, { repeat: false, parentSpec: { limits: { maxDuration: "8h", maxOperations: 20 } }, ...options });
  await f.tick();
  const call = f.store.listCalls("ROOT")[0], run = f.store.listStageRuns(call.childId)[0];
  await f.board.moveCard(run.cardId, "blocked");
  f.store.upsertStageRun({ ...run, status: "blocked" });
  f.advance(11 * 60000); await f.tick();
  return { ...f, get store() { return f.store; }, get runtime() { return f.runtime; }, call, run };
}

test("every new stopped native attempt gets a window; duplicate retry and SQLite replay do not", async t => {
  const f = await stoppedRetryFixture(t);
  const card = f.board.cards.find(card => card.id === f.run.cardId);
  for (let attempt = 1; attempt <= 3; attempt++) {
    card.runId = `native-${attempt}`;
    await f.runtime.resume({ actor: "V", cardId: card.id });
    const current = f.store.listCalls("ROOT")[0];
    assert.equal(current.deadline, f.call.deadline + (11 * attempt) * 60000);
    f.advance(60000);
    await f.runtime.resume({ actor: "V", cardId: card.id });
    assert.equal(f.store.listCalls("ROOT")[0].deadline, current.deadline);
    f.reopen();
    assert.equal(f.store.listCalls("ROOT")[0].deadline, current.deadline);
    f.advance(10 * 60000);
    await f.board.moveCard(card.id, "blocked");
    f.store.upsertStageRun({ ...f.run, status: "blocked" });
    await f.tick();
  }
  assert.equal(f.store.listCalls("ROOT").length, 1);
  assert.equal(f.store.listStageRuns(f.call.childId).length, 1);
  assert.equal(f.store.listRetryWindows("ROOT").length, 3);
});

test("retry of a known in-flight task renews time but preserves its original key/task", async t => {
  const f = await stoppedRetryFixture(t);
  const operation = { instanceId: f.call.childId, stageId: "verify", ownerCardId: f.run.cardId, idempotencyKey: "original-task-key", requestHash: "a".repeat(64) };
  f.store.reserveOperationRecord(operation);
  f.store.checkpointExternalOperation(operation.idempotencyKey, { status: "executing", externalTaskId: "original-task" });
  const original = f.store.getExternalOperation(operation.idempotencyKey);
  await f.runtime.resume({ actor: "V", cardId: f.run.cardId });
  assert.equal(f.store.listCalls("ROOT")[0].deadline, f.call.deadline + 11 * 60000);
  assert.deepEqual(f.store.getExternalOperation(operation.idempotencyKey), original);
  assert.equal(f.store.reserveExternalOperation(operation).reused, true);
  assert.equal(f.store.listExternalOperations(f.call.childId).length, 1);
  assert.equal(f.store.listOperationRecoveries("ROOT").length, 0);
});

test("ambiguous task, pause and supersession cannot be cleared by retry", async t => {
  const f = await stoppedRetryFixture(t);
  const operation = { instanceId: f.call.childId, stageId: "verify", ownerCardId: f.run.cardId, idempotencyKey: "ambiguous-task", requestHash: "a".repeat(64) };
  f.store.reserveOperationRecord(operation);
  for (const status of ["reserved", "unknown", "executing"]) {
    f.store.checkpointExternalOperation(operation.idempotencyKey, { status });
    await assert.rejects(f.runtime.resume({ actor: "V", cardId: f.run.cardId }), /ambiguous|readback/);
    assert.equal(f.store.listCalls("ROOT")[0].deadline, f.call.deadline);
  }
  assert.equal(f.store.listRetryWindows("ROOT").length, 0);
  const g = await stoppedRetryFixture(t);
  for (const id of ["ROOT", g.call.childId]) {
    g.store.updateInstanceStatus(id, "paused");
    await assert.rejects(g.runtime.resume({ actor: "V", cardId: g.run.cardId }), /paused/);
    g.store.updateInstanceStatus(id, "active");
  }
  const rootRun = g.store.listStageRuns("ROOT")[0];
  g.store.upsertStageRun({ ...rootRun, attempt: 2, cardId: "superseding-controller", status: "ready" });
  await assert.rejects(g.runtime.resume({ actor: "V", cardId: g.run.cardId }), /superseded/);
});

test("normal retry renews an expired root attempt clock without clearing the cumulative operation cap", async t => {
  const f = await stoppedRetryFixture(t, { parentSpec: { limits: { maxDuration: "15m", maxOperations: 1 } } });
  const createdAt = f.store.getInstance("ROOT").createdAt;
  const operation = { instanceId: f.call.childId, stageId: "verify", ownerCardId: f.run.cardId,
    idempotencyKey: "historical-root-budget", requestHash: "c".repeat(64) };
  f.store.reserveOperationRecord(operation);
  f.store.checkpointExternalOperation(operation.idempotencyKey, { status: "succeeded", externalTaskId: "owned-original" });
  const old = f.store.getExternalOperation(operation.idempotencyKey);
  f.advance(5 * 60000);
  const originalDeadline = f.store.executionDeadline("ROOT");
  await f.runtime.resume({ actor: "V", cardId: f.run.cardId });
  const reset = f.store.listRetryWindows("ROOT")[0];
  assert.equal(reset.instanceDeadlines.ROOT, Date.parse(reset.createdAt) + 15 * 60000);
  assert.ok(reset.instanceDeadlines.ROOT > originalDeadline);
  assert.equal(f.store.executionDeadline("ROOT"), reset.instanceDeadlines.ROOT);
  assert.equal(f.store.getInstance("ROOT").createdAt, createdAt);
  assert.equal(f.store.getCall(f.call.id).childId, f.call.childId);
  assert.equal(f.store.getCall(f.call.id).deadline, Date.parse(reset.createdAt) + 10 * 60000);
  assert.deepEqual(f.store.getExternalOperation(operation.idempotencyKey), old);
  await assert.rejects(async () => f.store.reserveExternalOperation({ ...operation, idempotencyKey: "must-still-count-old", requestHash: "d".repeat(64) }), /Project external-operation limit/);
  f.advance(60000);
  await f.runtime.resume({ actor: "V", cardId: f.run.cardId });
  assert.equal(f.store.executionDeadline("ROOT"), reset.instanceDeadlines.ROOT);
  f.reopen();
  assert.equal(f.store.executionDeadline("ROOT"), reset.instanceDeadlines.ROOT);
  assert.equal(f.store.listExternalOperations(f.call.childId).length, 1);
});

test("an ordinary queued root stage renews its own technical clock without another permission API", async t => {
  const store = new NightShiftStore(), board = new CallBoard();
  t.after(() => store.close());
  let now = Date.now();
  const runtime = new NightShiftRuntime({ store, workboard: board, now: () => now });
  const release = runtime.publish(flow("ordinary-root", [system("prepare")], { limits: { maxDuration: "15m", maxOperations: 2 } }));
  runtime.startInstance({ id: "ROOT", name: "root", workflowSha256: release.workflowSha256, inputs: {} });
  await runtime.tick("ROOT", { inspectSessions: false, now });
  const run = store.listStageRuns("ROOT")[0];
  now += 16 * 60000;
  const ambiguous = { instanceId: "ROOT", stageId: "prepare", ownerCardId: run.cardId, idempotencyKey: "unknown-root", requestHash: "b".repeat(64) };
  store.reserveOperationRecord(ambiguous);
  store.checkpointExternalOperation(ambiguous.idempotencyKey, { status: "unknown" });
  await assert.rejects(runtime.resume({ actor: "V", cardId: run.cardId }), /ambiguous|readback/);
  assert.equal(store.listRetryWindows("ROOT").length, 0);
  store.checkpointExternalOperation(ambiguous.idempotencyKey, { status: "succeeded", externalTaskId: "original" });
  await runtime.resume({ actor: "V", cardId: run.cardId });
  const deadline = store.executionDeadline("ROOT");
  assert.equal(deadline, now + 15 * 60000);
  assert.equal(board.cards.find(card => card.id === run.cardId).status, "ready");
  now += 60000;
  assert.equal((await runtime.resume({ actor: "V", cardId: run.cardId })).alreadyResumed, true);
  assert.equal(store.executionDeadline("ROOT"), deadline);
  assert.equal(store.listExternalOperations("ROOT").length, 1);
});

test("controller retry resets duration only, never iteration or business holds", async t => {
  const f = await stoppedRetryFixture(t);
  await f.runtime.resume({ actor: "V", cardId: f.call.cardId });
  assert.equal(f.store.listCalls("ROOT")[0].deadline, f.call.deadline + 11 * 60000);
  assert.equal(f.store.listCalls("ROOT")[0].childId, f.call.childId);
  assert.equal(f.board.cards.find(card => card.id === f.run.cardId).status, "blocked", "controller retry does not silently reopen child work");
  f.store.saveCall({ ...f.store.listCalls("ROOT")[0], state: "held", reason: "iteration-limit" });
  await assert.rejects(f.runtime.resume({ actor: "V", cardId: f.call.cardId }), /iteration/);
  const g = await stoppedRetryFixture(t);
  g.store.saveCall({ ...g.call, state: "held", reason: "no-matching-continuation" });
  await assert.rejects(g.runtime.resume({ actor: "V", cardId: g.run.cardId }), /hold/);
});

test("an expired call can be retried through its existing queued child, without manufacturing a blocked card", async t => {
  const f = await fixture(t, { repeat: false, parentSpec: { limits: { maxDuration: "8h" } } });
  await f.tick();
  const call = f.store.listCalls("ROOT")[0], run = f.store.listStageRuns(call.childId)[0];
  f.advance(11 * 60000); await f.tick();
  assert.equal(f.board.cards.find(card => card.id === run.cardId).status, "ready");
  const result = await f.runtime.resume({ actor: "V", cardId: run.cardId });
  assert.equal(result.alreadyResumed, false);
  const deadline = f.store.listCalls("ROOT")[0].deadline;
  assert.equal(deadline, call.deadline + 11 * 60000);
  f.advance(60000);
  assert.equal((await f.runtime.resume({ actor: "V", cardId: run.cardId })).alreadyResumed, true);
  assert.equal(f.store.listCalls("ROOT")[0].deadline, deadline);
});

test("parent reconciliation does not overwrite a window renewed during child recovery", async t => {
  const f = await fixture(t, { repeat: false });
  await f.tick();
  const call = f.store.listCalls("ROOT")[0], run = f.store.listStageRuns(call.childId)[0];
  await f.board.moveCard(run.cardId, "blocked");
  f.store.upsertStageRun({ ...run, status: "blocked" });
  f.advance(60000);
  f.runtime.beforeCallTick = async () => {
    f.runtime.beforeCallTick = null;
    await f.runtime.resume({ actor: "V", cardId: run.cardId });
  };
  await f.tick();
  assert.equal(f.store.listCalls("ROOT")[0].deadline, call.deadline + 60000);
});

test("call once, success exit and downstream handoff reuse the original workflow", async t => {
  const f = await fixture(t, { repeat: false });
  await f.tick();
  const [call] = f.store.listCalls("ROOT");
  assert.equal(f.store.listInstances().length, 1, "internal calls are not separate business projects");
  assert.equal(f.store.getInstance(call.childId).inputs.seed, false);
  assert(schedulerCardIds(f.store).includes(f.store.listStageRuns(call.childId)[0].cardId));
  await f.finish(call, { passed: true, resource: "verified-resource" });
  await f.tick();
  await f.tick();
  assert.equal(f.store.listCalls("ROOT").length, 1);
  assert.equal(f.store.listStageRuns("ROOT").filter(run => run.stageId === "deliver").length, 1);
  const handoff = JSON.parse(await readFile(join(f.dir, "handoffs/acquire.json")));
  const facts = JSON.parse(await readFile(join(f.dir, handoff.outputs[0].artifact)));
  assert.equal(facts.resource, "verified-resource");
});

test("new rounds preserve old evidence, carry resources and isolate even custom operation templates", async t => {
  const f = await fixture(t, { childStages: [system("verify", { retry: { maxAttempts: 1, idempotencyKey: "a-hardcoded-template" } })] });
  await f.tick();
  const first = f.store.listCalls("ROOT")[0];
  const firstOp = f.reserve(first);
  f.store.checkpointExternalOperation(firstOp.idempotencyKey, { status: "succeeded", result: { resource: "reusable" } });
  await f.finish(first, { passed: false, again: true, resource: "reusable" });
  await f.tick();
  assert.equal(f.store.listStageRuns("ROOT").some(run => run.stageId === "deliver"), false);
  f.reopen();
  await Promise.all([f.tick(), f.tick(), f.tick()]);
  const calls = f.store.listCalls("ROOT");
  assert.equal(calls.length, 2);
  assert.equal(f.store.getInstance(calls[1].childId).inputs.resource, "reusable");
  assert.notEqual(f.reserve(calls[1], "b".repeat(64)).idempotencyKey, firstOp.idempotencyKey);
  await f.finish(calls[1], { passed: true });
  // A still-reserved external call must stop an otherwise successful result.
  await f.tick();
  assert.equal(f.store.listCalls("ROOT")[1].state, "held");
  f.store.checkpointExternalOperation(f.store.listExternalOperations(calls[1].childId)[0].idempotencyKey, { status: "succeeded" });
  await f.runtime.resume({ actor: "V", cardId: calls[1].cardId, note: "readback confirmed" });
  await f.tick();
  assert.equal(f.store.listCalls("ROOT")[1].state, "succeeded");
  assert.deepEqual(f.store.listExternalOperations(first.childId)[0].result, { resource: "reusable" });
  assert.equal(f.store.listStageRuns("ROOT").filter(run => run.stageId === "deliver").length, 1);
});

test("unknown outcomes block fresh iterations and cannot be bypassed by retry", async t => {
  const f = await fixture(t);
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  const op = f.reserve(call);
  f.store.checkpointExternalOperation(op.idempotencyKey, { status: "unknown" });
  await f.finish(call, { passed: false, again: true });
  await f.tick();
  assert.match(f.store.listCalls("ROOT")[0].reason, /unknown/);
  await assert.rejects(f.runtime.resume({ actor: "V", cardId: call.cardId }), /readback/);
  await f.tick();
  assert.equal(f.store.listCalls("ROOT").length, 1);
  assert.equal(f.store.listStageRuns("ROOT").some(run => run.stageId === "deliver"), false);
});

test("iteration limit is persistent and retry cannot reset it", async t => {
  const f = await fixture(t);
  await f.tick();
  let call = f.store.listCalls("ROOT").at(-1);
  await f.finish(call, { again: true });
  await f.tick(); await f.tick();
  call = f.store.listCalls("ROOT").at(-1);
  await f.finish(call, { again: true });
  await f.tick();
  assert.equal(f.store.listCalls("ROOT").at(-1).reason, "iteration-limit");
  await assert.rejects(f.runtime.resume({ actor: "V", cardId: call.cardId }), /iteration limit/);
  f.reopen(); await f.tick();
  assert.equal(f.store.listCalls("ROOT").length, 2);
});

test("duration limit prevents dispatch and new reservation, but not safe receipt reuse", async t => {
  const f = await fixture(t);
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  const op = f.reserve(call);
  f.advance(3600001);
  await f.tick({ dispatch: true });
  assert.equal(f.store.listCalls("ROOT")[0].reason, "duration-limit");
  assert.equal(f.board.starts.length, 0);
  assert.equal(f.reserve(call).reused, true);
  await assert.rejects(f.runtime.resume({ actor: "V", cardId: call.cardId }), /ambiguous|readback/);
  assert.equal(f.store.getExternalOperation(op.idempotencyKey).status, "reserved");
});

test("operation allowance is shared across rounds; failed calls still consume allowance", async t => {
  const f = await fixture(t, { maxOperations: 1 });
  await f.tick();
  const first = f.store.listCalls("ROOT")[0];
  const op = f.reserve(first);
  f.store.checkpointExternalOperation(op.idempotencyKey, { status: "failed" });
  await f.finish(first, { again: true });
  await f.tick(); await f.tick();
  const next = f.store.listCalls("ROOT")[1];
  assert.throws(() => f.reserve(next), /limit/);
  assert.equal(f.store.listExternalOperations(next.childId).length, 0);
  assert.equal(f.reserve(first).reused, true);
});

test("per-item loops isolate successful slots; root concurrency is shared by all children", async t => {
  const f = await fixture(t, { items: true });
  await f.tick({ dispatch: true });
  await f.tick({ dispatch: true });
  assert.equal(f.store.listCalls("ROOT").length, 2);
  assert.equal(f.board.starts.length, 1, "root concurrency of one covers both calls");
  const calls = f.store.listCalls("ROOT");
  await f.finish(calls[0], { passed: true });
  await f.finish(calls[1], { again: true, resource: 0 });
  await f.tick(); await f.tick();
  const latest = f.store.listCalls("ROOT");
  assert.equal(latest.filter(call => call.contentItemId === calls[0].contentItemId).length, 1);
  assert.equal(latest.filter(call => call.contentItemId === calls[1].contentItemId).length, 2);
  assert.equal(f.store.getInstance(latest.at(-1).childId).inputs.resource, 0);
  assert.equal(f.store.listStageRuns("ROOT").some(run => run.stageId === "deliver"), false);
  assert.deepEqual(new Set(instanceCardIds(f.store, "ROOT")), new Set(f.runtime.instanceCardIds("ROOT")));
});

test("missing/ambiguous result stops; outputs do not leak through public summaries", async t => {
  const f = await fixture(t);
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  await f.finish(call, { password: "synthetic-do-not-expose", passed: "true" });
  await f.tick();
  assert.equal(f.store.listCalls("ROOT")[0].state, "held");
  assert(!JSON.stringify(publicCallSummary(f.store, "ROOT")).includes("synthetic-do-not-expose"));
});

test("paused root prevents child dispatch, recovery and new external calls", async t => {
  const f = await fixture(t);
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  f.store.updateInstanceStatus("ROOT", "paused");
  await f.tick({ dispatch: true });
  assert.equal(f.board.starts.length, 0);
  assert.throws(() => f.reserve(call), /paused/);
  const childCard = f.store.listStageRuns(call.childId)[0].cardId;
  await f.board.moveCard(childCard, "blocked");
  await assert.rejects(f.runtime.resume({ actor: "V", cardId: childCard }), /paused/);
});

import { boundCallInputs } from "../src/workflow-calls.mjs";
import { buildNeedsYou } from "../src/needs-you.mjs";
import { taskAttention } from "../../../apps/nightshift-dashboard/client/src/attention.js";
import { parseWorkflow, compileWorkflow, validateWorkflow } from "../src/workflow.mjs";

test("binding defaults preserve false/0/null and cannot manufacture authorization", () => {
  const stage = { call: { inputs: { flag: { from: "input.flag", default: true }, zero: { from: "input.zero", default: 1 }, nullable: { from: "input.nullable", default: "fallback" }, first: { from: "previous.fact", default: false }, object: { value: { reusable: true } } } } };
  assert.deepEqual(boundCallInputs(stage, { inputs: { flag: false, zero: 0, nullable: null, authorizationScope: { paidProduction: false } } }, null), { flag: false, zero: 0, nullable: null, first: false, object: { reusable: true }, authorizationScope: { paidProduction: false } });
  const invalid = parseWorkflow(flow("invalid", [system("invoke", { actor: "workflow", call: { workflow: "a".repeat(64), inputs: { authorizationScope: { value: { paidProduction: true } } } } })]));
  assert(validateWorkflow(invalid).some(issue => /Reserved/.test(issue.message)));
});

test("invalid pins, unknown options, unsafe exports and unbounded repeats are rejected", () => {
  for (const extra of [
    { call: { workflow: "latest", inputs: {} } },
    { call: { workflow: "a".repeat(64), inputs: {}, maxCurrency: 100 } },
    { repeat: { until: { output: "result.ok", equals: true } } },
    { repeat: { until: { output: "result.ok", equals: true }, while: { output: "result.again", equals: true }, maxIterations: 0, maxDuration: "forever", maxOperations: -1 } },
  ]) {
    const document = parseWorkflow(flow("invalid", [system("invoke", { actor: "workflow", call: { workflow: "a".repeat(64), inputs: {} }, ...extra })]));
    assert.throws(() => compileWorkflow(document));
  }
  assert.throws(() => compileWorkflow(parseWorkflow(flow("invalid", [system("verify")], { outputs: { result: { stage: "absent", output: "result" } } }))));
});

test("torn next-round creation replays the transition instead of misclassifying it as business failure", async t => {
  const f = await fixture(t);
  await f.tick();
  const first = f.store.listCalls("ROOT")[0];
  await f.finish(first, { again: true });
  const create = f.store.createCall.bind(f.store);
  f.store.createCall = () => { throw new Error("injected storage interruption"); };
  await assert.rejects(f.tick(), /storage interruption/);
  assert.equal(f.store.listCalls("ROOT")[0].state, "continued");
  f.store.createCall = create;
  f.reopen();
  await f.tick(); await f.tick();
  assert.equal(f.store.listCalls("ROOT").length, 2);
  assert.equal(f.store.listCalls("ROOT")[1].iteration, 2);
});

test("context creation is atomic if child insertion fails", async t => {
  const f = await fixture(t);
  const create = f.store.createInstance.bind(f.store);
  f.store.createInstance = () => { throw new Error("injected insertion failure"); };
  await assert.rejects(f.tick(), /insertion failure/);
  assert.equal(f.store.listCalls("ROOT").length, 0);
  assert.equal(f.store.listInstances({ includeInternal: true }).length, 1);
  f.store.createInstance = create;
  await f.tick();
  assert.equal(f.store.listCalls("ROOT").length, 1);
});

test("nested calls reuse Runtime and obey their strictest ancestor allowance", async t => {
  const f = await fixture(t);
  const middle = f.runtime.publish(flow("middle", [system("invoke", { actor: "workflow", call: { workflow: f.child.workflowSha256, inputs: {}, maxOperations: 2 } })], { outputs: { result: { stage: "invoke", output: "result" } } }));
  const outer = f.runtime.publish(flow("outer", [system("invoke", { actor: "workflow", call: { workflow: middle.workflowSha256, inputs: {}, maxOperations: 0 } })]));
  f.runtime.startInstance({ id: "NEST", name: "nested", workflowSha256: outer.workflowSha256, inputs: { nightshift: { instanceDir: join(f.dir, "nested") } } });
  await f.runtime.tick("NEST", { inspectSessions: false });
  const middleCall = f.store.listCalls("NEST")[0];
  const leaf = f.store.listCalls(middleCall.childId)[0];
  assert(leaf);
  assert.throws(() => f.reserve(leaf), /limit/);
  await f.finish(leaf, { passed: true });
  await f.runtime.tick("NEST", { inspectSessions: false });
  await f.runtime.tick("NEST", { inspectSessions: false });
  assert.equal(f.store.getInstance("NEST").status, "done");
  assert.equal(f.store.listInstances().length, 2, "nested contexts stay inside root projects");
});

test("project allowance covers different items and direct operations, not one allowance per call", async t => {
  const f = await fixture(t, { items: true, parentSpec: { limits: { maxOperations: 1 } } });
  await f.tick(); await f.tick();
  const calls = f.store.listCalls("ROOT");
  const op = f.reserve(calls[0]);
  assert.equal(f.reserve(calls[0]).reused, true);
  assert.throws(() => f.reserve(calls[1], "b".repeat(64)), /Project external-operation limit/);
  assert.equal(f.store.getExternalOperation(op.idempotencyKey).status, "reserved");
});

test("technical retry stays in the same round and stopped child is visible to V", async t => {
  const f = await fixture(t);
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  const run = f.store.listStageRuns(call.childId)[0];
  await f.board.moveCard(run.cardId, "blocked");
  await f.tick();
  const queue = buildNeedsYou({ store: f.store, instances: f.store.listInstances(), cards: f.board.cards, releases: f.store.listReleases() });
  assert(queue.items.some(item => item.kind === "workflow-call" && item.instanceId === "ROOT"));
  const originalKey = actionKey(f.child.manifest, f.store.getInstance(call.childId), f.child.manifest.spec.stages[0], "run");
  assert.equal((await f.runtime.resume({ actor: "V", cardId: run.cardId })).how, "same");
  await f.tick();
  assert.equal(f.store.listCalls("ROOT").length, 1);
  assert.equal(f.store.listStageRuns(call.childId)[0].cardId, run.cardId);
  assert.equal(actionKey(f.child.manifest, f.store.getInstance(call.childId), f.child.manifest.spec.stages[0], "run"), originalKey);
  assert.equal(taskAttention({ status: "review", workflowCall: { iteration: 1, state: "running", blocked: false } }).kind, "running");
});

test("explicit controller retry rechecks corrected exports without reopening a succeeded call", async t => {
  const f = await fixture(t);
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  await f.finish(call, { passed: false, again: false });
  await f.tick();
  assert.equal(f.store.getCall(call.id).state, "held");
  await f.finish(call, { passed: true, again: false });
  assert.equal((await f.runtime.resume({ actor: "V", cardId: call.cardId })).alreadyResumed, false);
  assert.equal((await f.runtime.resume({ actor: "V", cardId: call.cardId })).alreadyResumed, true);
  await f.tick();
  assert.equal(f.store.getCall(call.id).state, "succeeded");
  await f.finish(call, { passed: false, again: true });
  assert.equal((await f.runtime.resume({ actor: "V", cardId: call.cardId })).alreadyResumed, true);
  await f.tick();
  assert.equal(f.store.getCall(call.id).outputs.result.passed, true);
  assert.equal(f.store.listCalls("ROOT").length, 1);
  assert.equal(f.store.listExternalOperations(call.childId).length, 0);
});

test("controller export recheck remains held on invalid JSON or unreadable artifacts", async t => {
  for (const unreadable of [false, true]) {
    await t.test(unreadable ? "missing artifact" : "invalid JSON", async t => {
      const f = await fixture(t);
      await f.tick();
      const call = f.store.listCalls("ROOT")[0];
      await f.finish(call, { passed: false, again: false });
      await f.tick();
      const artifact = join(f.store.getInstance(call.childId).inputs.nightshift.instanceDir, "verify.json");
      if (unreadable) await rm(artifact);
      else await writeFile(artifact, "not JSON");
      await f.runtime.resume({ actor: "V", cardId: call.cardId });
      await f.tick();
      assert.match(f.store.getCall(call.id).reason, /^output-contract:/);
      assert.equal(f.store.getCall(call.id).state, "held");
      await f.finish(call, { passed: true, again: false });
      await f.runtime.resume({ actor: "V", cardId: call.cardId });
      await f.tick();
      assert.equal(f.store.getCall(call.id).state, "succeeded");
      assert.equal(f.store.listCalls("ROOT").length, 1);
      assert.equal(f.store.listExternalOperations(call.childId).length, 0);
    });
  }
});

test("explicit duration retry discards a persisted stale output snapshot", async t => {
  const f = await fixture(t, { parentSpec: { limits: { maxDuration: "8h" } } });
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  await f.finish(call, { passed: true, again: false });
  f.store.saveCall({ ...call, outputs: { result: { passed: false, again: false } } });
  f.advance(11 * 60000);
  await f.tick();
  assert.equal(f.store.getCall(call.id).reason, "duration-limit");
  await f.runtime.resume({ actor: "V", cardId: call.cardId });
  await f.tick();
  assert.equal(f.store.getCall(call.id).state, "succeeded");
  assert.equal(f.store.getCall(call.id).childId, call.childId);
  assert.equal(f.store.listCalls("ROOT").length, 1);
  assert.equal(f.store.listExternalOperations(call.childId).length, 0);
});

test("export identity mismatch or missing handoff cannot release downstream", async t => {
  const f = await fixture(t);
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  await f.finish(call, { passed: true });
  const file = join(f.store.getInstance(call.childId).inputs.nightshift.instanceDir, "handoffs/verify.json");
  const handoff = JSON.parse(await readFile(file)); handoff.instanceId = "PREVIOUS-ROUND";
  await writeFile(file, JSON.stringify(handoff));
  await f.tick();
  assert.match(f.store.listCalls("ROOT")[0].reason, /instance mismatch/);
  assert.equal(f.store.listStageRuns("ROOT").some(run => run.stageId === "deliver"), false);
});

test("shipped examples really compile, pin each other, publish and create a called project", async t => {
  const f = await fixture(t);
  const child = f.runtime.publish(await readFile(new URL("../../../examples/workflows/reusable-verified-work.workflow.md", import.meta.url), "utf8"));
  const parent = f.runtime.publish(await readFile(new URL("../../../examples/workflows/repeat-verified-work.workflow.md", import.meta.url), "utf8"));
  assert.equal(parent.manifest.spec.stages[0].call.workflow, child.workflowSha256);
  f.runtime.startInstance({ id: "EXAMPLE", workflowSha256: parent.workflowSha256, agentBindings: { operator: "test-only-not-dispatched" }, inputs: { brief: "Synthetic", nightshift: { instanceDir: join(f.dir, "example") } } });
  await f.runtime.tick("EXAMPLE", { inspectSessions: false });
  const call = f.store.listCalls("EXAMPLE")[0];
  assert.equal(f.store.getInstance(call.childId).inputs.reuseAllowed, false);
  assert.equal(f.store.listStageRuns(call.childId)[0].stageId, "prepare");
});

test("child human approval remains visible under its original parent project", async t => {
  const f = await fixture(t, { childStages: [system("verify", { actor: "human", approval: { actions: ["approve", "request-changes", "reject"], evidenceRequired: true } })] });
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  const childCardId = f.store.listStageRuns(call.childId)[0].cardId;
  const queue = buildNeedsYou({ store: f.store, instances: f.store.listInstances(), cards: f.board.cards, releases: f.store.listReleases() });
  const approval = queue.items.find(item => item.cardId === childCardId);
  assert.equal(approval.kind, "review");
  assert.equal(approval.instanceId, "ROOT");
  assert.equal(approval.executionInstanceId, call.childId);
  assert.equal(f.store.listStageRuns("ROOT").some(run => run.stageId === "deliver"), false);
});

test("skipped and superseded calling units cannot keep dispatching or reserving", async t => {
  const f = await fixture(t, { items: true });
  await f.tick(); await f.tick();
  const calls = f.store.listCalls("ROOT");
  f.store.skipContentItem({ instanceId: "ROOT", contentItemId: calls[0].contentItemId, actor: "test", reason: "explicitly skipped" });
  assert.throws(() => f.reserve(calls[0]), /skipped/);
  const run = f.store.listContentItemRuns("ROOT").find(run => run.cardId === calls[1].cardId);
  const original = f.board.cards.find(card => card.id === run.cardId);
  f.board.cards.push({ ...original, id: "replacement-controller", status: "blocked" });
  f.store.upsertContentItemRun({ ...run, attempt: 2, cardId: "replacement-controller", status: "blocked" });
  assert.throws(() => f.reserve(calls[1]), /superseded/);
  await f.tick({ dispatch: true });
  assert.equal(f.board.starts.length, 0);
});

test("exports support the existing relative-to-handoff path convention", async t => {
  const f = await fixture(t);
  await f.tick();
  const call = f.store.listCalls("ROOT")[0];
  await f.finish(call, { passed: true });
  const file = join(f.store.getInstance(call.childId).inputs.nightshift.instanceDir, "handoffs/verify.json");
  const handoff = JSON.parse(await readFile(file)); handoff.outputs[0].artifact = "../verify.json";
  await writeFile(file, JSON.stringify(handoff));
  await f.tick();
  assert.equal(f.store.listCalls("ROOT")[0].state, "succeeded");
});
