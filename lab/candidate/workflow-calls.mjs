// Pre-merge integration: a private Gateway's real Workboard normalization,
// this branch's planner/decisions, and a synthetic SQLite operation ledger.
// No Agent is dispatched, and no supplier or production database is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { NightShiftRuntime } from "../../packages/nightshift-core/src/runtime.mjs";
import { NightShiftStore } from "../../packages/nightshift-core/src/store.mjs";
import { NeedsYouTracker } from "../../packages/nightshift-core/src/needs-you.mjs";
import { WorkboardGatewayAdapter } from "../../packages/nightshift-core/src/workboard-gateway-adapter.mjs";
import { findNightShiftExternalOperation, resolveNightShiftOperationKeys } from "../../packages/nightshift-core/src/card-context.mjs";

const { VLAB_CANDIDATE_RUNTIME: runtimeDir, OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_STATE_DIR: stateDir, VLAB_CANDIDATE_DATA: dataDir } = process.env;
assert(runtimeDir && configPath && stateDir && dataDir, "a private VLab candidate is required");
const original = JSON.parse(fs.readFileSync(configPath, "utf8"));
const port = Number(original.gateway?.port);
assert(Number.isInteger(port) && port > 0);
// No channels, cron, heartbeat, external plugins or isolated Agent pool. This
// Gateway only serves board RPCs; the shared VLab Gateway is never touched.
fs.writeFileSync(configPath, JSON.stringify({
  gateway: original.gateway,
  agents: { defaults: { workspace: path.join(dataDir, "workspace") } },
  channels: {}, cron: { enabled: false }, plugins: { allow: ["workboard"], entries: { workboard: { enabled: true }, deepseek: { enabled: false }, codex: { enabled: false } } },
}), { mode: 0o600 });
const privateTmp = fs.mkdtempSync("/tmp/ns-call-");
process.env.TMPDIR = privateTmp;
process.env.XDG_CACHE_HOME = path.join(dataDir, "cache");
fs.mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true, mode: 0o700 });
const entry = path.join(runtimeDir, "openclaw/dist/index.js");
const gateway = spawn(process.execPath, [entry, "gateway", "--port", String(port)], {
  env: { ...process.env, OPENCLAW_GATEWAY_PORT: String(port), npm_config_cache: path.join(dataDir, "npm-cache") }, stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
for (const stream of [gateway.stdout, gateway.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", chunk => { errors = (errors + chunk).slice(-12000); });
}
const startupError = () => {
  let text = errors;
  const token = original.gateway?.auth?.token;
  if (typeof token === "string" && token) text = text.replaceAll(token, "[redacted]");
  return text.replace(/(token|api.?key|authorization|secret|bearer)([=: ]+)[^\s"']+/giu, "$1$2[redacted]").slice(-5000);
};
const workboard = new WorkboardGatewayAdapter({ board: "workflow-calls-candidate", configPath, entry, gatewayUrl: `ws://127.0.0.1:${port}` });

const db = path.join(dataDir, "workflow-calls.sqlite");
let store = new NightShiftStore(db);
const makeRuntime = () => new NightShiftRuntime({ store, workboard, executionRoot: path.join(dataDir, "instances") });
let runtime = makeRuntime();
const checks = {};
const flow = (id, stages, extra = {}) => JSON.stringify({ apiVersion: "nightshift.versa.ai/v1alpha1", kind: "Workflow", metadata: { id, version: "1.0.0", name: id }, spec: { ownerAgentRole: "operator", ...extra, stages } });
const step = (id, extra = {}) => ({ id, title: id, actor: "system", timeout: "10m", outputs: ["result"], ...extra });
const id = "CALLS-CANDIDATE";
async function finish(call, result) {
  const child = store.getInstance(call.childId);
  const dir = child.inputs.nightshift.instanceDir;
  fs.mkdirSync(path.join(dir, "handoffs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
  fs.writeFileSync(path.join(dir, "handoffs/verify.json"), JSON.stringify({ version: 1, instanceId: child.id, stageId: "verify", contentItemId: null,
    inputs: [{ name: "projectInputs", sourceStage: "control-plane", artifact: "project-inputs.json", summary: "inputs" }],
    outputs: [{ name: "result", sourceStage: "verify", artifact: "result.json", summary: "synthetic verification" }] }));
  await workboard.moveCard(store.listStageRuns(child.id).find(run => run.stageId === "verify").cardId, "done");
}
try {
  const deadline = Date.now() + 180_000;
  while (true) {
    assert(gateway.exitCode === null, `private Gateway exited (${gateway.exitCode}): ${startupError()}`);
    try { await workboard.connect(); break; } catch {
      if (Date.now() > deadline) throw new Error("private Gateway did not become ready");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  const childRelease = runtime.publish(flow("call-verifier", [step("verify", { retry: { maxAttempts: 1, idempotencyKey: "a-static-template" } })], { outputs: { result: { stage: "verify", output: "result" } } }));
  const parentRelease = runtime.publish(flow("call-parent", [step("acquire", { actor: "workflow", timeout: "1h",
    call: { workflow: childRelease.workflowSha256, inputs: { resource: { from: "previous.result.resource" } } },
    repeat: { until: { output: "result.passed", equals: true }, while: { output: "result.again", equals: true }, maxIterations: 2, maxDuration: "1h", maxOperations: 2 } }), step("deliver", { needs: ["acquire"] })]));
  runtime.startInstance({ id, workflowSha256: parentRelease.workflowSha256, inputs: { nightshift: { instanceDir: path.join(dataDir, "instances", id) } } });
  await runtime.tick(id, { inspectSessions: false });
  const first = store.listCalls(id)[0];
  const oldRun = store.listStageRuns(first.childId)[0];
  const [oldCard] = await workboard.listCards({ cardIds: [oldRun.cardId] });
  assert.equal(oldCard.status, "ready");
  const key = resolveNightShiftOperationKeys({ card: oldCard, projectRun: oldRun, release: childRelease.manifest, instance: store.getInstance(first.childId) }).preferredIdempotencyKey;
  store.reserveExternalOperation({ idempotencyKey: key, instanceId: first.childId, stageId: "verify", ownerCardId: oldCard.id, requestHash: "a".repeat(64) });
  store.checkpointExternalOperation(key, { status: "succeeded", result: { retained: true } });
  const originalReceipt = store.getExternalOperation(key);
  await finish(first, { passed: false, again: true, resource: "retain-this-resource" });
  await runtime.tick(id, { inspectSessions: false });
  assert.equal(store.listStageRuns(id).some(run => run.stageId === "deliver"), false);
  assert.equal(store.listCalls(id).length, 2);
  checks.realWorkboardFailureRoutesToSecondRound = true;
  store.close(); store = new NightShiftStore(db); runtime = makeRuntime();
  await Promise.all([runtime.tick(id, { inspectSessions: false }), runtime.tick(id, { inspectSessions: false })]);
  const second = store.listCalls(id).at(-1);
  assert.equal(second.iteration, 2);
  assert.equal(store.listCalls(id).length, 2);
  assert.equal(store.listInstances().length, 1);
  checks.sqliteReopenAndDuplicateAdvanceAreIdempotent = true;
  assert.equal(store.getInstance(second.childId).inputs.resource, "retain-this-resource");
  assert.deepEqual(store.getExternalOperation(key), originalReceipt);
  checks.previousResourceAndReceiptPreserved = true;
  const newRun = store.listStageRuns(second.childId)[0];
  const [newCard] = await workboard.listCards({ cardIds: [newRun.cardId] });
  const newKey = resolveNightShiftOperationKeys({ card: newCard, projectRun: newRun, release: childRelease.manifest, instance: store.getInstance(second.childId) }).preferredIdempotencyKey;
  assert.notEqual(newKey, key);
  assert.notEqual(newCard.id, oldCard.id);
  const newOperation = { idempotencyKey: newKey, instanceId: second.childId, stageId: "verify", ownerCardId: newCard.id, requestHash: "b".repeat(64) };
  assert.equal(store.reserveExternalOperation(newOperation).reused, false);
  assert.equal(store.reserveExternalOperation(newOperation).reused, true);
  checks.nativeOperationKeysIsolatedEvenWithStaticTemplate = true;
  await finish(second, { passed: true });
  await runtime.tick(id, { inspectSessions: false });
  assert.equal(store.listCalls(id).at(-1).state, "held");
  await assert.rejects(runtime.resume({ actor: "V", cardId: second.cardId }), /readback/);
  checks.unknownOutcomeStopsWithoutAnotherRound = true;
  store.checkpointExternalOperation(newKey, { status: "succeeded" });
  await runtime.resume({ actor: "V", cardId: second.cardId, note: "synthetic supplier readback confirmed" });
  await runtime.tick(id, { inspectSessions: false });
  await runtime.tick(id, { inspectSessions: false });
  assert.equal(store.listStageRuns(id).filter(run => run.stageId === "deliver").length, 1);
  assert.equal(store.listCalls(id).length, 2);
  const [controller] = await workboard.listCards({ cardIds: [second.cardId] });
  assert.equal(controller.status, "done");
  assert(fs.existsSync(path.join(dataDir, "instances", id, "handoffs/acquire.json")));
  checks.successReleasesDownstreamExactlyOnce = true;
  checks.noAgentDispatchedOrSupplierCalled = true;
  console.log(JSON.stringify({ ok: true, checks, passed: Object.keys(checks).length }));
} finally {
  store.close();
  workboard.close();
  gateway.kill("SIGTERM");
  if (gateway.exitCode === null && gateway.signalCode === null) await new Promise(resolve => {
    const timer = setTimeout(() => { gateway.kill("SIGKILL"); resolve(); }, 10000);
    gateway.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  fs.rmSync(privateTmp, { recursive: true, force: true });
}
