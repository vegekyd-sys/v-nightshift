import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  compileWorkflow,
  loadWorkflow,
  planNextActions,
  validateWorkflow,
} from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(
  here,
  "../../../examples/workflows/xingqing-content-delivery.v0.2.yaml",
);

test("compiles the six-stage Xingqing workflow deterministically", async () => {
  const workflow = await loadWorkflow(fixture);
  const first = compileWorkflow(workflow);
  const second = compileWorkflow(workflow);
  assert.equal(first.metadata.workflowSha256, second.metadata.workflowSha256);
  assert.deepEqual(
    first.spec.stages.map((stage) => stage.id),
    ["plan", "materials", "produce", "review", "publish", "measure"],
  );
  assert.deepEqual(first.spec.stages[1].needs, ["plan"]);
});

test("rejects duplicate IDs and unsafe side effects", async () => {
  const workflow = structuredClone(await loadWorkflow(fixture));
  workflow.spec.stages[1].id = "plan";
  delete workflow.spec.stages[2].approval;
  const codes = validateWorkflow(workflow).map((entry) => entry.code);
  assert.ok(codes.includes("stage.duplicate"));
  assert.ok(codes.includes("stage.approval.required"));
});

test("rejects dependency cycles", async () => {
  const workflow = structuredClone(await loadWorkflow(fixture));
  workflow.spec.stages[0].needs = ["measure"];
  const codes = validateWorkflow(workflow).map((entry) => entry.code);
  assert.ok(codes.includes("workflow.cycle"));
});

test("plans only the first runnable card for a serial instance", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  const actions = planNextActions({ release, instance });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "create_workboard_card");
  assert.equal(actions[0].stageId, "plan");
  assert.match(actions[0].idempotencyKey, /:run:/);
});

test("does not duplicate an existing ready card", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  const actions = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", attempt: 1, status: "ready" }],
  });
  assert.deepEqual(actions, []);
});

test("advances after proof completion and requests paid-production approval", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  const planDone = [{ stageId: "plan", attempt: 1, status: "done" }];
  assert.equal(
    planNextActions({ release, instance, runs: planDone })[0].stageId,
    "materials",
  );

  const materialsDone = [
    ...planDone,
    { stageId: "materials", attempt: 1, status: "done" },
  ];
  const approval = planNextActions({ release, instance, runs: materialsDone });
  assert.equal(approval[0].type, "request_approval");
  assert.equal(approval[0].stageId, "produce");

  instance.approvals = [
    { stageId: "produce", effect: "paid-production", status: "approved" },
  ];
  const approved = planNextActions({ release, instance, runs: materialsDone });
  assert.equal(approved[0].type, "create_workboard_card");
  assert.equal(approved[0].stageId, "produce");
});

test("turns a human stage into a Workboard review card", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  const actions = planNextActions({
    release,
    instance,
    runs: [
      { stageId: "plan", attempt: 1, status: "done" },
      { stageId: "materials", attempt: 1, status: "done" },
      { stageId: "produce", attempt: 1, status: "done" },
    ],
  });
  assert.equal(actions[0].type, "create_review_card");
  assert.equal(actions[0].stageId, "review");
  assert.equal(actions[0].card.status, "review");
});

test("refuses to schedule an instance pinned to another workflow release", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.workflowSha256 = "different";
  assert.throws(
    () => planNextActions({ release, instance }),
    /pinned to a different workflow release/,
  );
});

function activeInstance(release) {
  return {
    id: "NS-LAB-001",
    name: "VLab 星擎试验",
    status: "active",
    workflowSha256: release.metadata.workflowSha256,
    inputs: {
      customerId: "fixture-customer",
      briefUrl: "https://example.invalid/brief",
      targetCount: 1,
    },
  };
}
