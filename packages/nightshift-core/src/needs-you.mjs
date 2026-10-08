import { createHash } from "node:crypto";
import { infrastructureFailureSummary } from "./failure-policy.mjs";

// 需要你: everything only a person can move. The engine owns this queue; the
// board, the Feishu notice and nightshiftctl all read it. See
// docs/nightshift-needs-human-design.md.

const DAY_MS = 86_400_000;
const BASELINE_KEY = "needs-you-v1.baseline";
// Bumped whenever the words a request shows are produced differently, so open
// requests are rewritten under the current rules instead of keeping old text.
export const DESCRIBE_VERSION = 3;
const OPERATION_UNDER_WAY = new Set(["reserved", "executing"]);
const MOVED_ON = new Set(["ready", "running", "done", "review", "scheduled", "todo", "backlog"]);

// Choices every stop offers. A stop on one content item may also skip that
// item: the rest of the project delivers without it. "暂停项目" stops the whole
// project, which is not what a person looking at one missing video wants
// (Tianyi, 2026-09-30, on DL-0929-10's missing smoke-test footage).
export const SKIP_OPTION = Object.freeze({
  id: "skip",
  label: "跳过这一条",
  effect: "skip",
  description: "这一条不做了，其余照常交付；完成通知会写明跳过了哪条、为什么",
});
export const STOP_OPTIONS = Object.freeze([
  Object.freeze({ id: "retry", label: "重新执行", effect: "retry", description: "按原任务再跑一次，可以附一句话给 agent（比如「已补素材」）" }),
  Object.freeze({ id: "pause", label: "暂停项目", effect: "pause", description: "暂停整个项目：不再派任何新任务，问题解决后再恢复" }),
]);

// The choices a stop offers follow what the paid-operation ledger says. The
// ledger key of a card's external call carries the item's revision, not the
// attempt, so 「重新执行」 meets the same operation again: a reservation never
// submitted blocks again, a failed call stays failed, a succeeded one is
// reused (DL-1008-04 on V, 2026-10-08: 「重新执行」 on wsfood-es-28 looped).
// 「重做这一条」 gives the item a new revision, hence a new operation.
export function stopOptionsFor(scope, { stage = null, operation = null } = {}) {
  const ledger = ledgerOf(stage, operation);
  const retry = { ...STOP_OPTIONS[0], ...(ledger ? { description: retryDescription(ledger) } : {}) };
  const options = [];
  if (!ledger || !NO_NEW_ATTEMPT.has(ledger.state) || scope !== "item") options.push(Object.freeze(retry));
  if (scope === "item" && canRedo(ledger)) options.push(Object.freeze({ id: "redo", label: "重做这一条", effect: "redo", description: `从这一步重新做：${ledger.words.again}；附言会带给 agent（比如这次要怎么改）` }));
  if (scope === "item") options.push(SKIP_OPTION);
  options.push(STOP_OPTIONS[1]);
  return Object.freeze(options);
}

// Requests opened before skip existed still offer it when they concern one item.
export function currentOptions(request) {
  const options = Array.isArray(request?.options) ? request.options : [];
  if (request?.scope !== "item" || options.some((option) => option.effect === "skip")) return options;
  if (!options.some((option) => option.effect === "retry")) return options;
  const at = options.findIndex((option) => option.effect === "retry") + 1;
  return [...options.slice(0, at), SKIP_OPTION, ...options.slice(at)];
}

// Approvals and human review stages keep their own endpoints and choices.
export const REVIEW_OPTIONS = Object.freeze([
  Object.freeze({ id: "approve", label: "通过", effect: "approve", description: "确认结果，流程继续" }),
  Object.freeze({ id: "request-changes", label: "要求修改", effect: "request-changes", description: "写明要改什么：这一条按意见重做前面的步骤（含出片的会再花一次钱），做完再请你看" }),
  Object.freeze({ id: "reject", label: "拒绝", effect: "reject", description: "不采用这条结果" }),
]);

// A card blocked with no recorded failure has no verdict yet: the engine has
// not learned why it stopped. Such a card waits longer than the engine's own
// orphan rule (45 min), so the engine's verdict always comes first; a failure
// of the substrate is retried, not announced. Only a card nobody could explain
// in an hour reaches a person this way.
const UNEXPLAINED_GRACE_MS = 60 * 60_000;

export class NeedsYouTracker {
  constructor({ store, graceMs = UNEXPLAINED_GRACE_MS, shelveAfterMs = 3 * DAY_MS, now = () => Date.now() }) {
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
      const staleWords = existing.evidence?.describeVersion !== DESCRIBE_VERSION;
      const newReport = failure?.agentReport && !existing.evidence?.failure?.agentReport;
      const ledgerMoved = (existing.evidence?.operation?.status ?? null) !== (operation?.status ?? null);
      if (existing.status === "open" && existing.source === "engine" && failure && (staleWords || newReport || ledgerMoved)) {
        const text = describeStop({ failure, summary, operation, stage });
        return this.store.updateDecisionRequestText(existing.id, {
          ...text,
          options: stopOptionsFor(existing.scope, { stage, operation }),
          evidence: { ...existing.evidence, failure, operation: operationEvidence(operation), describeVersion: DESCRIBE_VERSION },
        }, new Date(now));
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
    const { problem, cause, impact, suggestion, detail } = describeStop({ failure, summary, operation, stage });
    const scope = stage?.scope === "content-item" ? "item" : "project";
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
      evidence: {
        failure,
        summary,
        operation: operationEvidence(operation),
        describeVersion: DESCRIBE_VERSION,
      },
      scope,
      options: stopOptionsFor(scope, { stage, operation }),
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
// Every Agent brief asks a stopping Agent to open its final message with the
// lines 问题 / 原因 / 影响 / 建议 (buildAgentBrief); reports without them fall
// back to their sentences, and to what the engine knows.
//
// For a stage with external side effects the engine knows more than any
// report: whether the call was registered, submitted (its external task id),
// failed or succeeded, and so whether 「重新执行」 can make a new attempt at
// all. Those facts lead what happened and the impact, and a suggestion that
// would loop is corrected before the Agent's own is shown.
export function describeStop({ failure = null, summary = null, operation = null, stage = null } = {}) {
  const ledger = ledgerOf(stage, operation);
  const scope = stage?.scope === "content-item" ? "item" : "project";
  const report = failure?.agentReport ? String(failure.agentReport) : "";
  const sections = report ? labeledSections(report) : {};
  const sentences = report ? splitSentences(report) : [];
  const agentCause = sections.cause || sentences.find((sentence) => CAUSE_WORDS.test(sentence)) || "";
  const agentSuggestion = sections.suggestion || sentences.find((sentence) => SUGGESTION_WORDS.test(sentence)) || "";
  const raw = failure?.rawError || summary || failure?.message || "";
  const contract = !failure?.kind || failure.kind === "contract_error";
  // The engine's check that refused the card. A missing handoff, artifact or
  // ledger success is what any Agent that stops leaves behind, so it says
  // nothing about why it stopped (wsfood-es-22 blocked on its QC and the card
  // read "没有写好交接记录"); a path or a completion rule it broke does.
  const check = failure && contract && raw ? explainContractError(raw) : null;
  const refusedBy = check && !STOP_LEFTOVER.test(raw) ? check.problem : null;
  const facts = ledger ? ledgerFacts(ledger, { scope, sideEffectRule: SIDE_EFFECT_RULE.test(raw), refusedBy }) : null;

  // What happened: the Agent's 问题, else what the ledger shows, else (for an
  // Agent that stopped on its own) its first sentence, else the engine's check.
  let problem;
  let engineLed = true;
  let explained = null;
  if (sections.problem) {
    problem = sections.problem;
    engineLed = false;
  } else if (facts?.problem) {
    problem = facts.problem;
  } else if (report && !contract) {
    problem = firstSentence(report);
    engineLed = false;
  } else if (failure && !contract) {
    problem = firstSentence(infrastructureFailureSummary(failure));
  } else if (failure) {
    // An unlabeled closing message is not a stop report: on V an Agent that
    // had published wrote "Card completed — ✅ PUBLISHED" while the engine
    // refused its artifact path. What the engine saw leads; the Agent's claim follows.
    explained = explainContractError(raw);
    problem = explained.problem;
  } else {
    const text = String(summary ?? "").trim();
    problem = text ? firstSentence(text) : "Agent 停下了，没有给出原因";
  }
  problem = truncate(problem, 200);

  // Why: the Agent's 原因, else the sentence of its report that says what
  // failed, else its first sentence; marked as the Agent's when the engine's
  // words lead.
  let cause = agentCause || (engineLed && report ? firstSentence(report) : "");
  if (!cause && explained) cause = explained.cause;
  else if (cause && engineLed && !sections.problem) cause = `agent 的说法：${cause}`;
  cause = truncate(cause, 300);
  if (sameText(cause, problem)) cause = "";

  const impact = truncate([facts?.impact, sections.impact].filter(Boolean).join(" "), 400);

  let suggestion;
  if (facts?.correctsRetry) {
    suggestion = `${facts.suggestion}${agentSuggestion ? ` agent 的建议：${truncate(agentSuggestion, 160)}` : ""}`;
  } else {
    suggestion = agentSuggestion || facts?.suggestion || explained?.suggestion || defaultSuggestion(failure);
  }

  return {
    problem,
    cause,
    impact,
    suggestion: truncate(suggestion, 480),
    detail: report || [summary, failure?.rawError].filter(Boolean).join("\n\n") || String(summary ?? "").trim(),
  };
}

const CAUSE_WORDS = /原因|因为|由于|失败|根因|导致|被拒|不可用|超时|failed|because|rejected|refused|\berror\b/i;
const SUGGESTION_WORDS = /建议|需要人工|请人工|应当|下一步/;
const SIDE_EFFECT_RULE = /external side effect has no succeeded|operation checkpoint|ledger/i;
const STOP_LEFTOVER = /external side effect has no succeeded|operation checkpoint|ledger|handoff|artifact not found|declared output .* is missing|is not a file/i;
// Ledger states in which 「重新执行」 cannot start a new external call.
const NO_NEW_ATTEMPT = new Set(["unsubmitted", "unknown", "failed"]);

// The ledger's answer for this card's external call, in the words of the
// stage's side effect. Null when the stage has none.
function ledgerOf(stage, operation) {
  const effects = Array.isArray(stage?.sideEffects) ? stage.sideEffects : [];
  if (effects.length === 0) return null;
  const words = effects.includes("paid-production")
    ? { noun: "付费生成", verb: "生成", again: "新开一次生成，会再付一次钱", spent: "钱已经花了" }
    : effects.includes("external-publication")
      ? { noun: "发布", verb: "发布", again: "重新提交一次发布", spent: "已经发布出去了" }
      : { noun: "外部操作", verb: "执行外部操作", again: "新开一次外部操作，上一次的不再沿用", spent: "外部操作已经生效" };
  const paidOnly = effects.every((effect) => effect === "paid-production");
  if (!operation) return { state: "none", words, paidOnly };
  const taskId = operation.externalTaskId ?? null;
  const reason = resultReason(operation.result);
  if (operation.status === "succeeded") return { state: "succeeded", taskId, words, paidOnly };
  if (operation.status === "failed") return { state: "failed", taskId, reason, words, paidOnly };
  if (operation.status === "executing" && taskId) return { state: "executing", taskId, words, paidOnly };
  if (operation.status === "unknown") return { state: "unknown", taskId, words, paidOnly };
  return { state: "unsubmitted", taskId: null, words, paidOnly };
}

// A new revision makes a new external call. After a success that is only
// wanted for paid generation (a result that did not pass its checks); a
// second publication of a published post is never what a person meant.
function canRedo(ledger) {
  if (!ledger) return false;
  if (NO_NEW_ATTEMPT.has(ledger.state)) return true;
  return ledger.state === "succeeded" && ledger.paidOnly;
}

function retryDescription(ledger) {
  const { noun, verb } = ledger.words;
  switch (ledger.state) {
    case "none": return `按原任务再跑一次：还没有提交过${noun}，不会重复扣费；可以附一句话给 agent（比如「已修好代理」）`;
    case "executing": return `接着查外部任务 ${ledger.taskId} 的结果：不重新提交，也不会再扣费`;
    case "succeeded": return `沿用已经成功的结果（外部任务 ${ledger.taskId}），不会再${verb}、不会再扣费，只让 agent 补齐交付`;
    default: return `按原任务再跑一次：同一个登记不会重新提交${noun}`;
  }
}

function ledgerFacts(ledger, { scope, sideEffectRule, refusedBy = null }) {
  const { noun, verb, again, spent } = ledger.words;
  const task = ledger.taskId ? `外部任务 ${ledger.taskId}` : "";
  const redo = scope === "item" && canRedo(ledger);
  const skip = scope === "item" ? "；这一条不做了就「跳过这一条」" : "";
  switch (ledger.state) {
    case "none":
      return {
        problem: sideEffectRule ? `${noun}没有提交，这一步停下了` : null,
        impact: `没有登记过${noun}：没有提交，也没有扣费。`,
        suggestion: `还没有提交过${noun}，「重新执行」不会重复扣费：先把 agent 说的问题处理好，再「重新执行」${skip}。`,
      };
    case "executing":
      return {
        problem: `${noun}已经提交（${task}），还没有记下结果`,
        impact: `${task} 已经提交，可能已经扣费；结果还没有记下来。`,
        suggestion: `「重新执行」会接着查${task} 的结果，不会重新提交，也不会再扣费。`,
      };
    case "succeeded":
      return {
        problem: `${noun}已经成功（${task}），但${refusedBy ? `${/^[A-Za-z]/.test(refusedBy) ? " " : ""}${refusedBy}` : "没有通过这一步的验收"}`,
        impact: `${task} 已经成功，${spent}。`,
        correctsRetry: true,
        suggestion: `「重新执行」只会沿用这次的结果，不会重新${verb}：问题只在交付（交接记录、文件位置）时用它。${redo
          ? `问题在结果本身（比如没过质检）就选「重做这一条」：${again}${skip}。`
          : "结果本身有问题需要人工处理。"}`,
      };
    case "failed":
      return {
        problem: `${noun}失败了${task ? `（${task}）` : ""}${ledger.reason ? `：${ledger.reason}` : ""}`,
        impact: `${task ? `${task} ` : noun}已经提交并失败：可能已经扣费，以外部平台为准。`,
        correctsRetry: true,
        suggestion: `「重新执行」不会重新${verb}：这次${noun}已经失败，同一个登记不会再提交。${redo
          ? `要再${verb}一次就选「重做这一条」（${again}）${skip.replace("；这一条不做了", "；不想再花钱")}。`
          : "需要有人在外部平台核对后处理，或者「暂停项目」。"}`,
      };
    case "unknown":
      return {
        problem: `${noun}的结果不明${task ? `（${task}）` : ""}`,
        impact: `${task ? `${task} ` : noun}的结果没有记下来：可能已经扣费，以外部平台为准。`,
        correctsRetry: true,
        suggestion: `先在外部平台核对${task ? `${task} ` : "这一步"}的结果。「重新执行」会再停在这里。${redo
          ? `确认它没有成功后选「重做这一条」（${again}）${skip}。`
          : "确认后需要人工处理台账，或者「暂停项目」。"}`,
      };
    default:
      return {
        problem: `${noun}登记了，但没有提交出去（台账上没有外部任务号）`,
        impact: "台账上只有登记、没有外部任务号：引擎没有看到它被提交，也没有扣费记录。",
        correctsRetry: true,
        suggestion: `「重新执行」会再停在同一个登记上，不会提交（同一个登记不能安全地重新提交）。${redo
          ? `先确认外部平台上确实没有这一条的任务（agent 的报告里通常已经查过），再选「重做这一条」：${again}${skip}。`
          : "需要有人在外部平台核对后处理台账，或者「暂停项目」。"}`,
      };
  }
}

// What a failed call's recorded result says went wrong, when it says so in a
// field any provider would use.
function resultReason(result) {
  if (!result || typeof result !== "object") return "";
  const value = [result.reason, result.error, result.message].find((entry) => typeof entry === "string" && entry.trim());
  return value ? truncate(value.trim(), 120) : "";
}

function operationEvidence(operation) {
  return operation ? { status: operation.status, externalTaskId: operation.externalTaskId ?? null } : null;
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
// The headings Agents wrote in English before the brief asked for the four
// lines (DL-1008-04: "**Why blocked — machine QC failed …:**", "## Recommended
// human action"). A label must end the line or be followed by a separator, so
// a sentence that merely starts with "Next step is …" is not one.
const ENGLISH_LABELS = [
  ["cause", /^(why blocked|why it (?:stopped|blocked)|root cause|cause|reason|blocker)\b/i],
  ["impact", /^(impact)\b/i],
  ["suggestion", /^(suggested (?:human )?next steps?|recommended (?:human )?(?:action|next steps?)|next steps?|suggestion)\b/i],
];

function sectionLabel(line) {
  const match = line.match(/^([^：:]{1,8})[：:]\s*(.*)$/);
  const label = match ? SECTION_LABELS.find(([, pattern]) => pattern.test(match[1].trim()))?.[0] : null;
  if (label) return { label, rest: match[2] };
  for (const [name, pattern] of ENGLISH_LABELS) {
    const english = line.match(pattern);
    if (!english) continue;
    const after = line.slice(english[0].length);
    const separated = after.match(/^\s*(?:[—–:：-]\s*|$)([\s\S]*)$/);
    if (separated) return { label: name, rest: separated[1].replace(/[:：]\s*$/, "").trim() };
  }
  return null;
}

function labeledSections(text) {
  const sections = {};
  let current = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\*\*|__|`/g, "").replace(/^\s*(#+|>|[-*·•]|\d+[.)、])\s*/, "").trim();
    const found = sectionLabel(line);
    if (found) {
      current = found.label;
      sections[current] = found.rest ? [found.rest] : [];
      continue;
    }
    if (current && line) sections[current].push(line);
    if (current && !line && sections[current].length) current = null;
  }
  return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join(" ").replace(/\s+/g, " ").trim()]));
}

function splitSentences(text) {
  // Table rows are evidence, not sentences: "| ⑩ Readback | 失败原因=null |".
  return String(text)
    .split("\n").filter((line) => !/^\s*\|/.test(line)).join("\n")
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
