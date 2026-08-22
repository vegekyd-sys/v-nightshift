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
const workflowPath = resolve(here, "../../../examples/workflows/xingqing-content-delivery.v0.2.yaml");

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
  const second = await runtime.tick("NS-RUNTIME-1");
  assert.equal(second.actions[0].stageId, "materials");
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
  store.upsertStageRun({ instanceId: "NS-RUNTIME-2", stageId: "materials", status: "done" });
  const requested = await runtime.tick("NS-RUNTIME-2");
  assert.equal(requested.actions[0].type, "request_approval");
  const cardId = requested.applied[0].card.id;
  await runtime.approve({
    actor: "tianyi",
    cardId,
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

class FakeWorkboard {
  constructor() {
    this.cards = [];
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

  async dispatch() {
    return { started: [] };
  }
}
