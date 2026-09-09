import assert from "node:assert/strict";
import test from "node:test";
import { resolveNightShiftCardContext } from "../src/card-context.mjs";

const release = {
  spec: {
    stages: [{ id: "generate", sideEffects: ["paid-production"] }],
  },
};

test("recovers Night Shift coordinates and paid effects after Workboard metadata normalization", () => {
  const context = resolveNightShiftCardContext({
    card: {
      labels: ["instance:NS-1", "content-item:item-1", "stage:generate"],
      metadata: { automation: { idempotencyKey: "stable-key", skills: ["makaron"] } },
    },
    release,
  });
  assert.deepEqual(context.sideEffects, ["paid-production"]);
  assert.equal(context.idempotencyKey, "stable-key");
  assert.equal(context.instanceId, "NS-1");
  assert.equal(context.contentItemId, "item-1");
  assert.equal(context.stageId, "generate");
});

test("supports the legacy Night Shift key and rejects coordinate conflicts", () => {
  assert.equal(resolveNightShiftCardContext({
    card: {
      labels: ["instance:NS-1", "stage:generate"],
      metadata: { automation: { nightshiftActionKey: "legacy-key" } },
    },
    release,
  }).idempotencyKey, "legacy-key");
  assert.throws(() => resolveNightShiftCardContext({
    card: {
      labels: ["instance:NS-1", "stage:generate"],
      metadata: { automation: { instanceId: "NS-2" } },
    },
    release,
  }), /instanceId metadata does not match/i);
});
