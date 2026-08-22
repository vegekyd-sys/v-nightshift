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
