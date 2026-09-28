// Night Shift is meant to run lights-out: a card that the engine or the agent
// will finish on its own is not the operator's business. This module decides,
// for each project and each task, whether a person needs to act.

const DAY_MS = 86_400_000;

// A paused project that has not moved for this long is shelved: it is history,
// not work in progress. On V (2026-09-28) 44 of 61 星擎夜班 D projects were
// paused and untouched for days, and they carried 94 of the board's 96 blocked
// cards, so the live view showed red everywhere while nothing needed anyone.
export const SHELVE_AFTER_MS = 3 * DAY_MS;

export const PROJECT_SCOPES = ["live", "delivered", "shelved", "all"];

export function projectScope(instance, now = Date.now()) {
  if (instance.status === "archived") return "archived";
  if (instance.status === "done") return "delivered";
  if (instance.status === "active") return "live";
  const idle = now - Date.parse(instance.updatedAt ?? instance.createdAt ?? 0);
  return idle > SHELVE_AFTER_MS ? "shelved" : "live";
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
export function taskAttention(task, { operation = null, shelved = false } = {}) {
  const attention = liveAttention(task, operation);
  if (shelved && attention.kind !== "done") return { kind: "stale", reason: attention.reason ?? "项目已搁置" };
  return attention;
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

// Stages this project will actually run, honoring `when` on project inputs.
export function enabledStages(stages, inputs = {}) {
  return stages.filter((stage) => stageEnabled(stage, inputs));
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
// only the cards that exist so far. It reads only the Workflow's stages, their
// `when`, and the project's content items, so it means the same thing for any
// Workflow.
export function expectedTasks(stages, instance) {
  return projectProgress(stages, instance).expected;
}

// Before planning splits the job into items, the item count is unknown. A
// bar of 1/2 that later becomes 1/42 reads as going backwards, so a declared
// target count stands in; without one the bar says it is still splitting.
export function projectProgress(stages, instance) {
  const enabled = enabledStages(stages, instance.inputs ?? {});
  const itemStages = enabled.filter((stage) => stage.scope === "content-item").length;
  const known = (instance.contentItems ?? []).length;
  const target = Number(instance.inputs?.targetCount);
  const splitting = itemStages > 0 && known === 0;
  const items = splitting && Number.isFinite(target) && target > 0 ? target : known;
  return {
    expected: enabled.length - itemStages + itemStages * items,
    estimated: splitting && items > 0,
    splitting: splitting && items === 0,
  };
}

// How many tasks one stage will have across the shown projects.
export function stageExpected(stage, instances) {
  return instances.reduce((sum, instance) => {
    if (enabledStages([stage], instance.inputs ?? {}).length === 0) return sum;
    return sum + (stage.scope === "content-item" ? (instance.contentItems ?? []).length : 1);
  }, 0);
}

export function countByKind(entries) {
  const counts = { "needs-you": 0, healing: 0, running: 0, queued: 0, done: 0, stale: 0 };
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
