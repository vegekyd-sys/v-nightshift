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
    stageId: "produce",
  });
  const after = await runtime.tick("NS-RUNTIME-2");
  assert.equal(after.actions[0].type, "create_workboard_card");
  assert.equal(after.actions[0].stageId, "produce");
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
  const result = await runtime.tick("NS-RUNTIME-READY", { dispatch: true });
  assert.deepEqual(result.actions, []);
  assert.deepEqual(workboard.dispatchCalls, [1]);
  store.close();
});

test("rejects a done card when its declared delivery fails validation", async () => {
  const source = await readFile(workflowPath, "utf8");
  const store = new NightShiftStore();
  const workboard = new FakeWorkboard();
  const runtime = new NightShiftRuntime({
    completionValidator: async () => { throw new Error("invalid delivery manifest"); },
    store,
    workboard,
  });
  const release = runtime.publish(source);
  runtime.startInstance({
    id: "NS-RUNTIME-INVALID-DELIVERY",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
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
  store.close();
});

class FakeWorkboard {
  constructor() {
    this.cards = [];
    this.dispatchCalls = [];
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

  async dispatch(maxStarts) {
    this.dispatchCalls.push(maxStarts);
    return { started: [] };
  }
}
