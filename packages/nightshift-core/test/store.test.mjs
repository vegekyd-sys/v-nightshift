import assert from "node:assert/strict";
import test from "node:test";
import { compileWorkflow, loadWorkflow, NightShiftStore } from "../src/index.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../../../examples/workflows/xingqing-content-delivery.v0.2.yaml");

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
  store.recordApproval({
    instanceId: "NS-STORE-1",
    stageId: "produce",
    effect: "paid-production",
    status: "approved",
    actor: "tianyi",
  });

  assert.equal(store.listReleases().length, 1);
  assert.equal(store.getInstance("NS-STORE-1").approvals.length, 1);
  assert.equal(store.listStageRuns("NS-STORE-1")[0].cardId, "card-1");
  assert.deepEqual(
    store.listEvents("NS-STORE-1").map((event) => event.type),
    ["approval.recorded", "instance.created"],
  );
  store.close();
});
