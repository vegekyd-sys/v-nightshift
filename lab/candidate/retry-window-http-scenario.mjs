// All provider facts are synthetic. Native scheduledAt prevents Agent starts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handoffManifestExample } from "../../packages/nightshift-core/src/index.mjs";

export async function runHttpScenario({ baseUrl, workboard, id = "NS-RETRY-1029" }) {
  async function response(url, body) {
    const r = await fetch(`${baseUrl}/api${url}`, { headers: { "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json() };
  }
  async function api(url, body) {
    const r = await response(url, body);
    assert(r.status < 300, `${url}: ${JSON.stringify(r).slice(0, 800)}`);
    return r.data;
  }
  assert.equal((await api("/health")).workflowFeatures.retryWindows, 1);
  const flow = (name, stages, spec = {}) => JSON.stringify({ apiVersion: "nightshift.versa.ai/v1alpha1", kind: "Workflow", metadata: { id: name, version: "1.0.0", name }, spec: { ownerAgentRole: "operator", completion: { mode: "strict-v1" }, handoff: { version: 1 }, ...spec, stages } });
  const child = await api("/workflows/publish", { sourceYaml: flow("retry-window-child-fixture", [{ id: "create", title: "Synthetic supplier create", actor: "system", timeout: "1h", releaseAt: "2099-01-01T00:00:00Z", sideEffects: ["external-call"], outputs: ["receipt"], completeWhen: ["output.receipt.exists"], outputContracts: { receipt: { type: "json" } }, retry: { maxAttempts: 1, idempotencyKey: "{{instanceId}}:{{stageId}}:{{attempt}}" } }], { limits: { maxOperations: 1 }, outputs: { receipt: { stage: "create", output: "receipt" } } }) });
  const parent = await api("/workflows/publish", { sourceYaml: flow("retry-window-parent-fixture", [{ id: "environment", title: "Environment", actor: "workflow", timeout: "30s", outputs: ["receipt"], call: { workflow: child.workflowSha256, inputs: {}, maxOperations: 1 } }, { id: "deliver", title: "Synthetic downstream", actor: "human", needs: ["environment"], timeout: "1h" }], { limits: { maxOperations: 3, maxDuration: "30s" } }) });
  await api("/instances", { id, name: "Synthetic retry window acceptance", workflowSha256: parent.workflowSha256, inputs: {}, agentBindings: {}, status: "active", dispatch: false });
  const tick = () => api(`/instances/${id}/tick`, { dispatch: false });
  const root = () => api(`/instances/${id}`);
  await tick();
  const originalCreatedAt = (await root()).createdAt;
  const call = (await root()).calls[0];
  const childState = () => api(`/instances/${call.childId}`);
  const first = (await childState()).stageRuns[0].cardId;
  const failed = await api(`/cards/${first}/operations/reserve`, { requestHash: "a".repeat(64) });
  const failedCheckpoint = await api(`/cards/${first}/operations/checkpoint`, { status: "failed", result: { terminal: true, evidence: "synthetic-45006", code: 45006, success: 0, fail: 1 } });
  await workboard.moveCard(first, "done"); await tick();
  const decision = (await api(`/decisions?instanceId=${id}`)).decisions.find(entry => entry.cardId === first);
  assert(decision); assert.equal(decision.executionInstanceId, call.childId);
  const before = Date.now();
  await api(`/decisions/${decision.id}`, { optionId: "continue", actor: "V", note: "correct synthetic request within existing authorization" });
  await tick();
  const retry = (await childState()).stageRuns.find(run => run.attempt === 2).cardId;
  assert(retry);
  const afterDecision = (await root()).calls[0];
  assert(afterDecision.deadline >= before + 30000);
  // Wait for a real expiry; no production clock or database manipulation.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, afterDecision.deadline - Date.now() + 50)));
  await tick();
  assert.equal((await root()).calls[0].reason, "duration-limit");
  const request = { requestHash: "b".repeat(64) };
  const expired = await response(`/cards/${retry}/operations/reserve`, request);
  assert.equal(expired.status, 409);
  assert.match(expired.data.error, /Project duration/);
  const retryAt = Date.now();
  await api(`/cards/${retry}/retry`, { actor: "V", note: "retry same attempt after time elapsed" });
  const renewed = (await root()).calls[0];
  assert.equal(renewed.id, call.id); assert.equal(renewed.childId, call.childId);
  assert(renewed.deadline >= retryAt + 30000);
  const duplicate = await api(`/cards/${retry}/retry`, { actor: "V" });
  assert.equal(duplicate.alreadyResumed, true);
  assert.equal((await root()).calls[0].deadline, renewed.deadline);
  // No authorize-time-recovery or authorize-recovery request: ordinary retry
  // establishes the slot, reserve binds it atomically to this card and hash.
  assert.equal((await response(`/calls/${call.id}/authorize-time-recovery`, {})).status, 404);
  const reservations = await Promise.all([api(`/cards/${retry}/operations/reserve`, request), api(`/cards/${retry}/operations/reserve`, request)]);
  assert.equal(reservations[0].idempotencyKey, reservations[1].idempotencyKey);
  assert.notEqual(reservations[0].idempotencyKey, failed.idempotencyKey);
  assert((await response(`/cards/${retry}/operations/reserve`, { requestHash: "c".repeat(64) })).status >= 400);
  await api(`/cards/${first}/operations/checkpoint`, { status: "failed" });
  const original = await api(`/cards/${first}/operations/reserve`, { requestHash: "a".repeat(64) });
  assert.equal(original.status, "failed"); assert.deepEqual(original.result, failedCheckpoint.result);
  await api(`/cards/${retry}/operations/checkpoint`, { status: "succeeded", externalTaskId: "synthetic-phone", result: { terminal: true, evidence: "synthetic-success" } });
  const state = await childState();
  const dir = state.inputs.nightshift.instanceDir;
  fs.mkdirSync(path.join(dir, "handoffs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "create.json"), JSON.stringify({ resource: "synthetic-phone" }));
  const handoff = handoffManifestExample({ instanceId: call.childId, release: child.manifest, stageId: "create" });
  handoff.outputs = [{ name: "receipt", sourceStage: "create", artifact: "create.json", summary: "synthetic fixture only" }];
  fs.writeFileSync(path.join(dir, "handoffs/create.json"), JSON.stringify(handoff));
  await workboard.moveCard(retry, "done"); await tick(); await tick();
  const result = await root();
  assert.equal(result.createdAt, originalCreatedAt);
  assert.equal(result.calls[0].state, "succeeded");
  assert.equal(result.calls[0].totalOperations, 2);
  assert.equal(result.calls[0].baseMaxOperations, 1);
  assert.equal(result.stageRuns.filter(run => run.stageId === "deliver").length, 1);
  for (const cardId of [first, retry, ...result.stageRuns.map(run => run.cardId)]) {
    const { card } = await api(`/cards/${cardId}`);
    assert(!card.sessionKey && !card.runId && !card.metadata?.attempts?.length);
  }
  await api(`/instances/${id}/pause`, {});
  await api(`/instances/${id}/archive`, { actor: "V", reason: "zero-egress retry window acceptance complete" });
  return { ok: true, projectId: id, checks: { rootListsChildDecision: true, ordinaryContinueCreatesAttempt: true, realExpiryBlocksNewOperations: true,
    ordinaryRetryRenewsWindow: true, expiredRootClockAlsoRenews: true, originalCreationTimePreserved: true, duplicateRetryDoesNotMoveDeadline: true, noTimeAuthorizationEndpoint: true,
    retryAutomaticallyRestoresAttemptSlot: true, duplicateReserveIsIdempotent: true, hashBindingPreserved: true,
    failedReceiptAndCountPreserved: true, sameCallChildAndRound: true, downstreamExactlyOnce: true, noAgentOrSupplierCalls: true } };
}
