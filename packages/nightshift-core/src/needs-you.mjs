import { createHash } from "node:crypto";
import { infrastructureFailureSummary } from "./failure-policy.mjs";

// 需要你: everything only a person can move. The engine owns this queue; the
// board, the Feishu notice and nightshiftctl all read it. See
// docs/nightshift-needs-human-design.md.

const DAY_MS = 86_400_000;
const BASELINE_KEY = "needs-you-v1.baseline";
// Bumped whenever the words a request shows are produced differently, so open
// requests are rewritten under the current rules instead of keeping old text.
export const DESCRIBE_VERSION = 5;
const OPERATION_UNDER_WAY = new Set(["reserved", "executing"]);
const MOVED_ON = new Set(["ready", "running", "done", "review", "scheduled", "todo", "backlog"]);

// Choices every stop offers. A stop on one content item may also skip that
// item: the rest of the project delivers without it. "暂停项目" stops the whole
// project, which is not what a person looking at one missing video wants
// (Tianyi, 2026-09-30, on DL-0929-10's missing smoke-test footage).
export const SKIP_OPTION = Object.freeze({
  id: "skip",
  label: "这条不做了",
  effect: "skip",
  description: "其余照常交付；完成通知会写明这条没做、为什么",
});
export const STOP_OPTIONS = Object.freeze([
  Object.freeze({ id: "retry", label: "继续", effect: "retry", description: "按原任务接着做，可以附一句话给 agent（比如「已补素材」）" }),
  Object.freeze({ id: "pause", label: "暂停项目", effect: "pause", description: "暂停整个项目：不再派任何新任务，问题解决后再恢复" }),
]);

// What a person answers once they have done what the card asks. "继续" is one
// choice whatever the ledger says; the engine decides how to go on (see
// continuation). The one place two answers mean different things is a paid
// result that exists but did not pass its checks: use it, or pay for a new
// one (wsfood-es-22, 2026-10-08).
export function stopOptionsFor(scope, { stage = null, operation = null, asked = false } = {}) {
  const ledger = ledgerOf(stage, operation);
  const options = [];
  if (scope === "item" && ledger?.state === "succeeded" && ledger.paidOnly) {
    options.push(Object.freeze({ id: "retry", label: "用这次的结果", effect: "retry", description: "接着用已经做好的结果交付，不会再付钱；可以附一句话给 agent" }));
    options.push(Object.freeze({ id: "redo", label: "重新生成", effect: "redo", description: "重新做一次，会再付一次钱；可以写这次要怎么改" }));
  } else {
    const fresh = scope === "item" ? continuation(ledger) === "fresh" : ledger?.state === "failed";
    const ambiguous = scope === "project" && ["unsubmitted", "unknown"].includes(ledger?.state);
    options.push(Object.freeze({
      id: "continue",
      label: asked ? "处理好了，继续" : "再试一次",
      effect: "continue",
      ...(scope === "project" && fresh ? { freshOperation: true } : {}),
      description: ambiguous ? "先核实供应商是否已执行；结果不明时不会重新调用，请补充回读结果"
        : fresh && scope === "project" ? (stage?.sideEffects?.includes("paid-production") ? "重新做这一步，会发起新调用，可能再次付费；请确认后继续" : "重新做这一步，会再次执行对外操作；请确认后继续")
        : fresh ? "重新做这一步，会再付一次钱；可以附一句话给 agent"
        : "接着做这一步，不会再付钱；可以附一句话给 agent（比如「已补素材」）",
    }));
  }
  if (scope === "item") options.push(SKIP_OPTION);
  options.push(STOP_OPTIONS[1]);
  return Object.freeze(options);
}

// How a stopped card goes on. Its external call's ledger key carries the
// item's revision, not the attempt, so going on with the same card meets the
// same operation: fine when nothing was registered, when the result exists or
// when the call is still running, but a registration never submitted, a failed
// call or one in an unknown state blocks again every time (wsfood-es-28 on V,
// 2026-10-08). Those go on as a fresh attempt under a new revision.
export function continuation(ledger) {
  return ledger && ["unsubmitted", "failed", "unknown"].includes(ledger.state) ? "fresh" : "same";
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
        // Words already read stay: after a restart the failure comes back without them.
        if (!failure.agentReport && existing.evidence?.failure?.agentReport) failure = { ...failure, agentReport: existing.evidence.failure.agentReport };
        const text = describeStop({ failure, summary, operation, stage });
        return this.store.updateDecisionRequestText(existing.id, {
          ...text,
          options: stopOptionsFor(existing.scope, { stage, operation, asked: text.asked }),
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
    const { problem, cause, impact, suggestion, detail, asked } = describeStop({ failure, summary, operation, stage });
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
      options: stopOptionsFor(scope, { stage, operation, asked }),
      // What the person is asked to do groups stops; without an ask, the cause does.
      groupKey: groupKey({ instanceId: instance.id, stageId, failure, problem: asked ? problem : cause || problem }),
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

// What the person reads: what they are asked to do, and one sentence of why.
// Not the engine's rule, the ledger's state or a choice of system actions: on
// V (2026-09-28 to 10-08) 42 of 42 decided stops were answered by retry or
// skip without a word, because the card never said what a person could do.
// Only the Agent knows that (a balance to top up, footage to supply, a proxy
// to fix, a result to look at), so every brief asks a stopping Agent to open
// its final message with 需要人做 and 原因 (buildAgentBrief). A stop with no
// such ask is the engine's to handle (runtime.recoverStopByItself) and reaches
// a person only when that did not work.
export function describeStop({ failure = null, summary = null, operation = null, stage = null } = {}) {
  const report = failure?.agentReport ? String(failure.agentReport) : "";
  const read = readStopReport(report);
  const scope = stage?.scope === "content-item" ? "item" : "project";
  const asked = Boolean(read.action);
  const problem = asked
    ? truncate(read.action, 200)
    : scope === "item" ? "这一条没做成：要再试一次，还是不做了？" : "这一步没做成：要再试一次，还是暂停项目？";
  let cause = read.cause || read.problem;
  if (!cause && report) cause = splitSentences(report).find((sentence) => CAUSE_WORDS.test(sentence)) || firstSentence(report);
  if (!cause) cause = engineReason({ failure, summary, ledger: ledgerOf(stage, operation) });
  cause = truncate(cause, 200);
  return {
    problem,
    cause: sameText(cause, problem) ? "" : cause,
    impact: "",
    suggestion: "",
    asked,
    detail: report || [summary, failure?.rawError].filter(Boolean).join("\n\n") || String(summary ?? "").trim(),
  };
}

// The two lines a stopping Agent writes first. action is null when the Agent
// wrote none, and "" when it wrote that no person is needed.
export function readStopReport(text) {
  const sections = labeledSections(String(text ?? ""));
  const action = sections.action === undefined ? null : NO_ONE.test(sections.action) ? "" : sections.action;
  return { action, cause: sections.cause || "", problem: sections.problem || "" };
}

const NO_ONE = /^\s*(无|没有|不需要|不用|none|n\/a|no)\s*[。.]?\s*$/i;
const CAUSE_WORDS = /原因|因为|由于|失败|根因|导致|被拒|不可用|超时|failed|because|rejected|refused|\berror\b/i;

// When the Agent said nothing usable: what the engine itself knows, plainly.
function engineReason({ failure, summary, ledger }) {
  if (ledger?.state === "failed") return `外部平台返回失败${ledger.reason ? `：${ledger.reason}` : ""}`;
  if (ledger?.state === "unsubmitted") return "提交给外部平台之前中断了，没有交出去";
  if (failure?.kind && failure.kind !== "contract_error") return firstSentence(infrastructureFailureSummary(failure));
  if (failure) return explainContractError(failure.rawError || summary || failure.message || "").cause;
  return String(summary ?? "").trim() ? firstSentence(summary) : "Agent 停下了，没有给出原因";
}

// The ledger's answer for this card's external call. Null when the stage has
// no side effects.
export function ledgerOf(stage, operation) {
  const effects = Array.isArray(stage?.sideEffects) ? stage.sideEffects : [];
  if (effects.length === 0) return null;
  const paidOnly = effects.every((effect) => effect === "paid-production");
  if (!operation) return { state: "none", paidOnly };
  const taskId = operation.externalTaskId ?? null;
  if (operation.status === "succeeded") return { state: "succeeded", taskId, paidOnly };
  if (operation.status === "failed") return { state: "failed", taskId, reason: resultReason(operation.result), paidOnly };
  if (operation.status === "executing" && taskId) return { state: "executing", taskId, paidOnly };
  if (operation.status === "unknown") return { state: "unknown", taskId, paidOnly };
  return { state: "unsubmitted", taskId: null, paidOnly };
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

// The engine's own completion checks, as one plain sentence of why. The
// English original stays in the request's detail.
const CONTRACT_EXPLANATIONS = [
  { pattern: /external side effect has no succeeded|operation checkpoint|ledger/i, cause: "付费或外部操作没有成功的记录" },
  { pattern: /must stay inside the instance directory|outside the (instance|project)/i, cause: "交付的文件放在了项目目录之外" },
  { pattern: /artifact not found|declared output .* is missing|is not a file/i, cause: "这一步应该交出的文件不存在" },
  { pattern: /handoff/i, cause: "这一步没有写交接记录就结束了" },
  { pattern: /completion rule failed|does not equal the workflow contract|does not match|host .* is not allowed/i, cause: "交出的结果不符合这一步的验收条件" },
  { pattern: /evidence|skill/i, cause: "没有留下这一步要求的执行证据" },
];

function explainContractError(raw) {
  const text = String(raw ?? "").replace(/^(Completion validation failed|Terminal Agent Session did not satisfy the Workflow output contract):\s*/i, "");
  const match = CONTRACT_EXPLANATIONS.find((entry) => entry.pattern.test(text));
  return { cause: match ? match.cause : text ? `引擎的检查没通过：${truncate(text, 160)}` : "引擎的检查没通过" };
}

function sameText(left, right) {
  const normalize = (value) => String(value ?? "").replace(/[\s。，,.]/g, "");
  return Boolean(left) && normalize(left) === normalize(right);
}

const SECTION_LABELS = [
  ["action", /^(需要人做|需要你做|需要人工处理|需要你)$/],
  ["problem", /^(问题|发生了什么|结论|现象)$/],
  ["cause", /^(原因|为什么|根因|根本原因)$/],
  // Read only so they end the sections above.
  ["impact", /^(影响|影响范围)$/],
  ["suggestion", /^(建议|建议怎么做|建议人工处置|下一步|处理建议)$/],
];
// Headings Agents wrote in English before the brief asked for the two lines
// (DL-1008-04: "**Why blocked — machine QC failed …:**"). A label must end the
// line or be followed by a separator, so "Why it matters is …" is not one.
const ENGLISH_LABELS = [
  ["cause", /^(why blocked|why it (?:stopped|blocked)|root cause|cause|reason|blocker)\b/i],
  ["suggestion", /^(suggested (?:human )?next steps?|recommended (?:human )?(?:action|next steps?)|next steps?)\b/i],
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
