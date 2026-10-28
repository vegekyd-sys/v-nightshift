// The dashboard's polling payload. /api/bootstrap sent every card and project
// in full: 48 MB every 30 seconds on V (2026-09-28), almost all of it Agent
// briefs, card events, comments and old workflow sources that the pages only
// need for one card at a time. This keeps what the pages draw and nothing
// else; detail is fetched when a card or workflow is opened.
import { projectScope } from "../client/src/attention.js";
import { stageEnabled } from "../../../packages/nightshift-core/src/workflow.mjs";

export const OVERVIEW_SCOPES = ["live", "paused", "delivered", "shelved", "all"];

const CARD_LABEL_PREFIXES = ["instance:", "stage:", "content-item:", "route:", "nightshift:"];
const AUTOMATION_FIELDS = ["instanceId", "stageId", "contentItemId", "scheduledAt", "contentRoute", "agentRole", "attempt", "workflowSha256", "workflowCall"];
const INPUT_FIELDS = ["targetCount", "deliveryMode", "authorizationScope", "publicationTarget"];
const FAILURE_FIELDS = ["kind", "source", "retryable", "automaticRetry", "nextRetryAt", "validationPhase"];

export function buildOverview({ scope = "live", instances, cards, releases, operationsFor, skippedFor, now = Date.now() }) {
  const wanted = OVERVIEW_SCOPES.includes(scope) ? scope : "live";
  const visible = instances.filter((instance) => instance.status !== "archived");
  const detailed = new Set(visible.filter((instance) => wanted === "all" || projectScope(instance, now) === wanted).map((instance) => instance.id));
  const usedShas = new Set(visible.filter((instance) => detailed.has(instance.id)).map((instance) => instance.workflowSha256));
  const latestShas = latestReleaseShas(releases);
  const stagesBySha = new Map(releases.map((release) => [release.workflowSha256, release.manifest?.spec?.stages]));
  // Counts the pages show for scopes they did not load: a tab's size, and each
  // agent's finished work today across every project.
  const scopeOf = new Map(visible.map((instance) => [instance.id, projectScope(instance, now)]));
  const cardCounts = { live: 0, paused: 0, delivered: 0, shelved: 0, all: 0 };
  const agentDoneToday = {};
  const workStartedAt = new Map();
  for (const card of cards) {
    const state = scopeOf.get(cardInstanceId(card));
    if (!state) continue;
    const started = cardStartedAt(card);
    if (started && !(workStartedAt.get(cardInstanceId(card)) <= started)) workStartedAt.set(cardInstanceId(card), started);
    cardCounts[state] += 1;
    cardCounts.all += 1;
    if (card.status === "done" && card.agentId && sameDay(card.updatedAt, now)) agentDoneToday[card.agentId] = (agentDoneToday[card.agentId] ?? 0) + 1;
  }
  return {
    scope: wanted,
    cardCounts,
    agentDoneToday,
    instances: visible.map((instance) => detailed.has(instance.id)
      ? leanProject(instance, operationsFor?.(instance.id) ?? [], skippedFor?.(instance.id) ?? [], workStartedAt.get(instance.id), stagesBySha.get(instance.workflowSha256))
      : projectSummary(instance, workStartedAt.get(instance.id))),
    cards: cards.filter((card) => detailed.has(cardInstanceId(card))).map(leanCard),
    workflows: releases.map((release) => usedShas.has(release.workflowSha256) || latestShas.has(release.workflowSha256)
      ? leanRelease(release)
      : releaseSummary(release)),
  };
}

export function leanCard(card) {
  const automation = card.metadata?.automation ?? {};
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    agentId: card.agentId,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    labels: (card.labels ?? []).filter((label) => CARD_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))),
    metadata: { automation: pick(automation, AUTOMATION_FIELDS) },
    humanAttempt: card.humanAttempt ?? null,
    links: card.links,
  };
}

export function leanRun(run) {
  const failure = run.failure
    ? { ...pick(run.failure, FAILURE_FIELDS), rawError: typeof run.failure.rawError === "string" ? run.failure.rawError.slice(0, 200) : undefined }
    : null;
  return {
    stageId: run.stageId,
    contentItemId: run.contentItemId ?? null,
    attempt: run.attempt,
    cardId: run.cardId ?? null,
    status: run.status,
    updatedAt: run.updatedAt,
    failure,
  };
}

function leanProject(instance, operations, skipped = [], workStartedAt = null, stages) {
  return {
    ...projectSummary(instance, workStartedAt),
    detail: true,
    inputs: pick(instance.inputs ?? {}, INPUT_FIELDS),
    // Evaluate against full inputs on the server, using the engine's semantics.
    // The board needs branch facts, never the (possibly secret) input values.
    ...(stages ? { stageConditions: Object.fromEntries(stages.map((stage) => [stage.id, stageEnabled(stage, instance.inputs ?? {})])) } : {}),
    calls: instance.calls ?? [],
    approvals: instance.approvals ?? [],
    contentItems: (instance.contentItems ?? []).map((item) => pick(item, ["id", "title", "route", "status"])),
    contentItemRuns: (instance.contentItemRuns ?? []).map(leanRun),
    stageRuns: (instance.stageRuns ?? []).map(leanRun),
    operations: operations.map((operation) => pick(operation, ["ownerCardId", "status", "updatedAt"])),
    // Items a person decided not to deliver (#115): out of the project, so the
    // board neither waits on them nor counts them.
    skippedContentItems: skipped.map((entry) => ({ contentItemId: entry.contentItemId, reason: typeof entry.reason === "string" ? entry.reason.slice(0, 200) : null })),
  };
}

function projectSummary(instance, workStartedAt = null) {
  return {
    detail: false,
    ...pick(instance, ["id", "name", "status", "createdAt", "updatedAt", "workflowSha256", "control", "agentBindings", "links"]),
    // When an Agent first worked on the project. A project's first card exists from the moment it is
    // created but waits in the queue until a slot frees; on V (2026-10-20) DL-1020-05 was created
    // at 16:23 and its first card started at 20:27, so createdAt alone read as "running 4 hours".
    workStartedAt: workStartedAt ? new Date(workStartedAt).toISOString() : null,
    // Enough to size a project bar before its detail loads.
    inputs: pick(instance.inputs ?? {}, ["targetCount", "deliveryMode"]),
  };
}

function leanRelease(release) {
  const spec = release.manifest?.spec ?? {};
  return {
    ...releaseSummary(release),
    manifest: {
      spec: {
        ownerAgentRole: spec.ownerAgentRole,
        inputs: spec.inputs,
        stages: (spec.stages ?? []).map((stage) => pick(stage, ["id", "title", "scope", "actor", "when", "approval", "agentRole"])),
      },
    },
  };
}

function releaseSummary(release) {
  return pick(release, ["workflowId", "name", "version", "workflowSha256", "publishedAt", "links"]);
}

function latestReleaseShas(releases) {
  const latest = new Map();
  for (const release of releases) {
    const current = latest.get(release.workflowId);
    if (!current || String(release.publishedAt ?? "") > String(current.publishedAt ?? "")) latest.set(release.workflowId, release);
  }
  return new Set([...latest.values()].map((release) => release.workflowSha256));
}

function sameDay(value, now) {
  const at = new Date(typeof value === "number" ? value : Date.parse(value ?? 0));
  const today = new Date(now);
  return at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
}

function cardInstanceId(card) {
  return card.metadata?.automation?.instanceId ??
    (card.labels ?? []).find((label) => label.startsWith("instance:"))?.slice("instance:".length) ??
    null;
}

function pick(value, fields) {
  const result = {};
  for (const field of fields) if (value?.[field] !== undefined) result[field] = value[field];
  return result;
}

// The first time an Agent picked the card up (epoch ms), or null while it waits in the queue.
function cardStartedAt(card) {
  const candidates = [card.startedAt, card.execution?.startedAt, ...(card.metadata?.attempts ?? []).map((attempt) => attempt?.startedAt)];
  const times = candidates.map((value) => (typeof value === "number" ? value : Date.parse(value ?? ""))).filter((value) => Number.isFinite(value) && value > 0);
  return times.length ? Math.min(...times) : null;
}
