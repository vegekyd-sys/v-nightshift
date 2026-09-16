import assert from "node:assert/strict";
import test from "node:test";
import { compileWorkflow, loadWorkflow, NightShiftStore } from "../src/index.mjs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");

test("migrates existing run tables to preserve structured failure details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nightshift-store-migration-"));
  const databasePath = join(directory, "nightshift.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE stage_runs (
      instance_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      card_id TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, stage_id, attempt)
    );
    CREATE TABLE content_item_runs (
      instance_id TEXT NOT NULL,
      content_item_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      card_id TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, content_item_id, stage_id, attempt)
    );
  `);
  legacy.close();

  const store = new NightShiftStore(databasePath);
  const stageColumns = store.db.prepare("PRAGMA table_info(stage_runs)").all().map((column) => column.name);
  const itemColumns = store.db.prepare("PRAGMA table_info(content_item_runs)").all().map((column) => column.name);
  assert.ok(stageColumns.includes("failure_json"));
  assert.ok(itemColumns.includes("failure_json"));
  store.close();
  await rm(directory, { recursive: true, force: true });
});

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
  store.appendEvent({
    eventId: "known-event",
    instanceId: "NS-STORE-1",
    type: "test.known",
    payload: { value: 1 },
  });
  assert.deepEqual(store.getEvent("known-event")?.payload, { value: 1 });
  assert.equal(store.getEvent("missing-event"), null);
  store.close();
});

test("rejects an in-place mutation of a published workflow version", async () => {
  const original = compileWorkflow(await loadWorkflow(fixture));
  const store = new NightShiftStore();
  store.saveRelease(original, "original");
  const changedDocument = await loadWorkflow(fixture);
  changedDocument.spec.stages[0].title = "Mutated after publish";
  const changed = compileWorkflow(changedDocument);
  assert.notEqual(changed.metadata.workflowSha256, original.metadata.workflowSha256);
  assert.throws(() => store.saveRelease(changed, "changed"), /UNIQUE constraint failed/i);
  assert.equal(store.listReleases().length, 1);
  store.close();
});

test("external operation ledger deduplicates side effects and preserves terminal success", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const store = new NightShiftStore();
  store.saveRelease(release, await import("node:fs/promises").then(({ readFile }) => readFile(fixture, "utf8")));
  store.createInstance({ id: "NS-OP-1", workflowSha256: release.metadata.workflowSha256 });
  const operation = {
    idempotencyKey: "release:produce:NS-OP-1:video-1",
    instanceId: "NS-OP-1",
    contentItemId: "video-1",
    stageId: "produce",
    ownerCardId: "card-1",
    requestHash: "request-sha",
  };
  assert.equal(store.reserveExternalOperation(operation).reused, false);
  assert.equal(store.reserveExternalOperation(operation).reused, true);
  assert.throws(() => store.reserveExternalOperation({ ...operation, requestHash: "changed" }), /different request hash/i);
  store.checkpointExternalOperation(operation.idempotencyKey, {
    status: "executing",
    externalTaskId: "task-1",
    checkpoint: { state: "submitted" },
  });
  const completed = store.checkpointExternalOperation(operation.idempotencyKey, {
    status: "succeeded",
    result: { assetId: "asset-1" },
  });
  assert.equal(completed.externalTaskId, "task-1");
  assert.deepEqual(completed.result, { assetId: "asset-1" });
  assert.throws(() => store.checkpointExternalOperation(operation.idempotencyKey, { status: "executing" }), /immutable/i);
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

  const archived = store.archiveInstance("NS-ARCHIVE-1", new Date("2026-08-23T12:00:00Z"), {
    actor: "V",
    reason: "expired test",
    cardCounts: { ready: 3 },
  });

  assert.equal(archived.status, "archived");
  assert.equal(store.listEvents("NS-ARCHIVE-1")[0].type, "instance.archived");
  assert.equal(store.listEvents("NS-ARCHIVE-1")[0].payload.previousStatus, "paused");
  assert.equal(store.listEvents("NS-ARCHIVE-1")[0].payload.reason, "expired test");

  const restored = store.restoreInstance("NS-ARCHIVE-1", new Date("2026-08-24T12:00:00Z"), { actor: "V" });
  assert.equal(restored.status, "paused");
  assert.equal(store.listEvents("NS-ARCHIVE-1")[0].type, "instance.restored");
  store.close();
});

test("restoring an archived active project is fail-safe paused", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(fixture, "utf8"));
  const release = compileWorkflow(await loadWorkflow(fixture));
  const store = new NightShiftStore();
  store.saveRelease(release, source);
  store.createInstance({ id: "NS-ARCHIVE-ACTIVE", name: "Active test", workflowSha256: release.metadata.workflowSha256, status: "active" });
  store.archiveInstance("NS-ARCHIVE-ACTIVE");
  assert.equal(store.restoreInstance("NS-ARCHIVE-ACTIVE").status, "paused");
  store.close();
});
