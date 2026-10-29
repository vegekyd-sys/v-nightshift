import { createHash } from "node:crypto";
import { durationMs } from "./workflow-call-contract.mjs";
import { stageEnabled } from "./workflow.mjs";

export const RETRY_WINDOW_EVENT = "stage.retry.window-reset";
const reject = message => { throw Object.assign(new Error(message), { statusCode: 409 }); };

// Not a permission API. Runtime invokes this as part of a validated retry.
// The transaction records the attempt before any remote Workboard reopening,
// so replay after an interrupted reopening cannot keep moving the deadline.
export function resetRetryWindow(store, request, now) {
  const { instanceId, cardId, stageId, contentItemId = null, targetAttempt, nativeAttempt, actor, note, failedOperationKey = null, callId = null } = request;
  const rootId = store.rootInstanceId(instanceId);
  const ownCall = callId ? store.getCall(callId) : null;
  const calls = [...(ownCall ? [ownCall] : []), ...store.callAncestors(instanceId)];
  const root = store.getInstance(rootId);
  const rootLimit = store.getRelease(root.workflowSha256).manifest.spec.limits?.maxDuration;
  // maxDuration is a technical execution window, not a budget authorization expiry.
  // A real accepted retry renews the root clock too; do not clear its ledger/caps.
  const rootDeadline = rootLimit ? now.getTime() + durationMs(rootLimit) : Infinity;
  if (calls.length) {
    const ids = [...new Set([instanceId, rootId, ...calls.flatMap(call => [call.parentId, call.childId])])];
    for (const id of ids) {
      const instance = store.getInstance(id);
      if ((instance?.status !== "active" && !(ownCall?.childId === id && instance?.status === "done")) || !store.getInstanceControl(id).automaticDispatch) reject("Project or child is paused or dispatch disabled");
    }
    for (const call of calls) {
      const parent = store.getInstance(call.parentId);
      const stage = store.getRelease(parent.workflowSha256).manifest.spec.stages.find(stage => stage.id === call.stageId);
      const runs = call.contentItemId ? store.listContentItemRuns(parent.id).filter(run => run.contentItemId === call.contentItemId) : store.listStageRuns(parent.id);
      const latest = runs.filter(run => run.stageId === call.stageId).sort((a, b) => b.attempt - a.attempt)[0];
      const latestCall = store.listCalls(parent.id).filter(entry => entry.cardId === call.cardId).sort((a, b) => b.iteration - a.iteration)[0];
      if (!stageEnabled(stage, parent.inputs) || latest?.cardId !== call.cardId || latestCall?.id !== call.id || (call.contentItemId && store.listSkippedContentItems(parent.id).some(item => item.contentItemId === call.contentItemId))) reject("Workflow call was disabled, skipped or superseded");
      if (call.state !== "running" && !(call.state === "held" && call.reason === "duration-limit")) reject("Retry cannot clear this Workflow call hold");
    }
    // Resuming the original known task is allowed, creating another is not.
    const related = [...new Set(calls.flatMap((call, index) => store.listCalls(call.parentId)
      .filter(entry => entry.cardId === call.cardId && (index === 0 || entry.iteration < call.iteration))
      .flatMap(entry => store.executionIds(entry.childId))))];
    if (related.flatMap(id => store.listExternalOperations(id)).some(op => !["succeeded", "failed"].includes(op.status) && !(op.status === "executing" && op.ownerCardId === cardId && op.externalTaskId))) reject("External outcome is ambiguous; supplier readback is required before retry");
  }
  if (!calls.length && store.listExternalOperations(instanceId).some(op => op.ownerCardId === cardId &&
      !["succeeded", "failed"].includes(op.status) && !(op.status === "executing" && op.externalTaskId))) {
    reject("External outcome is ambiguous; supplier readback is required before retry");
  }
  const previous = store.listRetryWindows(rootId).find(event => event.cardId === cardId && event.nativeAttempt === nativeAttempt && event.targetAttempt === targetAttempt);
  if (previous && now.getTime() < store.executionDeadline(rootId) && (!calls.length || now.getTime() < Math.min(...calls.map(call => call.deadline)))) return { ...previous, reused: true };
  const generation = (previous?.generation ?? 0) + 1;
  const id = `retry-window:${createHash("sha256").update(JSON.stringify([instanceId, cardId, nativeAttempt, targetAttempt, generation])).digest("hex")}`;
  const instanceDeadlines = rootLimit ? { [rootId]: rootDeadline } : {};
  for (const executionId of [...new Set(calls.flatMap(call => [call.parentId, call.childId]))].filter(id => id !== rootId)) {
    const instance = store.getInstance(executionId);
    const limit = store.getRelease(instance.workflowSha256).manifest.spec.limits?.maxDuration;
    if (limit) instanceDeadlines[executionId] = Math.min(rootDeadline, now.getTime() + durationMs(limit));
  }
  let ancestorDeadline = rootDeadline;
  const resets = [];
  for (const call of [...calls].reverse()) {
    const parent = store.getInstance(call.parentId);
    const stage = store.getRelease(parent.workflowSha256).manifest.spec.stages.find(stage => stage.id === call.stageId);
    const deadline = Math.min(ancestorDeadline, instanceDeadlines[parent.id] ?? Infinity, instanceDeadlines[call.childId] ?? Infinity, now.getTime() + Math.min(durationMs(stage.timeout), durationMs(stage.repeat?.maxDuration ?? stage.timeout)));
    if (deadline <= now.getTime()) reject("No time remains within Project duration limit");
    resets.push({ callId: call.id, originalDeadline: call.deadline, deadline });
    store.saveCall({ ...call, deadline, attemptWindowStartedAt: now.getTime(), retryWindowId: id, state: "running", reason: "retry" });
    ancestorDeadline = deadline;
  }
  const window = { id, rootId, instanceId, cardId, stageId, contentItemId, targetAttempt, nativeAttempt, generation,
    failedOperationKey, actor, note, resets, instanceDeadlines, createdAt: now.toISOString() };
  store.appendEvent({ instanceId: rootId, eventId: id, type: RETRY_WINDOW_EVENT, payload: window, now });
  return { ...window, reused: false };
}
