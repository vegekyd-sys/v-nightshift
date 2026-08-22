import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { compileWorkflow, loadWorkflow, planNextActions, validateWorkflow } from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");
const genericFixture = resolve(here, "../../../examples/workflows/generic-agent-delivery.workflow.md");

test("compiles the seven-stage workflow.md deterministically", async () => {
  const workflow = await loadWorkflow(fixture);
  const first = compileWorkflow(workflow);
  const second = compileWorkflow(workflow);
  assert.equal(first.metadata.workflowSha256, second.metadata.workflowSha256);
  assert.deepEqual(first.spec.stages.map((stage) => stage.id), [
    "plan", "route", "materials", "brief", "produce", "review", "publish-feedback",
  ]);
  assert.equal(first.spec.stages[1].scope, "content-item");
  assert.deepEqual(first.spec.contentItems.routes, ["AI_GENERATE", "SCENE_EDIT"]);
});

test("the same compiler accepts a non-Xingqing workflow without content items", async () => {
  const release = compileWorkflow(await loadWorkflow(genericFixture));
  assert.equal(release.metadata.id, "generic-agent-delivery");
  assert.deepEqual(release.spec.stages.map((stage) => stage.id), ["understand", "execute", "review"]);
  assert.equal(release.spec.contentItems, undefined);
});

test("rejects duplicate IDs, cycles, and unapproved side effects", async () => {
  const duplicate = structuredClone(await loadWorkflow(fixture));
  duplicate.spec.stages[1].id = "plan";
  delete duplicate.spec.stages[4].approval;
  const codes = validateWorkflow(duplicate).map((entry) => entry.code);
  assert.ok(codes.includes("stage.duplicate"));
  assert.ok(codes.includes("stage.approval.required"));

  const cyclic = structuredClone(await loadWorkflow(fixture));
  cyclic.spec.stages[0].needs = ["publish-feedback"];
  assert.ok(validateWorkflow(cyclic).some((entry) => entry.code === "workflow.cycle"));
});

test("plans the project stage and redacts secrets", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.nightshift = { instanceDir: "/srv/nightshift/NS-LAB-001" };
  instance.inputs.apiKey = "must-not-appear";
  const actions = planNextActions({ release, instance });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].stageId, "plan");
  assert.match(actions[0].card.notes, /每条计划视频拆成独立 ContentItem/);
  assert.match(actions[0].card.notes, /"apiKey":"\[REDACTED\]"/);
  assert.doesNotMatch(actions[0].card.notes, /must-not-appear/);
});

test("fans one project out into independent content-item route cards", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  const actions = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems: twoItems(),
  });
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((action) => action.contentItemId), ["video-ai-01", "video-scene-01"]);
  assert.ok(actions.every((action) => action.stageId === "route"));
  assert.match(actions[0].card.title, /AI 产品视觉/);
  assert.ok(actions[0].card.labels.includes("content-item:video-ai-01"));
});

test("selects route-specific material skills without creating a second workflow", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const actions = planNextActions({
    release,
    instance: activeInstance(release),
    runs: [{ stageId: "plan", status: "done" }],
    contentItems: twoItems(),
    contentItemRuns: [
      { contentItemId: "video-ai-01", stageId: "route", status: "done" },
      { contentItemId: "video-scene-01", stageId: "route", status: "done" },
    ],
  });
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0].card.automation.skills, ["lark-doc", "scene-cli", "material-verification"]);
  assert.deepEqual(actions[1].card.automation.skills, ["shooting-checklist-v2", "scene-cli", "material-verification"]);
});

test("paid production approval is isolated per content item", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.nightshift = { instanceDir: "/srv/nightshift/NS-LAB-001" };
  const contentItems = [twoItems()[0]];
  const contentItemRuns = doneThrough("video-ai-01", "brief");
  const request = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns });
  assert.equal(request[0].type, "request_approval");
  assert.equal(request[0].contentItemId, "video-ai-01");

  instance.approvals = [{ stageId: "produce", contentItemId: "video-ai-01", effect: "paid-production", status: "approved" }];
  const approved = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns });
  assert.equal(approved[0].type, "create_workboard_card");
  assert.equal(approved[0].stageId, "produce");
  assert.match(approved[0].card.notes, /Delivery contract: write exactly this v1 shape/);
  assert.match(approved[0].card.notes, /\{"version":1/);
});

test("human review and publication remain per-video and idempotent", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  const contentItems = [twoItems()[1]];
  let contentItemRuns = doneThrough("video-scene-01", "produce");
  const review = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns })[0];
  assert.equal(review.type, "create_review_card");
  assert.equal(review.stageId, "review");

  contentItemRuns = doneThrough("video-scene-01", "review");
  const publicationApproval = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns })[0];
  assert.equal(publicationApproval.type, "request_approval");
  instance.approvals = [{ stageId: "publish-feedback", contentItemId: "video-scene-01", effect: "external-publication", status: "approved" }];
  const publish = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns })[0];
  assert.match(publish.idempotencyKey, /video-scene-01:publish-feedback/);
});

test("refuses another release and requires an Agent binding", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.workflowSha256 = "different";
  assert.throws(() => planNextActions({ release, instance }), /pinned to a different workflow release/);
  const unbound = activeInstance(release);
  delete unbound.agentBindings;
  assert.throws(() => planNextActions({ release, instance: unbound }), /Missing agent binding/);
});

function activeInstance(release) {
  return {
    id: "NS-LAB-001",
    name: "VLab 星擎试验",
    status: "active",
    workflowSha256: release.metadata.workflowSha256,
    agentBindings: { "content-operator": "main" },
    inputs: { customerId: "fixture-customer", briefUrl: "https://example.invalid/brief" },
  };
}

function twoItems() {
  return [
    { id: "video-ai-01", title: "AI 产品视觉", route: "AI_GENERATE", status: "planned" },
    { id: "video-scene-01", title: "Scene 实拍剪辑", route: "SCENE_EDIT", status: "planned" },
  ];
}

function doneThrough(contentItemId, lastStage) {
  const stages = ["route", "materials", "brief", "produce", "review"];
  return stages.slice(0, stages.indexOf(lastStage) + 1).map((stageId) => ({ contentItemId, stageId, status: "done" }));
}
