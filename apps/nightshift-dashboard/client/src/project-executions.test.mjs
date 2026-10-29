import assert from "node:assert/strict";
import test from "node:test";
import { executionReason, executionState, projectExecutions } from "./project-executions.js";

test("execution details group rounds without repeating tasks or exposing internal IDs as titles", () => {
  const first = { id: "round1", parentId: "ROOT", cardId: "controller", stageId: "authenticate", contentItemId: "slot-a", iteration: 1, state: "continued", reason: "repeat-condition", cardIds: ["old-task"] };
  const latest = { ...first, id: "round2", iteration: 2, state: "running", blocked: true, reason: "child-work-stopped: recover the child card in this round", cardIds: ["old-failed", "current-task", "later-export"] };
  const project = { id: "ROOT", contentItems: [{ id: "slot-a", title: "名额 01" }], calls: [latest, first] };
  const [group] = projectExecutions(project, [{ id: "authenticate", title: "获得可登录账号" }], [{ kind: "decision", cardId: "current-task" }]);
  assert.equal(group.title, "获得可登录账号");
  assert.equal(group.itemTitle, "名额 01");
  assert.equal(group.taskId, "current-task", "open decision wins over historical or export cards");
  assert.equal(group.history.length, 1);
  assert.equal(group.latest.id, "round2");
  assert.equal(executionState(group.latest).label, "待处理", "a stopped child must not be advertised as executing");
  assert(!/[a-z]/i.test(executionReason(group.latest)));
  assert.equal(projectExecutions(project)[0].title, "子流程");
});

test("independent items stay separate and single-pass calls do not need a round label", () => {
  const groups = projectExecutions({ id: "ROOT", calls: [{ id: "a", cardId: "a", stageId: "environment", iteration: 1, state: "succeeded", cardIds: ["a-task"] }, { id: "b", cardId: "b", stageId: "environment", iteration: 1, state: "running", cardIds: ["b-task"] }] });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].history.length, 0);
  assert.equal(executionState(groups[0].latest).label, "已完成");
  assert.equal(executionState(groups[1].latest).label, "进行中");
  assert.deepEqual(projectExecutions({}), []);
});
