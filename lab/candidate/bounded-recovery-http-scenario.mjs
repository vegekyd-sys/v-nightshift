// Formal API + native Workboard; all supplier facts are synthetic. Scheduled
// fixture cards cannot dispatch an Agent even if the event scheduler wakes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handoffManifestExample } from "../../packages/nightshift-core/src/index.mjs";

export async function runHttpScenario({ baseUrl, workboard, id = "NS-RECOVERY-1029", timeRecovery = false }) {
  async function response(url, body) {
    const r = await fetch(`${baseUrl}/api${url}`, { headers: { "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json() };
  }
  async function api(url, body) {
    const r = await response(url, body);
    assert(r.status < 300, `${url}: ${JSON.stringify(r).slice(0, 800)}`);
    return r.data;
  }
  const flow = (name, stages, spec = {}) => JSON.stringify({ apiVersion: "nightshift.versa.ai/v1alpha1", kind: "Workflow", metadata: { id: name, version: "1.0.0", name }, spec: { ownerAgentRole: "operator", completion: { mode: "strict-v1" }, handoff: { version: 1 }, ...spec, stages } });
  const child = await api("/workflows/publish", { sourceYaml: flow("recovery-child-fixture", [{ id: "create", title: "Synthetic supplier create", actor: "system", timeout: "1h", releaseAt: "2099-01-01T00:00:00Z", sideEffects: ["external-call"], outputs: ["receipt"], completeWhen: ["output.receipt.exists"], outputContracts: { receipt: { type: "json" } }, retry: { maxAttempts: 1, idempotencyKey: "{{instanceId}}:{{stageId}}:{{attempt}}" } }], { limits: { maxOperations: 1 }, outputs: { receipt: { stage: "create", output: "receipt" } } }) });
  const parent = await api("/workflows/publish", { sourceYaml: flow(timeRecovery ? "time-recovery-parent-fixture" : "recovery-parent-fixture", [{ id: "environment", title: "Environment", actor: "workflow", timeout: timeRecovery ? "30s" : "1h", outputs: ["receipt"], call: { workflow: child.workflowSha256, inputs: {}, maxOperations: 1 } }, { id: "deliver", title: "Synthetic downstream", actor: "human", needs: ["environment"], timeout: "1h" }], { limits: { maxOperations: 3, ...(timeRecovery ? { maxDuration: "5m" } : {}) } }) });
  await api("/instances", { id, name: "Synthetic bounded recovery acceptance", workflowSha256: parent.workflowSha256, inputs: {}, agentBindings: {}, status: "active", dispatch: false });
  const tick = () => api(`/instances/${id}/tick`, { dispatch: false });
  const root = () => api(`/instances/${id}`);
  await tick();
  const call = (await root()).calls[0];
  const childState = () => api(`/instances/${call.childId}`);
  const first = (await childState()).stageRuns[0].cardId;
  const failed = await api(`/cards/${first}/operations/reserve`, { requestHash: "a".repeat(64) });
  const failedCheckpoint = await api(`/cards/${first}/operations/checkpoint`, { status: "failed", result: { terminal: true, evidence: "synthetic-45006-response", code: 45006, success: 0, fail: 1 } });
  // The default success-only completion validator must reject this card and
  // create a real child decision. No synthetic insertion into production DBs.
  await workboard.moveCard(first, "done");
  await tick();
  const decisions = (await api(`/decisions?instanceId=${id}`)).decisions;
  const decision = decisions.find(entry => entry.cardId === first);
  assert(decision, "root must expose the child's actual open decision");
  assert.equal(decision.executionInstanceId, call.childId);
  assert.equal(decision.rootInstanceId, id);
  assert.equal((await api(`/decisions?instanceId=${id}&includeDescendants=false`)).decisions.length, 0);
  const overview = await api("/overview?scope=all");
  assert(overview.needsYou.items.some(item => item.id === decision.id && item.instanceId === id && item.executionInstanceId === call.childId));
  const resumed = await api(`/decisions/${decision.id}`, { optionId: "continue", actor: "V", note: "synthetic request shape correction" });
  assert(!resumed.errors?.length);
  // The decision durably records the new revision; the existing scheduler
  // materializes its card on the next pass, not in the decision POST itself.
  await tick();
  const retry = (await childState()).stageRuns.find(run => run.attempt === 2).cardId;
  assert(retry, "scheduler must materialize the revision before card operations");
  const request = { failedOperationKey: failed.idempotencyKey, requestHash: "b".repeat(64), actor: "V", reason: "correct supplier request shape", authorization: "synthetic explicit recovery within existing budget", evidence: "synthetic-45006-response" };
  const limited = await response(`/cards/${retry}/operations/reserve`, { requestHash: request.requestHash });
  assert.equal(limited.status, 409, JSON.stringify(limited));
  const timeChecks = {};
  if (timeRecovery) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, call.deadline - Date.now() + 50)));
    await tick();
    assert.equal((await root()).calls[0].reason, "duration-limit");
    assert.equal((await response(`/cards/${call.cardId}/retry`, { actor: "V", note: "synthetic expired controller" })).status, 409);
    assert.equal((await response(`/cards/${retry}/operations/authorize-recovery`, request)).status, 409);
    const timeRequest = { expectedDeadline: call.deadline, deadline: call.deadline + 30000, actor: "V", reason: "synthetic delayed correction", authorization: "same bounded project authorization", evidence: "synthetic known terminal readback" };
    assert.equal((await response(`/calls/${call.id}/authorize-time-recovery`, { ...timeRequest, deadline: call.deadline + 31000 })).status, 409);
    const permits = await Promise.all([api(`/calls/${call.id}/authorize-time-recovery`, timeRequest), api(`/calls/${call.id}/authorize-time-recovery`, timeRequest)]);
    assert.equal(permits[0].id, permits[1].id);
    const state = await root();
    assert.equal(state.calls[0].id, call.id); assert.equal(state.calls[0].childId, call.childId);
    assert.equal(state.calls[0].deadline, timeRequest.deadline);
    assert.equal((await childState()).stageRuns.find(run => run.attempt === 2).cardId, retry);
    Object.assign(timeChecks, { expiredTimeBlocksOperationPermit: true, excessiveExtensionRejected: true, duplicateTimePermitIsIdempotent: true, sameCallChildCardAndRoundPreserved: true });
  }
  const grants = await Promise.all([api(`/cards/${retry}/operations/authorize-recovery`, request), api(`/cards/${retry}/operations/authorize-recovery`, request)]);
  assert.equal(grants[0].id, grants[1].id);
  assert.equal(grants[0].additionalOperations, 1);
  // Re-reading the same failed outcome must not invalidate the permit just
  // because the ledger's bookkeeping timestamp advances.
  await api(`/cards/${first}/operations/checkpoint`, { status: "failed" });
  assert.equal((await response(`/cards/${retry}/operations/reserve`, { requestHash: "c".repeat(64) })).status, 409);
  const reservations = await Promise.all([api(`/cards/${retry}/operations/reserve`, { requestHash: request.requestHash }), api(`/cards/${retry}/operations/reserve`, { requestHash: request.requestHash })]);
  assert.equal(reservations[0].idempotencyKey, reservations[1].idempotencyKey);
  assert.notEqual(reservations[0].idempotencyKey, failed.idempotencyKey);
  await api(`/cards/${retry}/operations/checkpoint`, { status: "succeeded", externalTaskId: "synthetic-phone", result: { terminal: true, evidence: "synthetic-success-response" } });
  const state = await childState();
  const dir = state.inputs.nightshift.instanceDir;
  fs.mkdirSync(path.join(dir, "handoffs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "create.json"), JSON.stringify({ resource: "synthetic-phone" }));
  const handoff = handoffManifestExample({ instanceId: call.childId, release: child.manifest, stageId: "create" });
  handoff.outputs = [{ name: "receipt", sourceStage: "create", artifact: "create.json", summary: "synthetic fixture only" }];
  fs.writeFileSync(path.join(dir, "handoffs/create.json"), JSON.stringify(handoff));
  await workboard.moveCard(retry, "done"); await tick(); await tick();
  const result = await root();
  assert.equal(result.calls[0].state, "succeeded");
  assert.equal(result.calls[0].totalOperations, 2);
  assert.equal(result.calls[0].baseMaxOperations, 1);
  assert.equal(result.calls[0].recoveryOperations, 1);
  assert.equal(result.stageRuns.filter(run => run.stageId === "deliver").length, 1);
  assert.equal((await api(`/decisions?instanceId=${id}`)).decisions.some(entry => entry.id === decision.id), false);
  const original = await api(`/cards/${first}/operations/reserve`, { requestHash: "a".repeat(64) });
  assert.equal(original.status, "failed"); assert.deepEqual(original.result, failedCheckpoint.result);
  for (const cardId of [first, retry, ...result.stageRuns.map(run => run.cardId)]) {
    const { card } = await api(`/cards/${cardId}`);
    assert(!card.sessionKey && !card.runId && !card.metadata?.attempts?.length);
  }
  await api(`/instances/${id}/pause`, {});
  await api(`/instances/${id}/archive`, { actor: "V", reason: "zero-egress bounded recovery acceptance complete" });
  return { ok: true, projectId: id, checks: { ...timeChecks, rootListsChildDecision: true, officialDecisionCreatesSameStageAttempt: true, noSilentQuotaIncrease: true, explicitGrantIsIdempotent: true, correctedHashAndCardBound: true, duplicateReserveDoesNotChargeAgain: true, originalFailurePreserved: true, successUnblocksDownstreamOnce: true, noAgentOrSupplierCalls: true } };
}
