import assert from "node:assert/strict";
import test from "node:test";
import { childDecisionTasks, decisionDrawerContext } from "./attention.js";

test("root inbox and deep-linked child drawer retain the exact decision, without including unrelated projects", () => {
  const item = { kind: "decision", id: "decision-1", instanceId: "ROOT", executionInstanceId: "CHILD", cardId: "child-card", stageId: "create", problem: "Correct supplier request" };
  const queue = { items: [item, { ...item, id: "other", cardId: "other-card", instanceId: "OTHER" }, { ...item, kind: "review", id: "review", cardId: "review-card" }] };
  const tasks = childDecisionTasks([{ id: "ROOT", name: "root" }], [], queue);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].card.id, "child-card");
  assert(tasks[0].card.labels.includes("instance:CHILD"));
  assert.equal(decisionDrawerContext(null, tasks[0].card, queue).attention.request.id, "decision-1");
  assert.equal(decisionDrawerContext(null, tasks[0].card, { items: [] }), null, "decided requests are not resurrected");
});
import { canReviewCard, cardAttention, countByKind, expectedTasks, inScope, preferTask, projectProgress, projectScope, scopeAuthorizes, stageExpected, supersededCards, taskAttention } from "./attention.js";

const NOW = Date.parse("2026-09-28T10:00:00Z");
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();

test("only projects that are moving count as live; old paused ones are shelved", () => {
  assert.equal(projectScope({ status: "active", updatedAt: daysAgo(10) }, NOW), "live");
  assert.equal(projectScope({ status: "paused", updatedAt: daysAgo(1) }, NOW), "paused", "a paused project does not run by itself, so it is not 在产");
  assert.equal(projectScope({ status: "paused", updatedAt: daysAgo(5) }, NOW), "shelved");
  assert.equal(projectScope({ status: "done", updatedAt: daysAgo(1) }, NOW), "delivered");
  assert.equal(projectScope({ status: "archived", updatedAt: daysAgo(1) }, NOW), "archived");
  assert.equal(inScope({ status: "archived" }, "all", NOW), false, "archived projects never show");
  assert.equal(inScope({ status: "paused", updatedAt: daysAgo(5) }, "all", NOW), true);
});

test("a lease timeout the engine retries is healing, not the operator's problem", () => {
  const task = { status: "retry_wait", failure: { kind: "database_lock", automaticRetry: true } };
  assert.equal(taskAttention(task).kind, "healing");
  assert.equal(taskAttention({ status: "blocked", failure: { automaticRetry: true } }).kind, "healing");
});

// DL-0928-01 EN-hook-11 on V: the board said blocked while Makaron was still
// generating. Retrying it would have paid twice.
test("a blocked card whose paid operation is still executing is healing", () => {
  const task = { status: "blocked", card: { status: "blocked" } };
  const attention = taskAttention(task, { operation: { status: "executing" } });
  assert.equal(attention.kind, "healing");
  assert.match(attention.reason, /付费任务仍在执行/);
});

// GEE-TIMED-PUB-20260925 圣山-BR-008: GeeLark failCode 20206, recorded as failed.
test("a recorded external failure needs a person to decide", () => {
  const task = { status: "blocked", failure: { kind: "contract_error", validationPhase: "side_effect", automaticRetry: false } };
  assert.equal(taskAttention(task, { operation: { status: "failed" } }).kind, "needs-you");
  assert.match(taskAttention(task).reason, /外部操作没有成功记录/);
  assert.match(taskAttention({ status: "blocked" }).reason, /Agent 停下来了/);
});

test("review work and missing approvals need a person", () => {
  assert.equal(taskAttention({ status: "review" }).kind, "needs-you");
  const approval = taskAttention({ status: "review", requiresApproval: true, guardedEffect: "external-publication" });
  assert.equal(approval.reason, "等你确认外部发布");
});

test("ordinary flow is not attention", () => {
  assert.equal(taskAttention({ status: "running" }).kind, "running");
  assert.equal(taskAttention({ status: "ready" }).kind, "queued");
  assert.equal(taskAttention({ status: "scheduled" }).kind, "queued");
  assert.equal(taskAttention({ status: "done" }).kind, "done");
  assert.equal(taskAttention({ status: "running", card: { status: "done" } }).kind, "done", "the native card is the truth");
});

// Every running produce card on V read "确认付费生产" although each project had
// authorized paid production for all of its items.
test("a project-wide paid-production authorization covers every item; publication does not", () => {
  const instance = { inputs: { authorizationScope: { paidProduction: true, externalPublication: true } } };
  assert.equal(scopeAuthorizes(instance, "paid-production"), true);
  assert.equal(scopeAuthorizes(instance, "external-publication"), false);
  assert.equal(scopeAuthorizes({ inputs: {} }, "paid-production"), false);
});

test("the expected task count follows the stages this project will run", () => {
  const stages = [
    { id: "plan", scope: "project" },
    { id: "brief", scope: "content-item" },
    { id: "publish", scope: "content-item", when: { input: "deliveryMode", notEquals: "download" } },
    { id: "deliver", scope: "project", when: { input: "deliveryMode", equals: "download" } },
  ];
  const items = Array.from({ length: 20 }, (_, index) => ({ id: `i${index}` }));
  assert.equal(expectedTasks(stages, { inputs: { deliveryMode: "download" }, contentItems: items }), 22);
  assert.equal(expectedTasks(stages, { inputs: { deliveryMode: "publish" }, contentItems: items }), 41);
});

test("counts every kind even when absent", () => {
  assert.deepEqual(countByKind([{ attention: { kind: "healing" } }]), { "needs-you": 0, healing: 1, running: 0, queued: 0, done: 0, stale: 0, skipped: 0 });
});

// The shelved view on V listed 88 "needs you" items, all from projects nobody
// had touched for days.
test("a shelved project's leftovers are stale, not waiting on anyone", () => {
  const blocked = { status: "blocked", failure: { kind: "contract_error" } };
  const stale = taskAttention(blocked, { shelved: true });
  assert.equal(stale.kind, "stale");
  assert.equal(stale.reason, "产物没有通过完成校验", "the reason is kept for reference");
  assert.equal(taskAttention({ status: "done" }, { shelved: true }).kind, "done");
  assert.equal(taskAttention({ status: "review" }, { shelved: true }).kind, "stale");
});

test("before items exist the bar uses the declared target, or says it is still splitting", () => {
  const stages = [{ id: "plan", scope: "project" }, { id: "brief", scope: "content-item" }, { id: "produce", scope: "content-item" }];
  assert.deepEqual(projectProgress(stages, { inputs: { targetCount: 20 }, contentItems: [] }), { expected: 41, estimated: true, splitting: false });
  assert.deepEqual(projectProgress(stages, { inputs: {}, contentItems: [] }), { expected: 1, estimated: false, splitting: true });
  const items = Array.from({ length: 18 }, (_, index) => ({ id: `i${index}` }));
  assert.deepEqual(projectProgress(stages, { inputs: { targetCount: 20 }, contentItems: items }), { expected: 37, estimated: false, splitting: false }, "real items win over the target");
  assert.deepEqual(projectProgress([{ id: "sweep", scope: "project" }], { inputs: {}, contentItems: [] }), { expected: 1, estimated: false, splitting: false }, "a Workflow with no item stages is never splitting");
});

test("a stage's total counts only projects that run it", () => {
  const publish = { id: "publish", scope: "content-item", when: { input: "deliveryMode", notEquals: "download" } };
  const items = (n) => Array.from({ length: n }, (_, index) => ({ id: `i${index}` }));
  assert.equal(stageExpected(publish, [{ inputs: { deliveryMode: "download" }, contentItems: items(20) }, { inputs: { deliveryMode: "publish" }, contentItems: items(5) }]), 5);
});

test("a project's latest runs are classed like the lanes", async () => {
  const { projectRuns } = await import("./attention.js");
  const instance = {
    status: "active",
    stageRuns: [{ stageId: "plan", attempt: 1, status: "done" }],
    contentItemRuns: [
      { stageId: "brief", contentItemId: "a", attempt: 1, status: "blocked", failure: { automaticRetry: false }, cardId: "c1" },
      { stageId: "brief", contentItemId: "a", attempt: 2, status: "done", cardId: "c2" },
      { stageId: "produce", contentItemId: "a", attempt: 1, status: "blocked", cardId: "c3" },
    ],
    operations: [{ ownerCardId: "c3", status: "executing" }],
  };
  const runs = projectRuns(instance);
  assert.deepEqual(runs.map((run) => [run.stageId, run.attention.kind]).sort(), [["brief", "done"], ["plan", "done"], ["produce", "healing"]]);
});

test("an approval card waiting on review needs a person; a retrying card heals", async () => {
  const { cardAttention } = await import("./attention.js");
  assert.equal(cardAttention({ status: "review" }, { approval: true }).kind, "needs-you");
  assert.equal(cardAttention({ status: "blocked" }, { run: { status: "blocked", failure: { automaticRetry: true, nextRetryAt: "2026-09-28T10:00:00Z" } } }).kind, "healing");
  assert.equal(cardAttention({ status: "blocked" }, { shelved: true }).kind, "stale");
});

test("with the engine's queue, only its requests need a person", async () => {
  const { cardAttention, needsYouQueue } = await import("./attention.js");
  const queue = needsYouQueue({
    items: [
      { id: "dr-1", kind: "decision", cardId: "stop", problem: "GeeLark 返回 20206" },
      { id: "approval:gate", kind: "approval", cardId: "gate" },
    ],
    pending: [{ cardId: "fresh", until: "2026-09-28T10:02:00Z" }],
  });
  const stop = cardAttention({ id: "stop", status: "blocked" }, { queue });
  assert.equal(stop.kind, "needs-you");
  assert.equal(stop.reason, "GeeLark 返回 20206");
  assert.equal(stop.request.id, "dr-1");
  assert.equal(cardAttention({ id: "gate", status: "review" }, { queue, approval: true }).kind, "needs-you");
  assert.deepEqual(cardAttention({ id: "fresh", status: "blocked" }, { queue }), { kind: "healing", reason: "正在判定是否需要你", judging: true });
  assert.equal(cardAttention({ id: "old", status: "blocked" }, { queue }).kind, "healing", "a stop the engine has not judged yet is not counted");
  assert.equal(cardAttention({ id: "agent-review", status: "review" }, { queue }).kind, "queued", "a review nobody is asked for waits in the flow");
  assert.equal(cardAttention({ id: "old", status: "blocked" }, { queue: null }).kind, "needs-you", "without a queue the board still judges for itself");
  assert.equal(cardAttention({ id: "paid", status: "blocked" }, { queue, operation: { status: "executing" } }).kind, "healing");
  assert.equal(cardAttention({ id: "stop", status: "blocked" }, { queue, shelved: true }).kind, "stale");
});

test("an overview without the queue field means no queue", async () => {
  const { needsYouQueue } = await import("./attention.js");
  assert.equal(needsYouQueue(undefined), null);
  assert.equal(needsYouQueue({}), null);
});

test("a skipped item is settled, and leaves the project's expected work", async () => {
  const { cardAttention, projectRuns, projectProgress, stageExpected } = await import("./attention.js");
  const queue = { byCard: new Map(), pending: new Map() };
  assert.deepEqual(cardAttention({ id: "c", status: "blocked" }, { queue, skipped: true, skipReason: "只有 1 段素材" }), { kind: "skipped", reason: "已跳过：只有 1 段素材" });
  const instance = {
    status: "active",
    contentItems: [{ id: "a" }, { id: "b" }, { id: "c" }],
    skippedContentItems: [{ contentItemId: "b", reason: null }],
    stageRuns: [],
    contentItemRuns: [
      { stageId: "brief", contentItemId: "a", attempt: 1, status: "done" },
      { stageId: "brief", contentItemId: "b", attempt: 1, status: "blocked", cardId: "cb" },
    ],
  };
  const stages = [{ id: "brief", scope: "content-item" }, { id: "deliver", scope: "project" }];
  assert.deepEqual(projectRuns(instance).map((run) => [run.contentItemId, run.attention.kind]).sort(), [["a", "done"], ["b", "skipped"]]);
  assert.equal(projectProgress(stages, instance).expected, 3, "two items left times one item stage, plus delivery");
  assert.equal(stageExpected(stages[0], [instance]), 2);
});

test("while the Gateway restarts, a stopped card waits to be picked up, not judged", async () => {
  const { cardAttention, needsYouQueue } = await import("./attention.js");
  const holding = needsYouQueue({ items: [{ id: "d", kind: "decision", cardId: "asked", problem: "p" }], pending: [] }, { status: "holding" });
  assert.deepEqual(cardAttention({ id: "cut", status: "blocked" }, { queue: holding }), { kind: "healing", reason: "Gateway 重启中，恢复后自动接上" });
  assert.equal(cardAttention({ id: "asked", status: "blocked" }, { queue: holding }).kind, "needs-you", "a question already asked stays asked");
  const up = needsYouQueue({ items: [], pending: [] }, { status: "up" });
  assert.equal(cardAttention({ id: "cut", status: "blocked" }, { queue: up }).reason, "正在判定是否需要你");
});

// DL-1009-02 on V, 2026-10-10: five items went on as fresh attempts that were
// delivered, yet the board showed 出片 19/24 and 「自愈中 5」 for a finished
// project. The replaced cards stay blocked on the native board, which has no
// cancelled state, and the stage view preferred a blocked card over a done one.
const REDONE = {
  id: "DL-1009-02",
  stageRuns: [],
  contentItemRuns: [
    { stageId: "produce", contentItemId: "pt-01", attempt: 1, cardId: "old-01", status: "blocked" },
    { stageId: "produce", contentItemId: "pt-01", attempt: 2, cardId: "new-01", status: "done" },
    { stageId: "produce", contentItemId: "pt-02", attempt: 1, cardId: "only-02", status: "blocked" },
  ],
};

test("a card another attempt replaced is superseded, not healing, and counts nowhere", () => {
  const superseded = supersededCards(REDONE);
  assert.deepEqual([...superseded], ["old-01"], "pt-02's only attempt is still the item's own");
  const attention = cardAttention({ id: "old-01", status: "blocked" }, { run: REDONE.contentItemRuns[0], superseded: superseded.has("old-01") });
  assert.equal(attention.kind, "superseded");
  assert.match(attention.reason, /新的一次尝试/);
  const counts = countByKind([{ attention }]);
  assert.equal(counts.healing, 0);
  assert.equal(counts["needs-you"], 0);
});

test("a stage shows an item's newest attempt, whatever its status", () => {
  const [oldRun, newRun] = REDONE.contentItemRuns;
  assert.equal(preferTask({ ...newRun }, { ...oldRun }), true, "attempt 2 done beats attempt 1 blocked");
  assert.equal(preferTask({ ...oldRun }, { ...newRun }), false);
  // Same attempt: the approval waiting on a person still shows over its blocked execution card.
  assert.equal(preferTask({ attempt: 1, status: "review", isApproval: true }, { attempt: 1, status: "blocked" }), true);
});


test("review is a human decision only for real review/approval cards, not call controllers", () => {
  assert.equal(canReviewCard({ status: "review", metadata: { automation: { workflowCall: { state: "running", iteration: 1 } } } }), false);
  assert.equal(canReviewCard({ status: "blocked", metadata: { automation: { workflowCall: { state: "held" } } } }), false);
  assert.equal(canReviewCard({ status: "review" }), true);
  assert.equal(canReviewCard({ status: "blocked", metadata: { automation: { approval: { effect: "external-publication", scope: "content-item" } } } }), true);
});
