// Each stage's tasks across a set of projects, as the Workflow lanes show
// them, and the per-project tally of the same thing. The server tallies the
// projects it does not send in detail, so the pages can draw a delivered or
// shelved project from a few numbers instead of every card and run it had
// (星擎夜班 正式V1's 已交付 tab on V, 2026-11-04: 13 MB for 256 projects).
import { countByKind, isToday, preferTask, projectProgress, projectScope, scopeAuthorizes, skippedItems, stageExpected, taskAttention, visibleStages } from "./attention.js";

export function label(card, prefix) { return card.labels?.find((entry) => entry.startsWith(`${prefix}:`))?.slice(prefix.length + 1); }

export function cardLabel(card, prefix) {
  return card.metadata?.automation?.[`${prefix}Id`] ?? label(card, prefix);
}

export function indexStageTasks(stages, projects, cards, queue = null, now = Date.now()) {
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const result = new Map(stages.map((stage) => [stage.id, []]));
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const operationByCard = new Map(projects.flatMap((project) => (project.operations ?? []).map((operation) => [operation.ownerCardId, operation])));
  const shelvedProjects = new Set(projects.filter((project) => projectScope(project, now) === "shelved").map((project) => project.id));
  for (const project of projects) {
    const contentById = new Map((project.contentItems ?? []).map((item) => [item.id, item]));
    const skipped = skippedItems(project);
    const runs = [
      ...(project.stageRuns ?? []).map((run) => ({ ...run, contentItemId: null })),
      ...(project.contentItemRuns ?? []),
    ];
    for (const run of runs) {
      if (!result.has(run.stageId)) continue;
      const card = cardById.get(run.cardId);
      const content = run.contentItemId ? contentById.get(run.contentItemId) : null;
      result.get(run.stageId).push({
        ...run,
        card,
        contentTitle: content?.title,
        guardedEffect: stageById.get(run.stageId)?.approval?.before ?? null,
        projectId: project.id,
        projectName: project.name,
        requiresApproval: missingApprovalFor(project, stageById.get(run.stageId), run.contentItemId),
        skipped: skipped.has(run.contentItemId),
        skipReason: skipped.get(run.contentItemId) ?? null,
        status: displayedTaskStatus(run, card),
      });
    }
  }
  for (const card of cards) {
    if (!(card.labels ?? []).includes("nightshift:approval")) continue;
    const projectId = label(card, "instance");
    const stageId = label(card, "stage");
    const project = projectsById.get(projectId);
    if (!project || !result.has(stageId)) continue;
    if ([...result.get(stageId)].some((task) => task.card?.id === card.id)) continue;
    const contentItemId = label(card, "content-item");
    const content = (project.contentItems ?? []).find((item) => item.id === contentItemId);
    result.get(stageId).push({
      attempt: card.metadata?.automation?.attempt ?? 1,
      card,
      contentItemId,
      contentTitle: content?.title,
      guardedEffect: stageById.get(stageId)?.approval?.before ?? null,
      isApproval: true,
      projectId,
      projectName: project.name,
      requiresApproval: true,
      stageId,
      status: card.status,
    });
  }
  for (const [stageId, tasks] of result) {
    const latest = new Map();
    for (const task of tasks) {
      const key = `${task.projectId}:${task.contentItemId ?? "project"}`;
      const current = latest.get(key);
      if (!current || preferTask(task, current)) latest.set(key, task);
    }
    const tasksWithAttention = [...latest.values()].map((task) => ({ ...task, attention: taskAttention(task, { operation: operationByCard.get(task.card?.id ?? task.cardId), shelved: shelvedProjects.has(task.projectId), queue }) }));
    result.set(stageId, tasksWithAttention.sort((left, right) => attentionOrder(left.attention.kind) - attentionOrder(right.attention.kind) || String(left.projectName ?? "").localeCompare(String(right.projectName ?? ""))));
  }
  return result;
}

export function missingApprovalFor(instance, stage, contentItemId = null) {
  if (!stage?.approval?.before) return false;
  if (scopeAuthorizes(instance, stage.approval.before)) return false;
  const requiredScope = stage.approval.scope ?? "stage";
  return !(instance?.approvals ?? []).some((approval) =>
    approval.status === "approved" &&
    approval.stageId === stage.id &&
    (approval.contentItemId ?? null) === (contentItemId ?? null) &&
    approval.effect === stage.approval.before &&
    approval.scope === requiredScope &&
    (!approval.expiresAt || new Date(approval.expiresAt) > new Date())
  );
}

export function attentionOrder(kind) { return ({ "needs-you": 0, running: 1, healing: 2, queued: 3, stale: 4, done: 5 })[kind] ?? 6; }

function displayedTaskStatus(run, card) {
  const status = card?.status ?? run.status;
  if (status === "blocked" && run.failure?.automaticRetry && run.failure?.nextRetryAt) return "retry_wait";
  return status;
}

// What one project's lanes add up to: per visible stage, how many tasks it
// plans and how many are in each attention kind, and how many finished today.
export function projectTally(stages, instance, cards, now = Date.now(), queue = null) {
  const index = indexStageTasks(stages, [instance], cards, queue, now);
  const visible = new Set(visibleStages(stages, [instance]).map((stage) => stage.id));
  const tally = { progress: projectProgress(stages, instance), stages: {} };
  for (const stage of stages) {
    const tasks = index.get(stage.id) ?? [];
    if (!visible.has(stage.id) && !tasks.length) continue;
    const counts = {};
    for (const task of tasks) counts[task.attention.kind] = (counts[task.attention.kind] ?? 0) + 1;
    const today = tasks.filter((task) => task.attention.kind === "done" && isToday(task.card?.updatedAt ?? task.updatedAt, now)).length;
    tally.stages[stage.id] = { planned: stageExpected(stage, [instance]), counts, ...(today ? { today } : {}) };
  }
  return tally;
}

// A tallied project's counts, like countByKind over its tasks, for the given
// stages or all of them; `tasks` and `today` come along.
export function tallyCounts(instance, stageIds = null) {
  const result = { ...countByKind([]), tasks: 0, today: 0 };
  for (const [stageId, stage] of Object.entries(instance?.tally?.stages ?? {})) {
    if (stageIds && !stageIds.has(stageId)) continue;
    for (const [kind, count] of Object.entries(stage.counts)) {
      result[kind] = (result[kind] ?? 0) + count;
      result.tasks += count;
    }
    result.today += stage.today ?? 0;
  }
  return result;
}

// One stage across the tallied projects among `instances`.
export function stageTally(instances, stageId) {
  return tallyCounts({ tally: { stages: Object.fromEntries(instances.filter((instance) => instance.tally?.stages?.[stageId]).map((instance, index) => [index, instance.tally.stages[stageId]])) } });
}
