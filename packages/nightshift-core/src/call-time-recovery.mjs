import { createHash } from "node:crypto";
import { durationMs } from "./workflow-call-contract.mjs";
import { stageEnabled } from "./workflow.mjs";

export const CALL_TIME_RECOVERY_EVENT = "workflow.call.time-recovery-authorized";
const reject = message => { throw Object.assign(new Error(message), { statusCode: 409 }); };

// Store calls this under BEGIN IMMEDIATE. One permit per controller (shared
// across its rounds), never a moving "now + timeout" on replay.
export function authorizeCallTimeRecovery(store, request, now) {
  const { callId, expectedDeadline, deadline, actor, reason, authorization, evidence } = request;
  for (const [key, value] of Object.entries({ actor, reason, authorization, evidence })) {
    if (typeof value !== "string" || !value.trim() || value.length > 2000) reject(`${key} is required (nonempty, at most 2000 characters)`);
  }
  if (!Number.isSafeInteger(expectedDeadline) || !Number.isSafeInteger(deadline)) reject("expectedDeadline and deadline must be integer epoch milliseconds");
  const call = store.getCall(callId);
  if (!call) reject("Workflow call not found");
  const id = `call-time-recovery:${createHash("sha256").update(JSON.stringify([call.parentId, call.cardId])).digest("hex")}`;
  const existing = store.getEvent(id)?.payload;
  if (existing) {
    if (existing.callId !== callId || existing.originalDeadline !== expectedDeadline || existing.deadline !== deadline) reject("Controller already has a different time recovery permit");
    return { ...existing, reused: true }; // no mutation, even after it expires
  }
  const parent = store.getInstance(call.parentId);
  const child = store.getInstance(call.childId);
  const rootId = store.rootInstanceId(parent.id);
  const root = store.getInstance(rootId);
  if ([parent, child, root].some(instance => instance?.status !== "active" || !store.getInstanceControl(instance.id).automaticDispatch)) reject("Project or child is paused or dispatch disabled");
  store.assertCallAdmission(parent.id, now); // ancestors cannot borrow this permit
  const stage = store.getRelease(parent.workflowSha256)?.manifest.spec.stages.find(entry => entry.id === call.stageId);
  const runs = call.contentItemId ? store.listContentItemRuns(parent.id).filter(run => run.contentItemId === call.contentItemId) : store.listStageRuns(parent.id);
  const latest = runs.filter(run => run.stageId === call.stageId).sort((a, b) => b.attempt - a.attempt)[0];
  const history = store.listCalls(parent.id).filter(entry => entry.cardId === call.cardId).sort((a, b) => b.iteration - a.iteration);
  if (stage?.actor !== "workflow" || !stageEnabled(stage, parent.inputs) || latest?.cardId !== call.cardId || history[0]?.id !== call.id || (call.contentItemId && store.listSkippedContentItems(parent.id).some(item => item.contentItemId === call.contentItemId))) reject("Workflow call was disabled, skipped or superseded");
  if (now.getTime() < call.deadline || !(call.state === "running" || (call.state === "held" && call.reason === "duration-limit"))) reject("Time recovery requires an expired running call or a duration-limit hold");
  if (call.deadline !== expectedDeadline) reject("Call deadline changed; refresh before authorizing time recovery");
  const declaredWindow = Math.min(durationMs(stage.timeout), durationMs(stage.repeat?.maxDuration ?? stage.timeout));
  if (deadline <= now.getTime() || deadline <= call.deadline || deadline - call.deadline > declaredWindow) reject("New deadline must be future and add no more than one declared call duration");
  const boundIds = [...new Set([rootId, parent.id, child.id, ...store.callAncestors(parent.id).map(entry => entry.parentId)])];
  const bounds = boundIds.map(instanceId => {
    const instance = store.getInstance(instanceId);
    const duration = store.getRelease(instance.workflowSha256)?.manifest.spec.limits?.maxDuration;
    return duration ? Date.parse(instance.createdAt) + durationMs(duration) : Infinity;
  });
  bounds.push(...store.callAncestors(parent.id).map(entry => entry.deadline));
  if (deadline > Math.min(...bounds)) reject("Time recovery cannot exceed Project, child or ancestor duration limits");
  const ids = [...new Set(history.flatMap(entry => store.executionIds(entry.childId)))];
  if (ids.flatMap(instanceId => store.listExternalOperations(instanceId)).some(op => !["succeeded", "failed"].includes(op.status) || !op.result)) reject("Related external outcome is unknown, executing or lacks evidence; supplier readback required");
  const grant = { id, callId, parentId: parent.id, rootId, childId: child.id, cardId: call.cardId,
    workflowSha256: parent.workflowSha256, childWorkflowSha256: child.workflowSha256,
    iteration: call.iteration, originalDeadline: call.deadline, deadline, additionalMilliseconds: deadline - call.deadline,
    actor, reason, authorization, evidence, createdAt: now.toISOString() };
  store.saveCall({ ...call, originalDeadline: call.deadline, timeRecoveryId: id, deadline, state: "running", reason: "authorized-time-recovery" });
  store.appendEvent({ eventId: id, instanceId: rootId, type: CALL_TIME_RECOVERY_EVENT, payload: grant, now });
  return { ...grant, reused: false };
}
