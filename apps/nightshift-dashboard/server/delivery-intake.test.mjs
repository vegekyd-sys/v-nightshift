import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DeliveryIntakeService, INTAKE_WORKFLOW_ID, assertConfirmationRequestOrigin, intakeProjectId } from "./delivery-intake.mjs";
import { canonicalJson } from "../delivery/review.js";

function fixture(count = 7, overrides = {}) {
  const sourceId = "F-TEST-01";
  const manifestUrl = "https://cdn.makaron.app/nightshift/F-TEST-01/manifest.json";
  const manifest = { version: 1, title: "F测试", batchId: sourceId, review: { enabled: true, sourceProjectId: sourceId }, items: Array.from({ length: count }, (_, i) => ({ id: `v${i + 1}`, title: `视频${i + 1}`, url: `https://cdn.makaron.app/${i + 1}.mp4` })) };
  const data = {
    source: { id: sourceId, status: "done", workflowSha256: "source-sha", agentBindings: { "content-operator": "test-agent" }, collaboration: { sourceChatId: "oc_test" }, inputs: { enterpriseName: "测试企业", planningDocUrl: "https://tenant.feishu.cn/docx/test", targetCount: 7, testScope: { accountRecordId: "account-1", productionCount: 7, publishCount: 5, reserveCount: 2, workdays: 5 }, publicationTarget: { accountRecordId: "account-1", geelarkDeviceId: "device-1", tiktokHandle: "test-account", market: "巴西", language: "葡萄牙语", timezone: "America/Sao_Paulo" } } },
    sourceRelease: { metadata: { id: "xingqing-night-f" } }, page: { published: true, manifest: manifestUrl }, manifest, contentItems: manifest.items,
  };
  data.source.inputs.targetCount = count;
  data.source.inputs.testScope.productionCount = count;
  data.source.inputs.testScope.reserveCount = count - 5;
  const instances = new Map();
  let created = 0, enqueued = 0;
  const store = { getInstance: id => instances.get(id), listReleases: () => [{ workflowId: INTAKE_WORKFLOW_ID, workflowSha256: "intake-sha" }] };
  const dependencies = { store, loadSource: async () => structuredClone(data), createTask: async project => { created++; await new Promise(resolve => setImmediate(resolve)); instances.set(project.id, project); return project; }, enqueue: () => { enqueued++; }, projectLinks: id => ({ project: `https://nightshift.example/?project=${id}` }), ...overrides };
  const body = { manifestUrl, manifestHash: createHash("sha256").update(canonicalJson(manifest)).digest("hex"), rejectedIds: [] };
  return { data, body, instances, dependencies, service: new DeliveryIntakeService(dependencies), stats: () => ({ created, enqueued }) };
}

test("confirmation freezes seven items into one native project, authorizing intake but not publication", async () => {
  const f = fixture();
  assert.equal((await f.service.describe("F-TEST-01")).task, null);
  assert.deepEqual(f.stats(), { created: 0, enqueued: 0 });
  const result = await f.service.submit("F-TEST-01", f.body, "operator");
  assert.equal(result.task.id, intakeProjectId("F-TEST-01"));
  const task = f.instances.get(result.task.id);
  assert.equal(task.inputs.acceptedItems.length, 7);
  assert.equal(task.inputs.testScope.publishCount, 5);
  assert.deepEqual(task.inputs.authorizationScope, { paidProduction: false, externalPublication: false });
  assert.equal(task.inputs.reviewConfirmation.confirmedBy, "operator");
});

test("twenty videos with two rejected admit exactly eighteen and keep rejected ids visible", async () => {
  const f = fixture(20);
  const result = await f.service.submit("F-TEST-01", { ...f.body, rejectedIds: ["v2", "v7"] }, "operator");
  assert.equal(result.task.acceptedIds.length, 18);
  assert.deepEqual(result.task.rejectedIds, ["v2", "v7"]);
  assert.ok(!result.task.acceptedIds.includes("v2"));
});

test("concurrent clicks and a server restart reuse the same durable native project", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 10 }, () => f.service.submit("F-TEST-01", f.body, "operator")));
  assert.equal(new Set(results.map(result => result.task.id)).size, 1);
  assert.deepEqual(f.stats(), { created: 1, enqueued: 1 });
  const restarted = new DeliveryIntakeService(f.dependencies);
  assert.equal((await restarted.describe("F-TEST-01")).task.acceptedIds.length, 7);
  await restarted.submit("F-TEST-01", f.body, "operator");
  assert.deepEqual(f.stats(), { created: 1, enqueued: 1 });
});

test("an existing confirmation cannot be changed by another tab or a stale manifest", async () => {
  const f = fixture();
  await f.service.submit("F-TEST-01", f.body, "operator");
  await assert.rejects(f.service.submit("F-TEST-01", { ...f.body, rejectedIds: ["v1"] }, "operator"), /已确认/);
  await assert.rejects(f.service.submit("F-TEST-01", { ...f.body, manifestHash: "stale" }, "operator"), /已更新/);
  assert.equal(f.stats().created, 1);
});

test("empty approval, unknown ids, duplicate ids and browser-supplied targets cannot create a task", async () => {
  for (const extra of [{ rejectedIds: ["v1", "v2", "v3", "v4", "v5", "v6", "v7"] }, { rejectedIds: ["unknown"] }, { rejectedIds: ["v1", "v1"] }, { accountRecordId: "other" }]) {
    const f = fixture();
    await assert.rejects(f.service.submit("F-TEST-01", { ...f.body, ...extra }, "operator"));
    assert.equal(f.stats().created, 0);
  }
});

test("D and E releases, unfinished projects, invalid account bindings and missing intake workflow are rejected", async () => {
  for (const change of [f => { f.data.sourceRelease.metadata.id = "xingqing-night-d"; }, f => { f.data.sourceRelease.metadata.id = "xingqing-night-e"; }, f => { f.data.source.status = "active"; }, f => { f.data.source.inputs.testScope.accountRecordId = "other"; }, f => { f.dependencies.store.listReleases = () => []; }]) {
    const f = fixture(); change(f);
    await assert.rejects(f.service.submit("F-TEST-01", f.body, "operator"));
    assert.equal(f.stats().created, 0);
  }
});

test("a saved active task survives enqueue failure without re-creating or re-authorizing it", async () => {
  const run = fixture(7, { enqueue: () => { throw new Error("scheduler unavailable"); } });
  await assert.rejects(run.service.submit("F-TEST-01", run.body, "operator"), /scheduler unavailable/);
  const result = await new DeliveryIntakeService(run.dependencies).submit("F-TEST-01", run.body, "operator");
  assert.equal(result.reused, true);
  assert.equal(result.task.status, "active");
  assert.equal(run.stats().created, 1);
});

test("done without a matching receipt cannot be displayed as successful intake", async () => {
  const f = fixture();
  const first = await f.service.submit("F-TEST-01", f.body, "operator");
  f.instances.get(first.task.id).status = "done";
  await assert.rejects(f.service.describe("F-TEST-01"), /凭证不完整/);
});

test("confirmation origin and JSON content-type are checked before mutation", () => {
  const request = { headers: { origin: "https://nightshift.example", host: "nightshift.example", "content-type": "application/json", "sec-fetch-site": "same-origin" }, socket: { remoteAddress: "10.0.0.1" } };
  assert.doesNotThrow(() => assertConfirmationRequestOrigin(request));
  assert.throws(() => assertConfirmationRequestOrigin({ ...request, headers: { ...request.headers, origin: "https://other.example" } }), /原交付页/);
  assert.throws(() => assertConfirmationRequestOrigin({ ...request, headers: { ...request.headers, "content-type": "text/plain" } }), /JSON/);
});


test("confirmation survives an actual SQLite close/reopen and validates against the published native workflow", async t => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { NightShiftStore } = await import("../../../packages/nightshift-core/src/store.mjs");
  const { NightShiftRuntime } = await import("../../../packages/nightshift-core/src/runtime.mjs");
  const { validateProjectRequest } = await import("../../../packages/nightshift-core/src/project.mjs");
  const { planNextActions } = await import("../../../packages/nightshift-core/src/orchestrator.mjs");
  const dir = await mkdtemp(join(tmpdir(), "f-intake-sqlite-"));
  let store = new NightShiftStore(join(dir, "test.sqlite"));
  t.after(() => store.close());
  let runtime = new NightShiftRuntime({ store, workboard: {} });
  const source = await readFile(new URL("../../../examples/workflows/xingqing-buffer-intake-f.workflow.md", import.meta.url), "utf8");
  const release = runtime.publish(source).manifest;
  const f = fixture();
  f.data.instanceDir = join(dir, "F-TEST-01");
  f.data.source.inputs.testScope.serviceRecordId = "service-synthetic";
  f.data.source.inputs.publicationTarget.geelarkDeviceId = "123456789012345678";
  let starts = 0;
  const deps = { ...f.dependencies, now: () => new Date("2026-10-13T12:00:00Z"), store,
    createTask: async project => { validateProjectRequest(release, project); starts++; return runtime.startInstance(project); } };
  const a = await new DeliveryIntakeService(deps).submit("F-TEST-01", f.body, "test-operator");
  const project = store.getInstance(a.task.id);
  const actions = planNextActions({ release, instance: project });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "create_workboard_card");
  assert.equal(actions[0].stageId, "buffer-intake");
  assert.ok(actions[0].card.notes.includes("buffer-intake"));
  assert.equal(project.inputs.testScope.periodStartLocalDate, "2026-10-14");
  store.close();
  store = new NightShiftStore(join(dir, "test.sqlite"));
  runtime = new NightShiftRuntime({ store, workboard: {} });
  const restarted = new DeliveryIntakeService({ ...deps, store });
  const b = await restarted.submit("F-TEST-01", f.body, "test-operator");
  assert.equal(b.task.id, a.task.id);
  assert.equal(starts, 1);
  assert.equal(store.listInstances().length, 1);
  assert.equal(b.task.acceptedIds.length, 7);
  assert.equal(store.listEvents(a.task.id).filter(e => e.type === "instance.created").length, 1);
});


test("intake initialization cannot overwrite winning inputs and safely recovers a failed snapshot", async t => {
  const { readFile } = await import("node:fs/promises");
  const { NightShiftStore } = await import("../../../packages/nightshift-core/src/store.mjs");
  const { NightShiftRuntime } = await import("../../../packages/nightshift-core/src/runtime.mjs");
  const { createIntakeTaskInitializer } = await import("./intake-task.mjs");
  const store = new NightShiftStore(); t.after(() => store.close());
  const runtime = new NightShiftRuntime({store,workboard:{}});
  const release = runtime.publish(await readFile(new URL("../../../examples/workflows/xingqing-buffer-intake-f.workflow.md", import.meta.url),"utf8"));
  const project = {id:"BI-INIT-TEST",workflowSha256:release.workflowSha256,inputs:{acceptedItems:[{id:"v1"}],reviewConfirmation:{selectionHash:"first"}}};
  let calls=0, snapshot;
  const init = createIntakeTaskInitializer({store,runtime,prepare:p=>p,writeSnapshot:async task=>{calls++;if(calls===1)throw new Error("disk temporary failure");snapshot=structuredClone(task.inputs);}});
  await assert.rejects(init.create(project),/disk temporary failure/);
  assert.equal(store.getInstance(project.id).status,"paused");
  await assert.rejects(init.create({...project,inputs:{acceptedItems:[{id:"intruder"}]}}),/UNIQUE/);
  assert.equal(calls,1);
  const resumed = await init.resume(store.getInstance(project.id));
  assert.equal(resumed.status,"active");assert.equal(snapshot.acceptedItems[0].id,"v1");
  store.updateInstanceStatus(project.id,"paused");
  assert.equal((await init.resume(store.getInstance(project.id))).status,"paused");
  assert.equal(calls,2);
});

test("native Agent briefing and input snapshots retain non-secret Base resource identifiers", async () => {
  const { redactSensitiveInputs } = await import("../../../packages/nightshift-core/src/orchestrator.mjs");
  const f = fixture(); const r = await f.service.submit("F-TEST-01", f.body, "operator");
  const project = f.instances.get(r.task.id);
  assert.equal(redactSensitiveInputs(project.inputs).bufferTarget.baseId, "MOYqbvbt5amKPesStYEcRIrxnTb");
  assert.equal(redactSensitiveInputs({ credential: "fake-secret", token: "fake-secret" }).credential,"[REDACTED]");
});
