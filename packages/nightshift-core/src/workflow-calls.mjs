import { artifactFromHandoffDirectory } from "./deliverables.mjs";
import { stageEnabled } from "./workflow.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { durationMs, factAt, matchesFact } from "./workflow-call-contract.mjs";
import { normalizeStageHandoff, stageHandoffContract, stageHandoffPath } from "./handoff.mjs";
import { redactSensitiveInputs } from "./orchestrator.mjs";
import { validateProjectRequest } from "./project.mjs";

export function boundCallInputs(stage, parent, item, previous = {}) {
  const inputs = Object.fromEntries(Object.entries(stage.call.inputs).flatMap(([key, binding]) => {
    const bound = binding && typeof binding === "object" && !Array.isArray(binding);
    const source = bound && !Object.hasOwn(binding, "value") ? factAt({ input: parent.inputs ?? {}, item: item ?? {}, previous }, binding.from) : undefined;
    const value = bound ? Object.hasOwn(binding, "value") ? binding.value : source === undefined ? binding.default : source : binding;
    return value === undefined ? [] : [[key, structuredClone(value)]];
  }));
  // The caller cannot manufacture broader authorization through a binding.
  if (parent.inputs?.authorizationScope) inputs.authorizationScope = structuredClone(parent.inputs.authorizationScope);
  if (parent.inputs?.governance) inputs.governance = structuredClone(parent.inputs.governance);
  return inputs;
}

export async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

// Outputs are explicit JSON exports from the completed called release, never
// free-text messages or files from a previous iteration.
export async function readCallOutputs({ store, instance, release }) {
  const root = instance.inputs?.nightshift?.instanceDir;
  if (!root) throw new Error("Called Workflow needs an artifact directory");
  const exports = {};
  for (const [name, source] of Object.entries(release.spec.outputs)) {
    const latest = store.listStageRuns(instance.id).filter(run => run.stageId === source.stage).sort((a, b) => b.attempt - a.attempt)[0];
    if (latest?.status !== "done") throw new Error(`Export stage ${source.stage} is not complete`);
    const handoff = normalizeStageHandoff(JSON.parse(await boundedRead(join(root, "handoffs", `${source.stage}.json`))), { instanceId: instance.id, release, stageId: source.stage });
    const artifact = handoff.outputs.find(entry => entry.name === source.output)?.artifact;
    if (!artifact) throw new Error(`Missing export ${name}`);
    const target = await realpath(resolve(root, artifactFromHandoffDirectory(artifact, join(root, "handoffs"))));
    const inside = relative(await realpath(root), target);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Call export must stay inside its execution directory");
    exports[name] = JSON.parse(await boundedRead(target));
  }
  return exports;
}
async function boundedRead(file) {
  if ((await stat(file)).size > 65536) throw new Error("Call fact exceeds 64 KiB; export a resource reference instead");
  return readFile(file, "utf8");
}

async function materializeOutputs(parent, release, stage, run, outputs) {
  const root = parent.inputs?.nightshift?.instanceDir;
  if (!root) throw new Error("Parent Workflow needs an artifact directory");
  const contract = stageHandoffContract(release, stage.id);
  const entries = [];
  for (const name of stage.outputs ?? []) {
    const artifact = join("call-outputs", run.cardId, `${name}.json`);
    await atomicJson(join(root, artifact), outputs[name]);
    entries.push({ name, sourceStage: stage.id, artifact, summary: "Verified called Workflow output" });
  }
  await atomicJson(stageHandoffPath({ instanceDir: root, contentItemId: run.contentItemId, release, stageId: stage.id }), {
    version: 1, instanceId: parent.id, contentItemId: run.contentItemId ?? null, stageId: stage.id,
    inputs: contract.inputs.map(entry => ({ ...entry, summary: "Caller dependency", artifact: entry.sourceStage === "control-plane" ? "project-inputs.json" : relative(root, stageHandoffPath({ instanceDir: root, contentItemId: run.contentItemId, release, stageId: entry.sourceStage })) })), outputs: entries,
  });
}

export async function advanceWorkflowCalls(runtime, parent, release, { nowMs, inspectSessions }) {
  const { store, workboard } = runtime;
  const applied = [];
  if (parent.status !== "active" || !store.getInstanceControl(parent.id).automaticDispatch) return applied;
  const runs = [...store.listStageRuns(parent.id), ...store.listContentItemRuns(parent.id)];
  for (const run of runs) {
    const stage = release.spec.stages.find(stage => stage.id === run.stageId);
    if (stage?.actor !== "workflow" || !stageEnabled(stage, parent.inputs) || (run.contentItemId && runtime.isContentItemSkipped(parent.id, run.contentItemId)) || !run.cardId || runs.some(other => other.stageId === run.stageId && (other.contentItemId ?? null) === (run.contentItemId ?? null) && other.attempt > run.attempt)) continue;
    let history = store.listCalls(parent.id).filter(call => call.cardId === run.cardId).sort((a, b) => a.iteration - b.iteration);
    let call = history.at(-1);
    if (!call && !["review", "ready"].includes(run.status)) {
      await projectController(runtime, run, "blocked", "Workflow call was stopped before starting; retry this control card explicitly");
      continue;
    }
    if (!call) call = await startIteration(runtime, parent, stage, run, history, nowMs);
    if (call.state === "succeeded") {
      await finishController(runtime, parent, release, stage, run, call);
      continue;
    }
    if (call.state === "held") { await projectController(runtime, run, "blocked", call.reason); continue; }
    if (nowMs >= call.deadline) {
      hold(store, call, "duration-limit");
      await projectController(runtime, run, "blocked", call.reason);
      continue;
    }
    const child = store.getInstance(call.childId);
    const childRelease = store.getRelease(child.workflowSha256).manifest;
    // Private contexts still use the existing reconciler and planner. Only the
    // root tick dispatches, so calls cannot multiply global/project capacity.
    if (runtime.beforeCallTick) await runtime.beforeCallTick(child);
    const result = await runtime.tick(child.id, { dispatch: false, inspectSessions, now: nowMs });
    // Child reconciliation can accept a retry and renew this path's window.
    // Do not overwrite that durable reset with this tick's older call object.
    call = store.getCall?.(call.id) ?? call;
    applied.push(...result.applied);
    if (result.instance.status !== "done") {
      const blocked = store.executionIds(child.id).some(id => [...store.listStageRuns(id), ...store.listContentItemRuns(id)].some(entry => entry.status === "blocked"));
      call.reason = blocked ? "child-work-stopped: recover the child card in this round" : "executing";
      store.saveCall(call);
      await projectController(runtime, run, blocked ? "blocked" : "review", `Round ${call.iteration}: ${call.reason}`);
      continue;
    }
    const unresolved = store.executionIds(child.id).flatMap(id => store.listExternalOperations(id)).some(op => !["succeeded", "failed"].includes(op.status));
    if (unresolved) hold(store, call, "external-outcome-unknown: supplier readback required");
    else {
      if (!call.outputs) {
        try { call.outputs = await readCallOutputs({ store, instance: child, release: childRelease }); }
        catch (error) {
          hold(store, call, `output-contract: ${error instanceof SyntaxError ? "invalid JSON; inspect child artifacts" : error.message}`);
          await projectController(runtime, run, "blocked", call.reason);
          continue;
        }
        store.saveCall(call);
      }
      if (!stage.repeat || matchesFact(call.outputs, stage.repeat.until)) {
        call.state = "succeeded";
        call.reason = "success-condition";
        store.saveCall(call);
        store.appendEvent({ instanceId: parent.id, eventId: `call-result:${call.id}`, type: "workflow.call.succeeded", payload: { callId: call.id, iteration: call.iteration } });
        await finishController(runtime, parent, release, stage, run, call);
        continue;
      }
      if (!matchesFact(call.outputs, stage.repeat.while)) hold(store, call, "no-matching-continuation: evidence or attention required");
      else if (call.iteration >= stage.repeat.maxIterations) hold(store, call, "iteration-limit");
      else {
        call.state = "continued";
        call.reason = "repeat-condition";
        store.saveCall(call);
        history = store.listCalls(parent.id).filter(entry => entry.cardId === run.cardId).sort((a, b) => a.iteration - b.iteration);
        const next = await startIteration(runtime, parent, stage, run, history, nowMs);
        await projectController(runtime, run, "review", `Round ${next.iteration}: repeat-condition`);
        continue;
      }
    }
    await projectController(runtime, run, "blocked", call.reason);
  }
  return applied;
}
function hold(store, call, reason) {
  call.state = "held";
  call.reason = reason;
  store.saveCall(call);
  store.appendEvent({ instanceId: call.parentId, eventId: `call-held:${call.id}:${reason}`, type: "workflow.call.held", payload: { callId: call.id, iteration: call.iteration, reason } });
}
async function startIteration(runtime, parent, stage, run, history, nowMs) {
  const { store } = runtime;
  // If the prior transition committed but creation did not, replay that exact
  // next identity. Iteration != native retry attempt != redo revision.
  const iteration = history.length ? history.at(-1).iteration + 1 : 1;
  const id = createHash("sha256").update(JSON.stringify([parent.id, stage.id, run.contentItemId ?? null, run.attempt, iteration])).digest("hex").slice(0, 24);
  const childId = `WFC-${id}`;
  const saved = store.listCalls(parent.id).find(entry => entry.id === id);
  if (saved) return saved;
  const item = run.contentItemId ? runtime.contentItemsWithRevisions(parent.id).find(item => item.id === run.contentItemId) : null;
  const inputs = boundCallInputs(stage, parent, item, history.at(-1)?.outputs ?? {});
  if (!parent.inputs?.nightshift?.instanceDir) throw new Error("Workflow calls require a project artifact directory");
  const instanceDir = runtime.executionRoot ? join(runtime.executionRoot, childId) : join(parent.inputs.nightshift.instanceDir, "calls", childId);
  inputs.nightshift = { instanceDir, projectInputsPath: join(instanceDir, "project-inputs.json"), contentItemsManifestPath: join(instanceDir, "content-items.json") };
  const child = validateProjectRequest(store.getRelease(stage.call.workflow).manifest, { id: childId, name: `${stage.title} · ${iteration}`, workflowSha256: stage.call.workflow, inputs, agentBindings: parent.agentBindings });
  if (runtime.callPreflight) await runtime.callPreflight(store.getRelease(stage.call.workflow).manifest, child);
  const previous = history.at(-1);
  const root = store.getInstance(store.rootInstanceId(parent.id));
  const rootDuration = store.getRelease(root.workflowSha256).manifest.spec.limits?.maxDuration;
  const rootDeadline = rootDuration ? Date.parse(root.createdAt) + durationMs(rootDuration) : Infinity;
  const ancestorDeadline = Math.min(Infinity, ...store.callAncestors(parent.id).map(call => call.deadline));
  const created = store.createCall({ id, parentId: parent.id, childId, cardId: run.cardId, stageId: stage.id, contentItemId: run.contentItemId ?? null, attempt: run.attempt, iteration,
    startedAt: nowMs, deadline: Math.min(previous?.deadline ?? nowMs + Math.min(durationMs(stage.timeout), durationMs(stage.repeat?.maxDuration ?? stage.timeout)), rootDeadline, ancestorDeadline),
    ...(previous?.retryWindowId ? { retryWindowId: previous.retryWindowId, attemptWindowStartedAt: previous.attemptWindowStartedAt } : {}),
    maxOperations: stage.repeat?.maxOperations ?? stage.call.maxOperations ?? 0, state: "running", reason: iteration === 1 ? "initial" : "repeat-condition", outputs: null }, child);
  const persisted = store.getInstance(created.childId);
  await atomicJson(persisted.inputs.nightshift.projectInputsPath, { version: 1, instanceId: childId, inputs: redactSensitiveInputs(persisted.inputs) });
  return created;
}
async function projectController(runtime, run, status, summary) {
  const upsert = run.contentItemId ? "upsertContentItemRun" : "upsertStageRun";
  runtime.store[upsert]({ ...run, status, summary });
  const [card] = await runtime.workboard.listCards({ cardIds: [run.cardId] });
  if (card?.status !== status) await runtime.workboard.moveCard(run.cardId, status);
}
async function finishController(runtime, parent, release, stage, run, call) {
  await materializeOutputs(parent, release, stage, run, call.outputs);
  await projectController(runtime, run, "done", `Round ${call.iteration}: success-condition`);
}

export function publicCallSummary(store, instanceId) {
  return store.executionIds(instanceId).flatMap(id => store.listCalls(id)).map(call => ({
    id: call.id, parentId: call.parentId, childId: call.childId, cardId: call.cardId, stageId: call.stageId, contentItemId: call.contentItemId,
    iteration: call.iteration, state: call.state, blocked: call.state === "held" || call.reason.startsWith("child-work-stopped"), reason: call.reason, deadline: call.deadline,
    attemptWindowStartedAt: call.attemptWindowStartedAt ?? call.startedAt, retryWindowId: call.retryWindowId ?? null,
    totalOperations: store.listCalls(call.parentId).filter(entry => entry.cardId === call.cardId).flatMap(entry => store.executionIds(entry.childId)).reduce((sum, id) => sum + store.listExternalOperations(id).length, 0),
    operations: store.executionIds(call.childId).reduce((sum, id) => sum + store.listExternalOperations(id).length, 0),
    baseMaxOperations: call.maxOperations,
    recoveryOperations: store.listOperationRecoveries(store.rootInstanceId(instanceId)).filter(grant => grant.scopeIds.includes(`call:${call.parentId}:${call.cardId}`)).length,
    maxOperations: call.maxOperations + store.listOperationRecoveries(store.rootInstanceId(instanceId)).filter(grant => grant.scopeIds.includes(`call:${call.parentId}:${call.cardId}`)).length,
    cardIds: [...new Set(store.executionIds(call.childId).flatMap(id => [...store.listStageRuns(id), ...store.listContentItemRuns(id)].map(run => run.cardId).filter(Boolean).concat(store.listActionCardIds(id))))],
  }));
}
