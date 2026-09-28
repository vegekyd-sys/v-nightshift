import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverableArtifactPaths,
  normalizeArtifactPath,
  normalizeDeliverablesManifest,
} from "../src/deliverables.mjs";

const validManifest = {
  version: 1,
  instanceId: "NS-LAB-1",
  title: "星擎交付",
  proposal: {
    title: "策划案",
    externalUrl: "https://example.com/proposal",
    summaryPath: "plan/proposal.md",
  },
  video: {
    title: "成片",
    path: "produce/final.mp4",
    posterPath: "produce/poster.jpg",
    durationSeconds: 26,
    width: 720,
    height: 1280,
  },
  qc: {
    status: "passed",
    reportPath: "produce/qc.md",
    summary: ["完整解码通过"],
  },
  review: { cardId: "card-1", stageId: "review", status: "review" },
};

test("normalizes a delivery manifest and exposes only declared artifacts", () => {
  const manifest = normalizeDeliverablesManifest(validManifest, { instanceId: "NS-LAB-1" });
  assert.deepEqual([...deliverableArtifactPaths(manifest)].sort(), [
    "plan/proposal.md",
    "produce/final.mp4",
    "produce/poster.jpg",
    "produce/qc.md",
  ]);
  assert.equal(manifest.proposal.externalUrl, "https://example.com/proposal");
});

test("rejects cross-instance and traversal paths", () => {
  assert.throws(
    () => normalizeDeliverablesManifest(validManifest, { instanceId: "NS-LAB-2" }),
    /instance mismatch/,
  );
  assert.throws(() => normalizeArtifactPath("../secret"), /inside the instance directory/);
  assert.throws(() => normalizeArtifactPath("/etc/passwd"), /inside the instance directory/);
});

test("drops non-https links instead of exposing them", () => {
  const manifest = normalizeDeliverablesManifest({
    ...validManifest,
    proposal: { ...validManifest.proposal, externalUrl: "javascript:alert(1)" },
  }, { instanceId: "NS-LAB-1" });
  assert.equal(manifest.proposal.externalUrl, null);
});

test("normalizes and declares temporal duplicate evidence", () => {
  const manifest = normalizeDeliverablesManifest({
    ...validManifest,
    qc: {
      ...validManifest.qc,
      duplicateCheck: {
        status: "passed",
        method: "temporal-luma-window-v1",
        threshold: 0.985,
        maxDuplicateRatio: 0.25,
        duplicateRatio: 0.08,
        comparedPairs: 120,
        reportPath: "produce/duplicate-check.json",
      },
    },
  }, { instanceId: "NS-LAB-1" });
  assert.equal(manifest.qc.duplicateCheck.status, "passed");
  assert.ok(deliverableArtifactPaths(manifest).has("produce/duplicate-check.json"));
});

test("binds a delivery package to one content item", () => {
  const itemManifest = { ...validManifest, contentItemId: "video-ai-01" };
  const manifest = normalizeDeliverablesManifest(itemManifest, {
    instanceId: "NS-LAB-1",
    contentItemId: "video-ai-01",
  });
  assert.equal(manifest.contentItemId, "video-ai-01");
  assert.throws(
    () => normalizeDeliverablesManifest(itemManifest, { instanceId: "NS-LAB-1", contentItemId: "video-scene-01" }),
    /content item mismatch/,
  );
});

test("a finished video recorded only in the stage handoff still becomes a playable delivery", async () => {
  const { deliverablesFromHandoffs, normalizeDeliverablesManifest, deliverableArtifactPaths } = await import("../src/deliverables.mjs");
  const handoffs = [
    { stageId: "brief", outputs: [{ name: "finishedVideoBrief", artifact: "content-items/yq-01/finishedVideoBrief.md" }] },
    { stageId: "produce", outputs: [{ name: "finishedAsset", artifact: "content-items/yq-01/produce/final.mp4" }] },
  ];
  const asset = { sha256: "144aba76", video: { width: 1080, height: 1920, durationSeconds: 15 } };
  const raw = deliverablesFromHandoffs(handoffs, { instanceId: "DL-1", contentItemId: "yq-01", title: "条目", asset });
  const manifest = normalizeDeliverablesManifest(raw, { instanceId: "DL-1", contentItemId: "yq-01" });
  assert.equal(manifest.video.path, "produce/final.mp4", "relative to the item, like deliverables.json");
  assert.equal(manifest.video.width, 1080);
  assert.equal(manifest.qc.status, "none", "nothing here attests QC");
  assert.deepEqual([...deliverableArtifactPaths(manifest)], ["produce/final.mp4"], "only the recorded video is served");
  assert.equal(deliverablesFromHandoffs([handoffs[0]], { instanceId: "DL-1", contentItemId: "yq-01" }), null, "no video, no delivery");
});
