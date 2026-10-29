import { createHash } from "node:crypto";
import { operationResultHash } from "./external-operation-completion.mjs";
import { durationMs } from "./workflow-call-contract.mjs";

export const RECOVERY_EVENT = "external-operation.recovery-authorized";
const reject = message => { throw Object.assign(new Error(message), { statusCode: 409 }); };
const sameItem = (a, b) => (a ?? null) === (b ?? null);

// Limits are additive constraints, not separate budgets. A nested Workflow's
// own declared limit must not disappear just because it is called by a parent.
export function operationLimitScopes(store, instanceId, now = new Date()) {
  const ancestors = store.callAncestors(instanceId);
  const rootId = store.rootInstanceId(instanceId);
  const operations = ids => [...new Set(ids)].flatMap(id => store.listExternalOperations(id));
  const scopes = [];
  for (const id of [instanceId, ...ancestors.map(call => call.parentId)]) {
    const instance = store.getInstance(id);
    const limits = store.getRelease(instance?.workflowSha256)?.manifest.spec.limits;
    if (limits?.maxDuration && now.getTime() >= Date.parse(instance.createdAt) + durationMs(limits.maxDuration)) reject("Project duration limit reached");
    if (limits?.maxOperations !== undefined) scopes.push({ id: `instance:${id}`, root: id === rootId, maxOperations: limits.maxOperations, operations: operations(store.executionIds(id)) });
  }
  for (const call of ancestors) scopes.push({
    id: `call:${call.parentId}:${call.cardId}`, root: false, maxOperations: call.maxOperations,
    operations: operations(store.listCalls(call.parentId).filter(entry => entry.cardId === call.cardId).flatMap(entry => store.executionIds(entry.childId))),
  });
  return scopes;
}

export function recoveryBindingMatches(store, grant, operation) {
  if (grant.ownerCardId !== operation.ownerCardId || grant.instanceId !== operation.instanceId || grant.stageId !== operation.stageId || !sameItem(grant.contentItemId, operation.contentItemId) || grant.requestHash !== operation.requestHash || grant.idempotencyKey !== operation.idempotencyKey) return false;
  const failed = store.getExternalOperation(grant.failedOperationKey);
  return failed?.status === "failed" && operationResultHash(failed) === grant.failedSnapshotSha256 &&
    store.getInstance(grant.instanceId)?.workflowSha256 === grant.workflowSha256 && store.rootInstanceId(grant.instanceId) === grant.rootId;
}

function latestRun(store, operation) {
  const runs = operation.contentItemId ? store.listContentItemRuns(operation.instanceId) : store.listStageRuns(operation.instanceId);
  return runs.filter(run => run.stageId === operation.stageId && sameItem(run.contentItemId, operation.contentItemId)).sort((a, b) => b.attempt - a.attempt)[0];
}

export function assertOperationAllowance(store, operation, scopes) {
  const grants = store.listOperationRecoveries(store.rootInstanceId(operation.instanceId));
  for (const scope of scopes) {
    // Failed operations remain in the count. Only a previously authorized
    // recovery operation is accounted against its dedicated +1, never against
    // another card's normal allocation. Unused permits are not fungible.
    const dedicated = scope.root ? 0 : scope.operations.filter(op => grants.some(grant => grant.scopeIds.includes(scope.id) && recoveryBindingMatches(store, grant, op))).length;
    if (scope.operations.length < scope.maxOperations + dedicated) continue;
    const grant = !scope.root && grants.find(entry => entry.scopeIds.includes(scope.id) && recoveryBindingMatches(store, entry, operation));
    if (grant && latestRun(store, operation)?.cardId === operation.ownerCardId && !store.listExternalOperations(operation.instanceId).some(op => op.ownerCardId === operation.ownerCardId)) continue;
    reject(`${scope.root ? "Project" : "Workflow call/child"} external-operation limit reached; explicit card-bound recovery authorization required`);
  }
}

// Called inside BEGIN IMMEDIATE, shared with reserve. One failed operation can
// authorize at most one successor, even with duplicate/concurrent requests.
export function authorizeOperationRecovery(store, request, now = new Date()) {
  const { actor, reason, authorization, evidence, failedOperationKey, ...operation } = request;
  for (const [key, value] of Object.entries({ actor, reason, authorization, evidence })) if (typeof value !== "string" || !value.trim() || value.length > 2000) reject(`${key} is required (nonempty, at most 2000 characters)`);
  if (!/^[a-f0-9]{64}$/.test(operation.requestHash ?? "")) reject("requestHash must be a SHA-256 hex digest");
  const id = `operation-recovery:${createHash("sha256").update(String(failedOperationKey)).digest("hex")}`;
  const existing = store.getEvent(id)?.payload;
  if (existing) {
    if (!recoveryBindingMatches(store, existing, operation)) reject("Failed operation is already bound to a different recovery or changed checkpoint");
    return { ...existing, reused: true };
  }
  const failed = store.getExternalOperation(failedOperationKey);
  if (failed?.status !== "failed" || !failed.result) reject("Recovery requires a known failed operation with recorded supplier evidence; unknown outcomes require readback");
  if (failed.instanceId !== operation.instanceId || failed.stageId !== operation.stageId || !sameItem(failed.contentItemId, operation.contentItemId)) reject("Failed operation and recovery must have the same execution, stage and item");
  const runs = operation.contentItemId ? store.listContentItemRuns(operation.instanceId) : store.listStageRuns(operation.instanceId);
  const source = runs.find(run => run.cardId === failed.ownerCardId);
  const latest = latestRun(store, operation);
  const previous = runs.filter(run => run.stageId === operation.stageId && sameItem(run.contentItemId, operation.contentItemId) && run.attempt < latest?.attempt).sort((a, b) => b.attempt - a.attempt)[0];
  if (!source || previous?.cardId !== source.cardId || latest?.cardId !== operation.ownerCardId || latest.attempt <= source.attempt || !["ready", "blocked", "scheduled"].includes(latest.status)) reject("Recovery must target the latest stopped/ready new attempt immediately following the failed card");
  if (store.getExternalOperation(operation.idempotencyKey) || store.listExternalOperations(operation.instanceId).some(op => op.ownerCardId === operation.ownerCardId)) reject("Recovery card already has an operation; read back instead");
  store.assertCallAdmission(operation.instanceId, now);
  const instance = store.getInstance(operation.instanceId);
  const rootId = store.rootInstanceId(instance.id);
  if (instance.status !== "active" || !store.getInstanceControl(instance.id).automaticDispatch || store.getInstance(rootId)?.status !== "active" || !store.getInstanceControl(rootId).automaticDispatch) reject("Project is paused or dispatch disabled");
  const scopes = operationLimitScopes(store, instance.id, now);
  const exhausted = scopes.filter(scope => scope.operations.length >= scope.maxOperations);
  if (exhausted.some(scope => scope.root)) reject("Root Project external-operation limit reached; recovery cannot expand it");
  if (scopes.filter(scope => !scope.root).some(scope => scope.operations.some(op => !["succeeded", "failed"].includes(op.status)))) reject("Related external outcome is unknown or executing; supplier readback required");
  if (!exhausted.length) reject("No exhausted child/call operation limit; normal reservation needs no allowance");
  if (exhausted.some(scope => scope.maxOperations === 0)) reject("Zero-operation scope cannot be enabled by recovery");
  const grant = { id, ...operation, rootId, workflowSha256: instance.workflowSha256, failedOperationKey, failedSnapshotSha256: operationResultHash(failed), additionalOperations: 1, scopeIds: exhausted.map(scope => scope.id), actor, reason, authorization, evidence, createdAt: now.toISOString() };
  store.appendEvent({ eventId: id, instanceId: rootId, type: RECOVERY_EVENT, payload: grant, now });
  return { ...grant, reused: false };
}
