import { createHash } from "node:crypto";
import { infrastructureFailureSummary } from "./failure-policy.mjs";

// 需要你: everything only a person can move. The engine owns this queue; the
// board, the Feishu notice and nightshiftctl all read it. See
// docs/nightshift-needs-human-design.md.

const DAY_MS = 86_400_000;
const BASELINE_KEY = "needs-you-v1.baseline";
const OPERATION_UNDER_WAY = new Set(["reserved", "executing"]);
const MOVED_ON = new Set(["ready", "running", "done", "review", "scheduled", "todo", "backlog"]);

// Choices every stop offers. Skip arrives with step 2 (a terminal item state).
export const STOP_OPTIONS = Object.freeze([
  Object.freeze({ id: "retry", label: "重新执行", effect: "retry" }),
  Object.freeze({ id: "pause", label: "暂停项目", effect: "pause" }),
]);

// Approvals and human review stages keep their own endpoints and choices.
export const REVIEW_OPTIONS = Object.freeze([
  Object.freeze({ id: "approve", label: "通过", effect: "approve" }),
  Object.freeze({ id: "request-changes", label: "要求修改", effect: "request-changes" }),
  Object.freeze({ id: "reject", label: "拒绝", effect: "reject" }),
]);

export class NeedsYouTracker {
  constructor({ store, graceMs = 120_000, shelveAfterMs = 3 * DAY_MS, now = () => Date.now() }) {
    if (!store) throw new Error("NeedsYouTracker requires a store");
    this.store = store;
    this.graceMs = graceMs;
    this.shelveAfterMs = shelveAfterMs;
    this.now = now;
    this.blockedSince = new Map();
    this.pending = new Map();
  }

  // Blocked cards that existed before this tracker first ran are history: on V
  // (2026-09-28) the board held 500+ of them, 94 in 44 shelved projects. The
  // first run records the moment and opens nothing for anything older.
  baselineAt() {
    const existing = this.store.getNotificationMetadata(BASELINE_KEY);
    if (existing?.at) return Date.parse(existing.at);
    const at = new Date(this.now());
    this.store.setNotificationMetadata(BASELINE_KEY, { at: at.toISOString() }, at);
    return at.getTime();
  }

  // Called for every card a reconcile pass projected, with the pass's verdict.
  observe({ card, instance, stage, stageId, contentItemId = null, status, failure = null, summary = null, operation = null }) {
    const now = this.now();
    if (status !== "blocked") {
      this.blockedSince.delete(card.id);
      this.pending.delete(card.id);
      if (MOVED_ON.has(status)) this.store.supersedeDecisionRequests(card.id, {}, new Date(now));
      return null;
    }
    const attempt = String(cardAttempt(card));
    // A new attempt that blocked again replaces the request of the old one.
    this.store.supersedeDecisionRequests(card.id, { exceptAttempt: attempt }, new Date(now));
    const existing = this.store.getDecisionRequestForCard(card.id, attempt);
    if (existing) {
      this.pending.delete(card.id);
      return existing;
    }
    if (!eligibleProject(instance, now, this.shelveAfterMs)) return null;
    if (cardTouchedAt(card) < this.baselineAt()) return null;
    // The engine retries it; nobody needs to act.
    if (failure?.automaticRetry) return null;
    // Paid work still under way with no recorded stop: #80 turns a silent run
    // into a failure, which then lands here.
    if (!failure && operation && OPERATION_UNDER_WAY.has(operation.status)) return null;
    if (!failure) {
      const since = this.blockedSince.get(card.id) ?? now;
      this.blockedSince.set(card.id, since);
      if (now - since < this.graceMs) {
        this.pending.set(card.id, { cardId: card.id, instanceId: instance.id, until: new Date(since + this.graceMs).toISOString() });
        return null;
      }
    }
    this.pending.delete(card.id);
    const { problem, detail } = describeStop({ failure, summary });
    return this.store.openDecisionRequest({
      instanceId: instance.id,
      cardId: card.id,
      contentItemId,
      stageId,
      attempt,
      source: "engine",
      problem,
      detail,
      evidence: { failure, summary, operation: operation ? { status: operation.status, externalTaskId: operation.externalTaskId ?? null } : null },
      scope: stage?.scope === "content-item" ? "item" : "project",
      options: STOP_OPTIONS,
      groupKey: groupKey({ instanceId: instance.id, stageId, failure, problem }),
    }, new Date(now));
  }

  pendingList() {
    return [...this.pending.values()];
  }
}

// The 需要你 queue as the board reads it: open decision requests plus review
// cards waiting on a person, for every project that is not shelved.
export function buildNeedsYou({ store, instances, cards, releases, pending = [], now = Date.now(), shelveAfterMs = 3 * DAY_MS }) {
  const eligible = new Map(instances.filter((instance) => eligibleProject(instance, now, shelveAfterMs)).map((instance) => [instance.id, instance]));
  const stagesBySha = new Map(releases.map((release) => [release.workflowSha256 ?? release.metadata?.workflowSha256, release.manifest?.spec?.stages ?? release.spec?.stages ?? []]));
  const requests = store.listDecisionRequests({ status: "open" }).filter((request) => eligible.has(request.instanceId));
  const groupSizes = new Map();
  for (const request of requests) groupSizes.set(request.groupKey, (groupSizes.get(request.groupKey) ?? 0) + 1);
  const items = requests.map((request) => ({
    id: request.id,
    kind: "decision",
    instanceId: request.instanceId,
    cardId: request.cardId,
    contentItemId: request.contentItemId,
    stageId: request.stageId,
    problem: truncate(request.problem, 200),
    scope: request.scope,
    groupKey: request.groupKey,
    groupSize: groupSizes.get(request.groupKey) ?? 1,
    options: request.options.map(({ id, label, effect }) => ({ id, label, effect })),
    createdAt: request.createdAt,
  }));
  for (const card of cards) {
    if (card.status !== "review") continue;
    const instanceId = label(card, "instance");
    const instance = eligible.get(instanceId);
    if (!instance) continue;
    const stageId = label(card, "stage");
    const approval = (card.labels ?? []).includes("nightshift:approval");
    const stage = (stagesBySha.get(instance.workflowSha256) ?? []).find((entry) => entry.id === stageId);
    if (!approval && stage?.actor !== "human") continue;
    items.push({
      id: `${approval ? "approval" : "review"}:${card.id}`,
      kind: approval ? "approval" : "review",
      instanceId,
      cardId: card.id,
      contentItemId: label(card, "content-item"),
      stageId,
      problem: truncate(card.title ?? (approval ? "等你确认" : "等你审核"), 200),
      scope: label(card, "content-item") ? "item" : "project",
      groupKey: `${instanceId}:${approval ? "approval" : "review"}:${stageId}`,
      groupSize: 1,
      options: REVIEW_OPTIONS.map(({ id, label: text, effect }) => ({ id, label: text, effect })),
      createdAt: new Date(Number(card.updatedAt ?? card.createdAt ?? now)).toISOString(),
    });
  }
  const reviewGroups = new Map();
  for (const item of items) if (item.kind !== "decision") reviewGroups.set(item.groupKey, (reviewGroups.get(item.groupKey) ?? 0) + 1);
  for (const item of items) if (item.kind !== "decision") item.groupSize = reviewGroups.get(item.groupKey);
  const countsByInstance = {};
  for (const item of items) countsByInstance[item.instanceId] = (countsByInstance[item.instanceId] ?? 0) + 1;
  return {
    items,
    pending: pending.filter((entry) => eligible.has(entry.instanceId)),
    countsByInstance,
  };
}

// Active, or paused and touched within the last few days. A project paused and
// untouched for longer is shelved: history, not work waiting on anyone.
export function eligibleProject(instance, now = Date.now(), shelveAfterMs = 3 * DAY_MS) {
  if (!instance) return false;
  if (instance.status === "active") return true;
  if (instance.status !== "paused") return false;
  return now - Date.parse(instance.updatedAt ?? instance.createdAt ?? 0) <= shelveAfterMs;
}

// What the person reads first. The Agent's own words beat the engine's
// classification: on DL-0928-07 the recorded failure said "External side effect
// has no succeeded checkpoint" while the Agent had written exactly why Makaron
// could not fetch the footage.
export function describeStop({ failure = null, summary = null }) {
  if (failure?.agentReport) {
    return { problem: firstSentence(failure.agentReport), detail: String(failure.agentReport) };
  }
  if (failure) {
    const text = failure.kind && failure.kind !== "contract_error"
      ? infrastructureFailureSummary(failure)
      : (summary || failure.rawError || failure.message || "产物没有通过完成校验");
    return { problem: firstSentence(text), detail: [summary, failure.rawError].filter(Boolean).join("\n\n") };
  }
  const text = String(summary ?? "").trim();
  return { problem: text ? firstSentence(text) : "Agent 停下了，没有给出原因", detail: text };
}

// Requests with the same root cause share a key: same project, stage and kind
// of stop, and the same problem once ids and numbers are removed.
export function groupKey({ instanceId, stageId, failure, problem }) {
  const shape = String(problem ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  const digest = createHash("sha256").update(`${stageId}\u0000${failure?.kind ?? "stopped"}\u0000${shape}`).digest("hex").slice(0, 12);
  return `${instanceId}:${stageId}:${digest}`;
}

export function cardAttempt(card) {
  return card.runId ?? card.execution?.runId ?? card.metadata?.automation?.attempt ?? 1;
}

function cardTouchedAt(card) {
  const value = card.updatedAt ?? card.execution?.updatedAt ?? card.createdAt ?? 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(String(value)) || 0;
}

function firstSentence(text) {
  const plain = String(text ?? "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^>\s*/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^[-*]\s*$/.test(line));
  const joined = plain.join(" ").replace(/\s+/g, " ").trim();
  const stop = joined.search(/[。！？]|\.\s/);
  const sentence = stop >= 20 ? joined.slice(0, stop + 1) : joined;
  return truncate(sentence, 200);
}

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function label(card, prefix) {
  return card.labels?.find((entry) => entry.startsWith(`${prefix}:`))?.slice(prefix.length + 1) ?? null;
}
