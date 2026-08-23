import assert from "node:assert/strict";
import test from "node:test";
import { compileWorkflow, loadWorkflow, NightShiftStore } from "../src/index.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");

test("persists immutable releases, instances, stage runs, approvals, and audit events", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(fixture, "utf8"));
  const release = compileWorkflow(await loadWorkflow(fixture));
  const store = new NightShiftStore();
  store.saveRelease(release, source, new Date("2026-08-22T00:00:00Z"));
  store.createInstance({
    id: "NS-STORE-1",
    name: "Store test",
    workflowSha256: release.metadata.workflowSha256,
    agentBindings: { "content-operator": "main" },
    inputs: { targetCount: 1 },
  });
  store.upsertStageRun({
    instanceId: "NS-STORE-1",
    stageId: "plan",
    attempt: 1,
    cardId: "card-1",
    status: "ready",
  });
  store.replaceContentItems("NS-STORE-1", [
    { id: "video-ai-01", title: "AI video", route: "AI_GENERATE" },
    { id: "video-scene-01", title: "Scene video", route: "SCENE_EDIT" },
  ]);
  store.upsertContentItemRun({
    instanceId: "NS-STORE-1",
    contentItemId: "video-ai-01",
    stageId: "route",
    status: "done",
  });
  store.replaceContentItems("NS-STORE-1", [
    { id: "video-ai-01", title: "AI video", route: "AI_GENERATE", status: "routed" },
    { id: "video-scene-01", title: "Scene video", route: "SCENE_EDIT", status: "routed" },
  ]);
  store.recordApproval({
    instanceId: "NS-STORE-1",
    stageId: "produce",
    effect: "paid-production",
    status: "approved",
    actor: "tianyi",
    bindings: { publicationTarget: { tiktokHandle: "@fixture" } },
    bindingHash: "binding-sha",
  });

  assert.equal(store.listReleases().length, 1);
  assert.equal(store.getInstance("NS-STORE-1").approvals.length, 1);
  assert.equal(store.getInstance("NS-STORE-1").approvals[0].bindingHash, "binding-sha");
  assert.equal(store.getInstance("NS-STORE-1").approvals[0].bindings.publicationTarget.tiktokHandle, "@fixture");
  assert.equal(store.listStageRuns("NS-STORE-1")[0].cardId, "card-1");
  assert.equal(store.listContentItems("NS-STORE-1").length, 2);
  assert.equal(store.listContentItems("NS-STORE-1")[0].status, "routed");
  assert.equal(store.listContentItemRuns("NS-STORE-1")[0].contentItemId, "video-ai-01");
  assert.deepEqual(
    store.listEvents("NS-STORE-1").map((event) => event.type),
    ["approval.recorded", "content-items.replaced", "content-items.replaced", "instance.created"],
  );
  store.close();
});

test("one workflow release owns many isolated customer instances", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(fixture, "utf8"));
  const release = compileWorkflow(await loadWorkflow(fixture));
  const store = new NightShiftStore();
  store.saveRelease(release, source);
  for (const [id, customer] of [["NS-CUSTOMER-A", "customer-a"], ["NS-CUSTOMER-B", "customer-b"]]) {
    store.createInstance({ id, workflowSha256: release.metadata.workflowSha256, inputs: { customerId: customer } });
    store.replaceContentItems(id, [{ id: "video-1", title: `${customer} video`, route: "SCENE_EDIT" }]);
  }
  assert.equal(store.listInstances().length, 2);
  assert.equal(store.listContentItems("NS-CUSTOMER-A")[0].title, "customer-a video");
  assert.equal(store.listContentItems("NS-CUSTOMER-B")[0].title, "customer-b video");
  store.close();
});

test("archiving a project keeps it recoverable and records an audit event", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(fixture, "utf8"));
  const release = compileWorkflow(await loadWorkflow(fixture));
  const store = new NightShiftStore();
  store.saveRelease(release, source);
  store.createInstance({
    id: "NS-ARCHIVE-1",
    name: "Archive test",
    workflowSha256: release.metadata.workflowSha256,
    status: "paused",
  });

  const archived = store.archiveInstance("NS-ARCHIVE-1", new Date("2026-08-23T12:00:00Z"));

  assert.equal(archived.status, "archived");
  assert.equal(store.listEvents("NS-ARCHIVE-1")[0].type, "instance.archived");
  assert.equal(store.listEvents("NS-ARCHIVE-1")[0].payload.previousStatus, "paused");
  store.close();
});
