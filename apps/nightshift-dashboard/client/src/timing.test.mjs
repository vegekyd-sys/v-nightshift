import assert from "node:assert/strict";
import test from "node:test";
import { projectTiming } from "./timing.js";

const NOW = Date.parse("2026-10-20T14:00:00Z");
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

test("a project whose first card has not started reads as queued, not running", () => {
  const label = projectTiming({ status: "active", createdAt: at(240), updatedAt: at(240), workStartedAt: null }, NOW);
  assert.match(label, /提交 · 排队中 4 小时$/);
  assert.doesNotMatch(label, /已进行/);
});

test("a running project counts from when work started and shows the wait apart", () => {
  const label = projectTiming({ status: "active", createdAt: at(300), updatedAt: at(5), workStartedAt: at(60) }, NOW);
  assert.match(label, /开工 · 已进行 1 小时 · 排队 4 小时$/);
});

test("a short wait is not worth a mention", () => {
  const label = projectTiming({ status: "active", createdAt: at(65), updatedAt: at(5), workStartedAt: at(60) }, NOW);
  assert.match(label, /开工 · 已进行 1 小时$/);
});

test("a delivered project's time is the work, with the wait shown apart", () => {
  const label = projectTiming({ status: "done", createdAt: at(400), updatedAt: at(10), workStartedAt: at(160) }, NOW);
  assert.match(label, /交付 · 用时 2 小时 30 分 · 排队 4 小时$/);
});

test("without a known start a delivered project falls back to its submission time", () => {
  const label = projectTiming({ status: "done", createdAt: at(400), updatedAt: at(10) }, NOW);
  assert.match(label, /交付 · 用时 6 小时 30 分$/);
});

test("a paused project says when it was submitted", () => {
  assert.match(projectTiming({ status: "paused", createdAt: at(30), updatedAt: at(1) }, NOW), /提交 · 已暂停$/);
});
