import assert from "node:assert/strict";
import test from "node:test";
import { countByKind, expectedTasks, inScope, projectScope, scopeAuthorizes, taskAttention } from "./attention.js";

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
