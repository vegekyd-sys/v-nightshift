import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compileWorkflow, loadWorkflow, planNextActions } from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");

// DL-0928-05 on V: 30 produce cards done, then the delivery card was refused
// by the board ("parents supports at most 20 entries").
test("a fan-in card keeps at most 20 parents and records the full count", async () => {
  const { WORKBOARD_PARENTS_LIMIT } = await import("../src/index.mjs");
  const compiled = compileWorkflow(await loadWorkflow(workflowPath));
  const fanIn = compiled.spec.stages.find((stage) => stage.scope !== "content-item" && (stage.needs ?? []).some((need) =>
    compiled.spec.stages.find((entry) => entry.id === need)?.scope === "content-item"));
  assert.ok(fanIn, "the fixture Workflow has a project stage that waits on every item");
  const instance = { id: "NS-P", status: "active", workflowSha256: compiled.metadata.workflowSha256, inputs: { deliveryMode: "download", authorizationScope: { paidProduction: true, externalPublication: true } }, agentBindings: { "content-operator": "main" } };
  const contentItems = Array.from({ length: 30 }, (_, index) => ({ id: `v-${index}`, title: `V${index}`, route: "SCENE_EDIT" }));
  const itemStages = compiled.spec.stages.filter((stage) => stage.scope === "content-item").map((stage) => stage.id);
  const runs = compiled.spec.stages.filter((stage) => (stage.scope ?? "project") === "project" && stage.id !== fanIn.id).map((stage) => ({ stageId: stage.id, status: "done", cardId: `card-${stage.id}` }));
  const contentItemRuns = contentItems.flatMap((item) => itemStages.map((stageId) => ({ contentItemId: item.id, stageId, status: "done", cardId: `card-${item.id}-${stageId}` })));
  const actions = planNextActions({ release: compiled, instance, runs, contentItems, contentItemRuns});
  const card = actions.find((action) => action.stageId === fanIn.id)?.card;
  assert.ok(card, `the ${fanIn.id} card is planned`);
  assert.equal(card.parents.length, WORKBOARD_PARENTS_LIMIT);
  assert.ok(card.automation.dependencyCount > WORKBOARD_PARENTS_LIMIT);
});
