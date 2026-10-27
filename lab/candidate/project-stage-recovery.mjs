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
const workboard = new WorkboardGatewayAdapter({ board: "project-recovery-candidate", configPath, entry, gatewayUrl: `ws://127.0.0.1:${port}` });
const db = path.join(dataDir, "project-recovery.sqlite");
let store = new NightShiftStore(db);
const createRuntime = () => new NightShiftRuntime({ store, workboard, needsYou: new NeedsYouTracker({ store }) });
let runtime = createRuntime();
const id = "NS-PROJECT-RECOVERY";
const checks = {};
try {
  const deadline = Date.now() + 180_000;
  while (true) {
    assert(gateway.exitCode === null, `private Gateway exited (${gateway.exitCode}): ${startupError()}`);
    try { await workboard.connect(); break; } catch {
      if (Date.now() > deadline) throw new Error("private Gateway did not become ready");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  const source = `---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata: {id: project-recovery-test, version: 0.1.0, name: Project recovery}
spec: {ownerAgentRole: operator, concurrency: {perInstance: 1}}
---
${["purchase", "login", "writeback"].map((stage, i, stages) => `
## STAGE ${stage}｜${stage}
\`\`\`stage
actor: system
scope: project
${i ? `needs: [${stages[i - 1]}]` : ""}
outputs: [receipt]
completeWhen: [output.receipt.exists]
timeout: 10m
retry: {maxAttempts: 1, idempotencyKey: "\${instance.id}:project-recovery:${stage}"}
${stage === "login" ? "sideEffects: [paid-production]\napproval: {before: paid-production, scope: project}" : ""}
\`\`\`
`).join("\n")}`;
  const release = runtime.publish(source);
  runtime.startInstance({ id, workflowSha256: release.workflowSha256,
    inputs: { authorizationScope: { paidProduction: true } } });
  await runtime.tick(id, { dispatch: false });
  const purchase = store.listStageRuns(id).find(run => run.stageId === "purchase");
  await workboard.moveCard(purchase.cardId, "done");
  await runtime.tick(id, { dispatch: false });
  const login = store.listStageRuns(id).find(run => run.stageId === "login");
  let [oldCard] = await workboard.listCards({ cardIds: [login.cardId] });
  const instance = store.getInstance(id);
  const keysFor = (card, projectRun) => resolveNightShiftOperationKeys({ card, projectRun, release: release.manifest, instance });
  const oldKey = keysFor(oldCard, login).preferredIdempotencyKey;
  store.reserveExternalOperation({ idempotencyKey: oldKey, instanceId: id, stageId: "login", ownerCardId: oldCard.id, requestHash: "a".repeat(64) });
  store.checkpointExternalOperation(oldKey, { status: "failed", result: { reason: "unsupported optional parameter", successAmount: 0 } });
  const oldOperation = store.getExternalOperation(oldKey);
  assert.throws(() => store.reserveExternalOperation({ ...oldOperation, requestHash: "b".repeat(64) }), /different request hash/);
  checks.oldHashConflictReproduced = true;
  await workboard.moveCard(oldCard.id, "blocked");
  [oldCard] = await workboard.listCards({ cardIds: [oldCard.id] });
  const failure = { kind: "agent_error", automaticRetry: false, agentReport: "需要人做：请确认修正后继续\n原因：可选参数被拒绝" };
  store.upsertStageRun({ ...login, status: "blocked", failure });
  const request = runtime.needsYou.observe({ card: oldCard, instance, stage: release.manifest.spec.stages.find(s => s.id === "login"),
    stageId: "login", status: "blocked", failure, operation: oldOperation });
  assert.match(request.options[0].description, /可能再次付费/);
  await runtime.decide({ decisionId: request.id, optionId: "continue", actor: "candidate-test", note: "明确同意这一步新调用，省略可选参数" });
  // Reopen the actual SQLite file, not just a runtime object.
  store.close();
  store = new NightShiftStore(db);
  runtime = createRuntime();
  assert.equal((await runtime.decide({ decisionId: request.id, optionId: "continue", actor: "candidate-test" })).alreadyDecided, true);
  await runtime.tick(id, { dispatch: false });
  await runtime.tick(id, { dispatch: false });
  const runs = store.listStageRuns(id);
  const freshRun = runs.find(run => run.stageId === "login" && run.attempt === 2);
  const [fresh] = await workboard.listCards({ cardIds: [freshRun.cardId] });
  assert.notEqual(fresh.id, oldCard.id);
  assert.match(fresh.notes, /省略可选参数/);
  const keys = keysFor(fresh, freshRun);
  assert.notEqual(keys.preferredIdempotencyKey, oldKey);
  assert.equal(findNightShiftExternalOperation({ card: fresh, candidateIdempotencyKeys: keys.candidateIdempotencyKeys, operations: store.listExternalOperations(id) }), null);
  const operation = { idempotencyKey: keys.preferredIdempotencyKey, instanceId: id, stageId: "login", ownerCardId: fresh.id, requestHash: "b".repeat(64) };
  assert.equal(store.reserveExternalOperation(operation).reused, false);
  assert.equal(store.reserveExternalOperation(operation).reused, true);
  assert.deepEqual(store.getExternalOperation(oldKey), oldOperation);
  assert.equal(runs.filter(run => run.stageId === "purchase").length, 1);
  assert.equal(runs.find(run => run.stageId === "purchase").status, "done");
  assert.equal(runs.filter(run => run.stageId === "login").length, 2);
  assert.equal(store.listEvents(id).filter(event => event.type === "project-stage.redo.requested").length, 1);
  assert.equal((await workboard.listCards({ cardIds: [oldCard.id] }))[0].status, "blocked");
  checks.nativeCardRevisionAndCorrectedHash = true;
  checks.sqliteRestartAndRepeatedContinueIdempotent = true;
  checks.purchaseUntouchedAndFailedReceiptPreserved = true;
  // A different V session uses the ordinary HTTP CLI with only a card ID:
  // no human request, browser button, special chat or scheduler auto-retry.
  const vId = "NS-V-RESUME-CANDIDATE";
  runtime.startInstance({ id: vId, workflowSha256: release.workflowSha256,
    inputs: { authorizationScope: { paidProduction: true } } });
  await runtime.tick(vId, { dispatch: false });
  const vPurchase = store.listStageRuns(vId).find(run => run.stageId === "purchase");
  await workboard.moveCard(vPurchase.cardId, "done");
  await runtime.tick(vId, { dispatch: false });
  const vLogin = store.listStageRuns(vId).find(run => run.stageId === "login");
  const [vCard] = await workboard.listCards({ cardIds: [vLogin.cardId] });
  const vInstance = store.getInstance(vId);
  const vOldKey = resolveNightShiftOperationKeys({ card: vCard, projectRun: vLogin, release: release.manifest, instance: vInstance }).preferredIdempotencyKey;
  store.reserveExternalOperation({ idempotencyKey: vOldKey, instanceId: vId, stageId: "login", ownerCardId: vCard.id, requestHash: "c".repeat(64) });
  store.checkpointExternalOperation(vOldKey, { status: "failed", result: { reason: "unsupported optional parameter" } });
  await workboard.moveCard(vCard.id, "blocked");
  store.upsertStageRun({ ...vLogin, status: "blocked", failure });
  const api = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, `/api/cards/${vCard.id}/retry`);
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      response.end(JSON.stringify(await runtime.resume({ cardId: vCard.id, actor: body.actor,
        note: body.note, allowNewOperation: body.allowNewOperation === true })));
    } catch (error) {
      response.statusCode = error.statusCode ?? 500;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
  try {
    const cli = fileURLToPath(new URL("../../scripts/nightshiftctl.mjs", import.meta.url));
    const args = [cli, "cards", "retry", vCard.id, "--actor", "V", "--note", "按已有任务授权省略可选参数", "--allow-new-operation"];
    const env = { ...process.env, NIGHTSHIFT_URL: `http://127.0.0.1:${api.address().port}` };
    assert.equal(JSON.parse((await promisify(execFile)(process.execPath, args, { env })).stdout).how, "fresh");
    store.close();
    store = new NightShiftStore(db);
    runtime = createRuntime();
    assert.equal(JSON.parse((await promisify(execFile)(process.execPath, args, { env })).stdout).alreadyResumed, true);
    await runtime.tick(vId, { dispatch: false });
    const vNewRun = store.listStageRuns(vId).find(run => run.stageId === "login" && run.attempt === 2);
    const [vNewCard] = await workboard.listCards({ cardIds: [vNewRun.cardId] });
    const vNewKey = resolveNightShiftOperationKeys({ card: vNewCard, projectRun: vNewRun, release: release.manifest, instance: vInstance }).preferredIdempotencyKey;
    assert.notEqual(vNewKey, vOldKey);
    assert.equal(store.reserveExternalOperation({ idempotencyKey: vNewKey, instanceId: vId, stageId: "login", ownerCardId: vNewCard.id, requestHash: "d".repeat(64) }).reused, false);
    assert.equal(store.listDecisionRequests({ instanceId: vId }).length, 0);
    assert.equal(store.listEvents(vId).filter(event => event.type === "stage.resume.requested").length, 1);
    assert.equal(store.listStageRuns(vId).filter(run => run.stageId === "purchase").length, 1);
    assert.equal((await workboard.listCards({ cardIds: [vPurchase.cardId] }))[0].status, "done");
    store.checkpointExternalOperation(vNewKey, { status: "succeeded", externalTaskId: "candidate-only-receipt", result: { synthetic: true } });
    const settled = store.getExternalOperation(vNewKey);
    runtime.updateInstanceInputs(vId, { correctedOptionalParameter: true });
    await workboard.moveCard(vNewCard.id, "blocked");
    store.upsertStageRun({ ...vNewRun, status: "blocked", failure });
    assert.equal((await runtime.resume({ cardId: vNewCard.id, actor: "V" })).how, "same");
    const [reopened] = await workboard.listCards({ cardIds: [vNewCard.id] });
    assert.equal(reopened.metadata.automation.idempotencyKey, vNewKey);
    const changedKeys = resolveNightShiftOperationKeys({ card: reopened, projectRun: vNewRun, release: release.manifest, instance: store.getInstance(vId) });
    assert.equal(findNightShiftExternalOperation({ card: reopened, candidateIdempotencyKeys: changedKeys.candidateIdempotencyKeys,
      operations: store.listExternalOperations(vId) }).idempotencyKey, vNewKey);
    assert.equal(store.reserveExternalOperation({ ...settled, requestHash: "d".repeat(64) }).reused, true);
    assert.deepEqual(store.getExternalOperation(vNewKey), settled);
    checks.settledResultAndKeySurviveInputEdit = true;
    checks.vCliResumesWithoutHumanDecision = true;
    checks.vCliReplayAfterDbReopenDoesNotDuplicate = true;
  } finally {
    await new Promise(resolve => api.close(resolve));
  }
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
}
