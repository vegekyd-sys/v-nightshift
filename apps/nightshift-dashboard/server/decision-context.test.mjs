import assert from "node:assert/strict";
import test from "node:test";
import { resolveCardDecisionContext } from "./decision-context.mjs";

test("derives an exact guarded side effect from the pinned Workflow instead of trusting a client", () => {
  const input = resolveCardDecisionContext({
    body: { actor: "V", effect: null, scope: null },
    card: {
      id: "approval-card",
      labels: ["instance:PROJECT-1", "content-item:video-01", "stage:produce"],
      metadata: { automation: {} },
    },
    instance: { id: "PROJECT-1" },
    release: {
      spec: {
        stages: [{ id: "produce", approval: { before: "paid-production", scope: "content-item" } }],
      },
    },
  });
  assert.deepEqual(input, {
    actor: "V",
    cardId: "approval-card",
    contentItemId: "video-01",
    effect: "paid-production",
    instanceId: "PROJECT-1",
    scope: "content-item",
    stageId: "produce",
  });
});

test("preserves an ordinary human review decision without inventing an authorization", () => {
  const input = resolveCardDecisionContext({
    body: { actor: "Reviewer", evidence: "Looks good" },
    card: { id: "review-card", labels: ["instance:PROJECT-1", "content-item:video-01", "stage:review"] },
    instance: { id: "PROJECT-1" },
    release: { spec: { stages: [{ id: "review", actor: "human" }] } },
  });
  assert.equal(input.effect, undefined);
  assert.equal(input.scope, undefined);
  assert.equal(input.stageId, "review");
});
