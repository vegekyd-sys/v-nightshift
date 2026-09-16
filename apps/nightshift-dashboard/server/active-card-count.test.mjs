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
