import assert from "node:assert/strict";
import test from "node:test";
import {
  findNightShiftExternalOperation,
  resolveNightShiftCardContext,
  resolveNightShiftOperationKeys,
} from "../src/card-context.mjs";
import { gatewayIdempotencyLabel } from "../src/workboard-gateway-adapter.mjs";

const release = {
  metadata: { workflowSha256: "release-sha" },
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

test("keeps legacy ledger compatibility while bounding the native Workboard key", () => {
  const longId = `NS-${"x".repeat(170)}`;
  const card = {
    labels: [`instance:${longId}`, "content-item:item-1", "stage:generate"],
    metadata: { automation: {} },
  };
  const instance = { id: longId, inputHash: "input-hash" };
  const contentItem = { id: "item-1" };
  const keys = resolveNightShiftOperationKeys({ card, release, instance, contentItem });
  assert.ok(keys.logicalIdempotencyKey.length > 160);
  assert.match(keys.boundedNativeIdempotencyKey, /^nightshift:[a-f0-9]{64}$/);
  assert.ok(keys.boundedNativeIdempotencyKey.length <= 160);
  assert.deepEqual(keys.candidateIdempotencyKeys, [
    keys.logicalIdempotencyKey,
    keys.boundedNativeIdempotencyKey,
  ]);
  assert.equal(keys.preferredIdempotencyKey, keys.boundedNativeIdempotencyKey);
});

test("finds a legacy ledger operation from the immutable action label", () => {
  const legacyKey = `${"legacy-long-key:".repeat(12)}original-input-hash`;
  const legacyOperation = { idempotencyKey: legacyKey, status: "succeeded" };
  const card = { labels: [gatewayIdempotencyLabel(legacyKey)] };
  assert.equal(findNightShiftExternalOperation({
    card,
    candidateIdempotencyKeys: ["recomputed-different-key"],
    operations: [legacyOperation],
  }), legacyOperation);
});
