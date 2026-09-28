import assert from "node:assert/strict";
import test from "node:test";
import { countByKind, expectedTasks, inScope, projectProgress, projectScope, scopeAuthorizes, stageExpected, taskAttention } from "./attention.js";

const NOW = Date.parse("2026-09-28T10:00:00Z");
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();

test("only projects that are moving count as live; old paused ones are shelved", () => {
  assert.equal(projectScope({ status: "active", updatedAt: daysAgo(10) }, NOW), "live");
  assert.equal(projectScope({ status: "paused", updatedAt: daysAgo(1) }, NOW), "live", "a pause from today is still work in progress");
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
  assert.deepEqual(countByKind([{ attention: { kind: "healing" } }]), { "needs-you": 0, healing: 1, running: 0, queued: 0, done: 0, stale: 0 });
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
