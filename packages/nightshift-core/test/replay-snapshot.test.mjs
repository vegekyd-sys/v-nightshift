import assert from "node:assert/strict";
import test from "node:test";
import { createReplaySnapshot, replaySnapshotMetrics } from "../src/replay-snapshot.mjs";

test("builds a relationship-preserving replay snapshot without customer content or credentials", () => {
  const workflowSha256 = "a".repeat(64);
  const snapshot = createReplaySnapshot({
    capturedAt: "2026-09-15T01:00:00.000Z",
    sourceRelease: "c299ec1",
    bootstrap: {
      cards: [{ id: "card-private" }],
      instances: [{ id: "customer-a" }],
      workflows: [{
        workflowSha256,
        workflowId: "publish-video",
        version: "1.0.0",
        publishedAt: "2026-09-14T00:00:00.000Z",
        manifest: {
          apiVersion: "nightshift/v1",
          kind: "Workflow",
          metadata: { id: "publish-video", version: "1.0.0" },
          spec: { stages: [{ id: "publish", actor: "agent", needs: ["review"], skills: ["makaron"], description: "客户素材" }] },
        },
      }],
    },
    instances: { instances: [{
      id: "customer-a",
      workflowSha256,
      status: "active",
      inputs: { publishMode: "scheduled", sourceUrl: "https://private.example/signed?token=abc", apiToken: "secret" },
      agentBindings: { operator: "makaron" },
      approvals: [],
      stageRuns: [{ instanceId: "customer-a", stageId: "review", cardId: "card-private", status: "done", summary: "approved by Alice" }],
      contentItemRuns: [],
    }] },
    cards: { cards: [{
      id: "card-private",
      title: "Customer A private video",
      status: "done",
      labels: ["instance:customer-a", "stage:review"],
      metadata: { automation: { instanceId: "customer-a", stageId: "review", token: "never-export" }, attempts: [{ runId: "run-private", sessionKey: "agent:makaron:private", status: "done" }] },
      notes: "private transcript",
    }] },
  });

  assert.equal(snapshot.schema, "nightshift.replay.v1");
  assert.equal(snapshot.source.releaseCommit, "c299ec1");
  assert.equal(snapshot.instances[0].id, snapshot.cards[0].labels[0].split(":")[1]);
  assert.equal(snapshot.instances[0].inputs.publishMode, "scheduled");
  assert.match(snapshot.instances[0].inputs.sourceUrl, /^\[value:/);
  assert.equal(snapshot.instances[0].inputs.apiToken, "[redacted]");
  assert.equal(snapshot.cards[0].automation.token, "[redacted]");
  const serialized = JSON.stringify(snapshot);
  for (const secret of ["private.example", "never-export", "private transcript", "approved by Alice", "客户素材"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(replaySnapshotMetrics(snapshot), {
    cards: 1,
    instances: 1,
    workflows: 1,
    cardStatuses: { done: 1 },
    instanceStatuses: { active: 1 },
    sessionAttempts: 1,
  });
});
