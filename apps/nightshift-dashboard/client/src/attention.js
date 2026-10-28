// Night Shift is meant to run lights-out: a card that the engine or the agent
// will finish on its own is not the operator's business. This module decides,
// for each project and each task, whether a person needs to act.

const DAY_MS = 86_400_000;

// A paused project that has not moved for this long is shelved: it is history,
// not work in progress. On V (2026-09-28) 44 of 61 星擎夜班 D projects were
// paused and untouched for days, and they carried 94 of the board's 96 blocked
// cards, so the live view showed red everywhere while nothing needed anyone.
export const SHELVE_AFTER_MS = 3 * DAY_MS;

export const PROJECT_SCOPES = ["live", "paused", "delivered", "shelved", "all"];

// 在产 is what runs by itself. A paused project does not move, so it has its
// own tab while recent and becomes shelved once it has sat for days.
export function projectScope(instance, now = Date.now()) {
  if (instance.status === "archived") return "archived";
  if (instance.status === "done") return "delivered";
  if (instance.status === "active") return "live";
  const idle = now - Date.parse(instance.updatedAt ?? instance.createdAt ?? 0);
  return idle > SHELVE_AFTER_MS ? "shelved" : "paused";
}

export function inScope(instance, scope, now = Date.now()) {
  const actual = projectScope(instance, now);
  if (actual === "archived") return false;
  return scope === "all" || actual === scope;
}

// A project may authorize paid production once for all of its items; the
// engine then creates no per-item approval (orchestrator.mjs). External
// publication always needs its own approval.
export function scopeAuthorizes(instance, effect) {
  return effect === "paid-production" && instance?.inputs?.authorizationScope?.paidProduction === true;
}

const QUEUED = new Set(["triage", "backlog", "todo", "planned", "ready", "scheduled"]);
const OPERATION_UNDER_WAY = new Set(["reserved", "executing"]);

// needs-you: only a person can move it. healing: the engine retries it, or the
// agent's paid work is still running. running / queued / done: ordinary flow.
// stale: a shelved project's leftovers, kept for reference and never counted
// as work waiting on someone.
//
// When the engine serves its 需要你 queue (overview.needsYou), that queue alone
// decides what needs a person; the board only adds healing and flow. Without
// it (an older server) the board falls back to judging blocked cards itself.
export function taskAttention(task, { operation = null, shelved = false, queue = null } = {}) {
  // A person decided not to deliver this item: settled, not waiting on anyone.
  if (task.skipped) return { kind: "skipped", reason: task.skipReason ? `已跳过：${task.skipReason}` : "已跳过" };
  const call = task.workflowCall ?? task.card?.metadata?.automation?.workflowCall;
  const attention = call ? (call.state === "succeeded" ? {kind: "done"} : call.blocked ? {kind: "needs-you", reason: call.reason} : {kind: "running", reason: `第 ${call.iteration} 轮子流程执行中`}) : queue ? queuedAttention(task, operation, queue) : liveAttention(task, operation);
  if (shelved && attention.kind !== "done") return { kind: "stale", reason: attention.reason ?? "项目已搁置" };
  return attention;
}

// The engine's queue, indexed by card: open requests and approvals, and the
// blocked cards it is still giving a grace period before deciding.
export function needsYouQueue(needsYou, gatewayRestart = null) {
  if (!needsYou || !Array.isArray(needsYou.items)) return null;
  return {
    byCard: new Map(needsYou.items.map((item) => [item.cardId, item])),
    pending: new Map((needsYou.pending ?? []).map((entry) => [entry.cardId, entry])),
    // While the Gateway restarts (#125) Night Shift judges nothing; the cards
    // it interrupted go back to ready when it returns.
    holding: Boolean(gatewayRestart && gatewayRestart.status !== "up"),
  };
}

function queuedAttention(task, operation, queue) {
  const cardId = task.card?.id ?? task.cardId;
  const status = task.card?.status ?? task.status;
  if (status === "done") return { kind: "done" };
  if (status === "running") return { kind: "running" };
  const request = cardId ? queue.byCard.get(cardId) : null;
  if (request) {
    const reason = request.kind === "decision"
      ? request.problem
      : task.requiresApproval || request.kind === "approval" ? `等你确认${effectLabel(task.guardedEffect) ?? "执行"}` : "等你审核";
    return { kind: "needs-you", reason, request };
  }
  if (task.status === "retry_wait" || task.failure?.automaticRetry) return { kind: "healing", reason: "故障后自动重试中" };
  if (status === "blocked" && operation && OPERATION_UNDER_WAY.has(operation.status)) {
    return { kind: "healing", reason: "付费任务仍在执行，完成后自动恢复" };
  }
  // In its grace period, or blocked since the engine's last pass: the engine
  // either queues it or it moves on within minutes.
  if (status === "blocked" && queue.holding) return { kind: "healing", reason: "Gateway 重启中，恢复后自动接上" };
  if (status === "blocked") return { kind: "healing", reason: "正在判定是否需要你", judging: true };
  return { kind: "queued" };
}

function liveAttention(task, operation) {
  const status = task.card?.status ?? task.status;
  if (status === "done") return { kind: "done" };
  if (status === "running") return { kind: "running" };
  if (task.status === "retry_wait" || task.failure?.automaticRetry) {
    return { kind: "healing", reason: "故障后自动重试中" };
  }
  if (status === "review") {
    return { kind: "needs-you", reason: task.requiresApproval ? `等你确认${effectLabel(task.guardedEffect) ?? "执行"}` : "等你审核" };
  }
  if (status === "blocked") {
    // The board can show a card blocked while its agent is still waiting on a
    // paid provider; retrying would pay twice. The engine recovers it from the
    // persisted result once the run ends.
    if (operation && OPERATION_UNDER_WAY.has(operation.status)) {
      return { kind: "healing", reason: "付费任务仍在执行，完成后自动恢复" };
    }
    if (task.requiresApproval) return { kind: "needs-you", reason: `等你确认${effectLabel(task.guardedEffect) ?? "执行"}` };
    if (operation?.status === "failed") return { kind: "needs-you", reason: "外部操作失败，决定重做或放弃" };
    return { kind: "needs-you", reason: failureReason(task.failure) };
  }
  if (QUEUED.has(status)) return { kind: "queued" };
  return { kind: "queued" };
}

export function failureReason(failure) {
  if (!failure) return "Agent 停下来了，需要看一下";
  if (failure.kind === "contract_error" && failure.validationPhase === "side_effect") return "外部操作没有成功记录，需要核对";
  if (failure.kind === "contract_error") return "产物没有通过完成校验";
  const raw = String(failure.rawError ?? "").trim();
  return raw ? truncate(raw, 60) : "Agent 停下来了，需要看一下";
}

export function effectLabel(effect) {
  return ({ "external-publication": "外部发布", "paid-production": "付费生产", destructive: "高风险操作", "permission-change": "权限变更" })[effect] ?? null;
}

// Content items a person skipped (#115). They are out of the project: the
// board neither waits on them nor counts them.
export function skippedItems(instance) {
  return new Map((instance?.skippedContentItems ?? []).map((entry) => [entry.contentItemId, entry.reason ?? null]));
}

// Stages this project will actually run, honoring `when` on project inputs.
export function enabledStages(stages, inputs = {}) {
  return stages.filter((stage) => stageEnabled(stage, inputs));
}

// Overview omits private inputs. Its server-computed facts are authoritative;
// full project/bootstrap responses from older servers still use their inputs.
function projectStageEnabled(stage, instance) {
  const condition = instance.stageConditions?.[stage.id];
  return typeof condition === "boolean" ? condition : stageEnabled(stage, instance.inputs ?? {});
}

// A changed condition must not erase work that already has a persisted run.
// This is display-only: it does not enable the branch in the scheduler.
function recordedTasks(stage, instance) {
  if (stage.scope !== "content-item") return (instance.stageRuns ?? []).some((run) => run.stageId === stage.id) ? 1 : 0;
  const skipped = skippedItems(instance);
  return new Set((instance.contentItemRuns ?? [])
    .filter((run) => run.stageId === stage.id && !skipped.has(run.contentItemId))
    .map((run) => run.contentItemId)).size;
}

export function visibleStages(stages, instances) {
  if (!instances.length) return stages;
  return stages.filter((stage) => instances.some((instance) => projectStageEnabled(stage, instance) || recordedTasks(stage, instance) > 0));
}

function stageEnabled(stage, inputs) {
  const when = stage.when;
  if (!when || typeof when !== "object") return true;
  const value = inputs?.[when.input];
  if ("equals" in when) return value === when.equals;
  if ("notEquals" in when) return value !== when.notEquals;
  if ("in" in when && Array.isArray(when.in)) return when.in.includes(value);
  return true;
}

// Expected task count for a project, so a bar shows the whole job and not
// only the cards that exist so far. Branch facts and content items size planned
// work; historical runs retain only the actual work of a now-disabled stage.
export function expectedTasks(stages, instance) {
  return projectProgress(stages, instance).expected;
}

// Before planning splits the job into items, the item count is unknown. A
// bar of 1/2 that later becomes 1/42 reads as going backwards, so a declared
// target count stands in; without one the bar says it is still splitting.
export function projectProgress(stages, instance) {
  const enabled = stages.filter((stage) => projectStageEnabled(stage, instance));
  const historical = stages.filter((stage) => !projectStageEnabled(stage, instance))
    .reduce((sum, stage) => sum + recordedTasks(stage, instance), 0);
  const itemStages = enabled.filter((stage) => stage.scope === "content-item").length;
  const known = Math.max(0, (instance.contentItems ?? []).length - skippedItems(instance).size);
  const target = Number(instance.inputs?.targetCount);
  const splitting = itemStages > 0 && known === 0;
  const items = splitting && Number.isFinite(target) && target > 0 ? target : known;
  return {
    expected: enabled.length - itemStages + itemStages * items + historical,
    estimated: splitting && items > 0,
    splitting: splitting && items === 0,
  };
}

// How many tasks one stage will have across the shown projects.
export function stageExpected(stage, instances) {
  return instances.reduce((sum, instance) => {
    if (!projectStageEnabled(stage, instance)) return sum + recordedTasks(stage, instance);
    return sum + (stage.scope === "content-item" ? Math.max(0, (instance.contentItems ?? []).length - skippedItems(instance).size) : 1);
  }, 0);
}

export function countByKind(entries) {
  const counts = { "needs-you": 0, healing: 0, running: 0, queued: 0, done: 0, stale: 0, skipped: 0 };
  for (const entry of entries) counts[entry.attention.kind] = (counts[entry.attention.kind] ?? 0) + 1;
  return counts;
}

export function isToday(value, now = Date.now()) {
  if (!value) return false;
  const at = new Date(typeof value === "number" ? value : Date.parse(value));
  const today = new Date(now);
  return at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// The latest run of each (stage, item) in a project, classed like the lanes.
// Pages that list projects or cards use it without building the lane index.
export function projectRuns(instance, { cardsById = new Map(), now = Date.now(), queue = null } = {}) {
  const shelved = projectScope(instance, now) === "shelved";
  const operationByCard = new Map((instance.operations ?? []).map((operation) => [operation.ownerCardId, operation]));
  const skipped = skippedItems(instance);
  const latest = new Map();
  const runs = [
    ...(instance.stageRuns ?? []).map((run) => ({ ...run, contentItemId: null })),
    ...(instance.contentItemRuns ?? []),
  ];
  for (const run of runs) {
    const key = `${run.stageId}:${run.contentItemId ?? "project"}`;
    const current = latest.get(key);
    if (!current || (run.attempt ?? 1) >= (current.attempt ?? 1)) latest.set(key, run);
  }
  return [...latest.values()].map((run) => {
    const card = run.cardId ? cardsById.get(run.cardId) : undefined;
    const status = run.status === "blocked" && run.failure?.automaticRetry && run.failure?.nextRetryAt ? "retry_wait" : (card?.status ?? run.status);
    const task = { ...run, card, workflowCall: (instance.calls ?? []).filter(call => call.cardId === run.cardId).at(-1), status, skipped: skipped.has(run.contentItemId), skipReason: skipped.get(run.contentItemId) ?? null };
    return { ...task, attention: taskAttention(task, { operation: operationByCard.get(run.cardId), shelved, queue }) };
  });
}

// Cards another attempt of the same stage and item replaced: a redo after
// 要求修改, or a fresh attempt after a stop. The native board has no cancelled
// state, so the replaced card stays blocked there; the item's work goes on in
// the newer card (DL-1009-02 on V, 2026-10-10: five such cards showed as
// 自愈中 in a project that had delivered all 24).
export function supersededCards(instance) {
  const runs = [
    ...(instance.stageRuns ?? []).map((run) => ({ ...run, contentItemId: null })),
    ...(instance.contentItemRuns ?? []),
  ];
  const key = (run) => `${run.stageId}:${run.contentItemId ?? "project"}`;
  const latest = new Map();
  for (const run of runs) latest.set(key(run), Math.max(latest.get(key(run)) ?? 0, run.attempt ?? 1));
  return new Set(runs.filter((run) => run.cardId && (run.attempt ?? 1) < latest.get(key(run))).map((run) => run.cardId));
}

// Which of two tasks of one stage and item a stage shows: the newer attempt,
// whatever its status; within one attempt (an approval and its execution card),
// the one further from done.
export function preferTask(candidate, current) {
  if (!candidate.isApproval && !current.isApproval && (candidate.attempt ?? 1) !== (current.attempt ?? 1)) {
    return (candidate.attempt ?? 1) > (current.attempt ?? 1);
  }
  const candidateRank = statusOrder(candidate.status);
  const currentRank = statusOrder(current.status);
  if (candidateRank !== currentRank) return candidateRank < currentRank;
  return new Date(candidate.card?.updatedAt ?? candidate.updatedAt ?? 0) > new Date(current.card?.updatedAt ?? current.updatedAt ?? 0);
}

export function statusOrder(status) { return ({ running: 0, retry_wait: 1, review: 2, blocked: 3, ready: 4, done: 5 })[status] ?? 6; }

// Attention for a native card on its own (Live Board), using the run and the
// paid operation behind it when the card belongs to a Night Shift project.
export function cardAttention(card, { run = null, operation = null, shelved = false, approval = false, queue = null, skipped = false, skipReason = null, superseded = false } = {}) {
  if (superseded) return { kind: "superseded", reason: "已由新的一次尝试接着做" };
  const status = run?.status === "blocked" && run.failure?.automaticRetry && run.failure?.nextRetryAt ? "retry_wait" : card.status;
  return taskAttention({ ...(run ?? {}), card: { ...card, status: status === "retry_wait" ? "blocked" : card.status }, status, requiresApproval: approval, skipped, skipReason }, { operation, shelved, queue });
}
