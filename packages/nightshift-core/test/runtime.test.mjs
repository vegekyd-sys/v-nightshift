import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  NightShiftRuntime,
  NightShiftStore,
} from "../src/index.mjs";

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

  assert.equal(workboard.cards[0].status, "blocked");
  assert.equal(workboard.blockCalls.length, 1);
  assert.match(workboard.blockCalls[0].reason, /handoff missing/);
  assert.ok(store.listEvents("NS-RUNTIME-TERMINAL-BLOCK").some((event) => event.type === "stage.terminal.blocked"));
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
  assert.match(workboard.updateCalls.at(-1).patch.idempotencyKey, /^nightshift:[a-f0-9]{64}$/);
  assert.ok(workboard.updateCalls.at(-1).patch.idempotencyKey.length <= 160);
  assert.equal(workboard.cards[0].maxRuntimeSeconds, 14_400);
  assert.match(workboard.cards[0].notes, /\{"version":1/);
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
    this.completeCalls = [];
    this.completeFailures = 0;
    this.dispatchCalls = [];
    this.updateCalls = [];
    this.sessions = new Map();
  }

  async listCards() {
    return this.cards;
  }

  async applyPlan(actions) {
    return actions.map((action) => {
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
      const created = { id: `card-${this.cards.length + 1}`, ...card };
      this.cards.push(created);
      return { action, card: created, status: "created" };
    });
  }

  async moveCard(id, status) {
    const card = this.cards.find((entry) => entry.id === id);
    card.status = status;
    return card;
  }

  async updateCard(id, patch) {
    this.updateCalls.push({ id, patch });
    const card = this.cards.find((entry) => entry.id === id);
    Object.assign(card, patch);
    return card;
  }

  async dispatch(maxStarts, options) {
    this.dispatchCalls.push({ maxStarts, options });
    return { started: [] };
  }

  async getSession(sessionKey) {
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
