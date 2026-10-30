import assert from "node:assert/strict";
import test from "node:test";
import { CardFingerprints } from "./card-fingerprints.mjs";

test("a scoped read reports a change only when one of its cards changed or left", () => {
  const prints = new CardFingerprints();
  assert.equal(prints.replaceAll([{ id: "a", status: "ready" }, { id: "b", status: "done" }]), true);
  assert.equal(prints.replaceAll([{ id: "a", status: "ready" }, { id: "b", status: "done" }]), false);
  assert.equal(prints.replaceSome(["a"], [{ id: "a", status: "ready" }]), false, "same card, no change");
  assert.equal(prints.replaceSome(["a"], [{ id: "a", status: "running" }]), true);
  assert.equal(prints.replaceSome(["b"], []), true, "a card asked for and not returned is gone");
  assert.equal(prints.replaceSome(["b"], []), false, "and gone only once");
  assert.equal(prints.replaceSome(["c"], [{ id: "c", status: "ready" }]), true, "a new card");
  assert.equal(prints.replaceAll([{ id: "a", status: "running" }, { id: "c", status: "ready" }]), false);
});
