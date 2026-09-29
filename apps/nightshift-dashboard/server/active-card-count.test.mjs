import assert from "node:assert/strict";
import test from "node:test";
import { activeCardCount } from "./active-card-count.mjs";
const now = Date.parse("2026-09-15T10:00:00Z");
const claim = { expiresAt: now + 900000 };
test("ended blocked and terminal cards do not occupy slots through retained claims", () => {
  const cards = ["blocked", "done", "cancelled"].map(status => ({ status, execution: { status }, metadata: { claim } }));
  assert.equal(activeCardCount(cards, now), 0);
});
test("running execution remains counted even after card status changes", () => {
  assert.equal(activeCardCount([{status:"blocked",execution:{status:"running"}},{status:"running"}],now),2);
});
test("pre-start claims retain admission reservations until expiry", () => {
  const cards = [now+1,new Date(now+1).toISOString(),now,undefined,"invalid"].map(expiresAt=>({status:"ready",metadata:{claim:{expiresAt}}}));
  assert.equal(activeCardCount(cards,now),2);
});

test("review cards awaiting a human do not occupy Night Shift capacity", () => {
  const future = Date.now() + 86_400_000;
  const cards = [
    { status: "review", metadata: { claim: { expiresAt: future } } },
    { status: "review", execution: { status: "running" } },
    { status: "running" },
  ];
  assert.equal(activeCardCount(cards), 2);
});

import { warmupAdmission } from "./active-card-count.mjs";

test("starts wait while too many cards are in their first minutes", () => {
  const running = (ageMs) => ({ status: "running", execution: { status: "running", startedAt: now - ageMs } });
  const cards = [running(30_000), running(90_000), running(170_000), running(600_000), { status: "ready" }];
  const full = warmupAdmission(cards, { now, windowMs: 180_000, maxWarming: 3 });
  assert.equal(full.warming, 3, "the card ten minutes in is past its warm-up");
  assert.equal(full.available, 0);
  assert.equal(full.retryAfterMs, 10_000, "the oldest warming card leaves its window in 10 s");
  const roomy = warmupAdmission(cards.slice(1), { now, windowMs: 180_000, maxWarming: 3 });
  assert.equal(roomy.available, 1);
  assert.equal(roomy.retryAfterMs, null);
});

test("warm-up counts only running cards and reads ISO start times", () => {
  const cards = [
    { status: "blocked", execution: { status: "blocked", startedAt: now - 1_000 } },
    { status: "running", startedAt: new Date(now - 5_000).toISOString() },
    { status: "running" },
  ];
  assert.deepEqual(warmupAdmission(cards, { now, windowMs: 180_000, maxWarming: 2 }),
    { warming: 1, maxWarming: 2, windowMs: 180_000, available: 1, retryAfterMs: null });
});

test("with more warming than allowed, the wait is until enough of them are past their window", () => {
  const running = (ageMs) => ({ status: "running", execution: { status: "running", startedAt: now - ageMs } });
  const result = warmupAdmission([running(10_000), running(20_000), running(170_000), running(175_000)], { now, windowMs: 180_000, maxWarming: 2 });
  assert.equal(result.available, 0);
  // Four warming with room for two: three must leave before one start, and the
  // third oldest (20 s in) leaves in 160 s.
  assert.equal(result.retryAfterMs, 160_000);
});
