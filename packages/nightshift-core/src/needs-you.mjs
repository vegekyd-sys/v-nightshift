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
  Object.freeze({ id: "retry", label: "重新执行", effect: "retry", description: "按原任务再跑一次，可以附一句话给 agent（比如「已补素材」）" }),
  Object.freeze({ id: "pause", label: "暂停项目", effect: "pause", description: "不再派新任务，问题解决后再恢复" }),
]);

// Approvals and human review stages keep their own endpoints and choices.
export const REVIEW_OPTIONS = Object.freeze([
  Object.freeze({ id: "approve", label: "通过", effect: "approve", description: "确认结果，流程继续" }),
  Object.freeze({ id: "request-changes", label: "要求修改", effect: "request-changes", description: "写明要改什么，agent 按意见重做" }),
  Object.freeze({ id: "reject", label: "拒绝", effect: "reject", description: "不采用这条结果" }),
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

  // The moment this tracker first ran. A stop older than that still enters the
  // queue (the board must show it), but it is not announced: the notice is for
  // what newly needs someone. The 500+ historical blocked cards on V
  // (2026-09-28) sit in shelved projects, which eligibleProject already skips.
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
      // A request opened before the Agent's report was known is rewritten once
      // the report arrives, so the person reads the Agent's words.
      if (existing.status === "open" && existing.source === "engine" && failure?.agentReport && !existing.evidence?.failure?.agentReport) {
        const text = describeStop({ failure, summary });
        return this.store.updateDecisionRequestText(existing.id, { ...text, evidence: { ...existing.evidence, failure } }, new Date(now));
      }
      return existing;
    }
    if (!eligibleProject(instance, now, this.shelveAfterMs)) return null;
    const beforeBaseline = cardTouchedAt(card) < this.baselineAt();
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
    const { problem, cause, impact, suggestion, detail } = describeStop({ failure, summary });
    const request = this.store.openDecisionRequest({
      instanceId: instance.id,
      cardId: card.id,
      contentItemId,
      stageId,
      attempt,
      source: "engine",
      problem,
      cause,
      impact,
      suggestion,
      detail,
      evidence: { failure, summary, operation: operation ? { status: operation.status, externalTaskId: operation.externalTaskId ?? null } : null },
      scope: stage?.scope === "content-item" ? "item" : "project",
      options: STOP_OPTIONS,
      groupKey: groupKey({ instanceId: instance.id, stageId, failure, problem }),
    }, new Date(now));
    if (beforeBaseline && !request.reused) this.store.markDecisionRequestsAnnounced([request.id], new Date(now));
    return this.store.getDecisionRequest(request.id);
  }

  pendingList() {
    return [...this.pending.values()];
  }

  // Whether the engine should read this card's Agent Session for a report:
  // it will (or already does) need a person and its request lacks the Agent's words.
  wantsReport({ card, instance }) {
    if (!eligibleProject(instance, this.now(), this.shelveAfterMs)) return false;
    const existing = this.store.getDecisionRequestForCard(card.id, String(cardAttempt(card)));
    if (existing && (existing.status !== "open" || existing.evidence?.failure?.agentReport)) return false;
    return true;
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

// What the person reads: what happened, why, the impact and what to do. The
// Agent's own words beat the engine's classification: on DL-0928-07 the
// recorded failure said "External side effect has no succeeded checkpoint"
// while the Agent had written exactly why Makaron could not fetch the footage.
// An Agent that stops writes its report under the labels 问题 / 原因 / 影响 /
// 建议 (the operator skill asks for it); unlabeled reports fall back to their
// sentences, and a missing suggestion to one that fits the kind of stop.
export function describeStop({ failure = null, summary = null }) {
  if (failure?.agentReport) {
    const report = String(failure.agentReport);
    const sections = labeledSections(report);
    const sentences = splitSentences(report);
    const problem = truncate(sections.problem || firstSentence(report), 200);
    const cause = truncate(sections.cause || sentences.find((sentence) => /原因|因为|由于|失败点|根因|导致/.test(sentence)) || "", 300);
    return {
      problem,
      cause: sameText(cause, problem) ? "" : cause,
      impact: truncate(sections.impact || "", 300),
      suggestion: truncate(sections.suggestion || sentences.find((sentence) => /建议|需要人工|请人工|应当|下一步/.test(sentence)) || defaultSuggestion(failure), 300),
      detail: report,
    };
  }
  if (failure) {
    if (failure.kind && failure.kind !== "contract_error") {
      return {
        problem: firstSentence(infrastructureFailureSummary(failure)),
        cause: "",
        impact: "",
        suggestion: defaultSuggestion(failure),
        detail: [summary, failure.rawError].filter(Boolean).join("\n\n"),
      };
    }
    const explained = explainContractError(failure.rawError || summary || failure.message || "");
    return {
      ...explained,
      impact: "",
      detail: [summary, failure.rawError].filter(Boolean).join("\n\n"),
    };
  }
  const text = String(summary ?? "").trim();
  return {
    problem: text ? firstSentence(text) : "Agent 停下了，没有给出原因",
    cause: "",
    impact: "",
    suggestion: defaultSuggestion(null),
    detail: text,
  };
}

// The engine's own completion checks, in words a person can act on. The
// English original stays in the request's detail.
const CONTRACT_EXPLANATIONS = [
  {
    pattern: /external side effect has no succeeded|operation checkpoint|ledger/i,
    problem: "外部操作（付费生成、发布或上传）没有成功记录，无法确认它是否真的完成了",
    cause: "agent 结束时，台账里没有这一步外部操作的成功记录。",
    suggestion: "先看 agent 的记录，确认外部平台上这一步成没成：没成就「重新执行」；如果其实成了只是没记上，需要人工核对后再继续。",
  },
  {
    pattern: /must stay inside the instance directory|outside the (instance|project)/i,
    problem: "agent 交付的文件放到了项目目录之外，引擎不接受",
    cause: "产物路径不在这个项目自己的目录里，可能是 agent 写错了路径。",
    suggestion: "「重新执行」，让 agent 按规定的目录重新交付；如果反复出现，需要看它的记录。",
  },
  {
    pattern: /artifact not found|declared output .* is missing|is not a file/i,
    problem: "缺少这一步应该交付的产物文件",
    cause: "agent 结束时，约定要交付的文件不存在。",
    suggestion: "「重新执行」；如果反复缺同一个文件，说明这一步做不出来，需要看 agent 的记录判断原因。",
  },
  {
    pattern: /handoff/i,
    problem: "这一步没有写好交给下一步的交接记录",
    cause: "交接记录缺失或格式不对，下一步拿不到它需要的内容。",
    suggestion: "「重新执行」，让 agent 补齐交接记录。",
  },
  {
    pattern: /completion rule failed|does not equal the workflow contract|does not match|host .* is not allowed/i,
    problem: "产物没有通过这一步的验收条件",
    cause: "交付的内容和 Workflow 约定的验收条件不一致。",
    suggestion: "看一下 agent 的记录和产物：能修正就「重新执行」，条件本身不合理就需要改 Workflow。",
  },
  {
    pattern: /evidence|skill/i,
    problem: "执行过程缺少证据，引擎无法确认这一步按要求完成",
    cause: "agent 没有留下 Workflow 要求的执行证据（比如读取声明的技能）。",
    suggestion: "「重新执行」；如果反复出现，需要检查这一步挂的技能是否可用。",
  },
];

function explainContractError(raw) {
  const text = String(raw ?? "").replace(/^(Completion validation failed|Terminal Agent Session did not satisfy the Workflow output contract):\s*/i, "");
  const match = CONTRACT_EXPLANATIONS.find((entry) => entry.pattern.test(text));
  if (match) return { problem: match.problem, cause: match.cause, suggestion: match.suggestion };
  return {
    problem: "产物没有通过完成校验",
    cause: text ? `引擎的原始说明：${truncate(text, 200)}` : "",
    suggestion: defaultSuggestion({ kind: "contract_error" }),
  };
}

function sameText(left, right) {
  const normalize = (value) => String(value ?? "").replace(/[\s。，,.]/g, "");
  return Boolean(left) && normalize(left) === normalize(right);
}

const SECTION_LABELS = [
  ["problem", /^(问题|发生了什么|结论|现象)$/],
  ["cause", /^(原因|为什么|根因|根本原因)$/],
  ["impact", /^(影响|影响范围)$/],
  ["suggestion", /^(建议|建议怎么做|建议人工处置|下一步|处理建议)$/],
];

function labeledSections(text) {
  const sections = {};
  let current = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\*\*|__|`/g, "").replace(/^\s*(#+|>|[-*·•]|\d+[.)、])\s*/, "").trim();
    const match = line.match(/^([^：:]{1,8})[：:]\s*(.*)$/);
    const label = match ? SECTION_LABELS.find(([, pattern]) => pattern.test(match[1].trim()))?.[0] : null;
    if (label) {
      current = label;
      sections[label] = match[2] ? [match[2]] : [];
      continue;
    }
    if (current && line) sections[current].push(line);
    if (current && !line && sections[current].length) current = null;
  }
  return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join(" ").replace(/\s+/g, " ").trim()]));
}

function splitSentences(text) {
  return String(text)
    .replace(/\*\*|__|`/g, "")
    .split(/(?<=[。！？])|\n/)
    .map((sentence) => sentence.replace(/^\s*(#+|>|[-*·•]|\d+[.)、])\s*/, "").trim())
    .filter((sentence) => sentence.length >= 6);
}

function defaultSuggestion(failure) {
  if (!failure) return "打开卡片看 agent 的记录，判断能否补齐条件：能补齐就「重新执行」，暂时补不了就「暂停项目」。";
  if (failure.kind && failure.kind !== "contract_error") return "系统已经自动重试过仍然失败：确认 V 和相关服务正常后选「重新执行」。";
  return "看一下 agent 的记录：条件补齐后选「重新执行」，暂时补不了就「暂停项目」。";
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
