import assert from "node:assert/strict";
import test from "node:test";
import { validateDeclaredCompletion } from "../src/index.mjs";

const manifest = { outputs: [
  { name: "publicUrl", artifact: "https://www.tiktok.com/@versa/video/123" },
  { name: "publicationEvidence", artifact: "content-items/video-1/publish-feedback/publicationEvidence.json" },
] };
const stage = {
  completeWhen: ["output.publicUrl.hostAllowed", "output.publicUrl.reachable", "output.publicationEvidence.published", "output.publicationEvidence.accountMatches"],
  outputContracts: {
    publicUrl: { type: "https-url", allowedHosts: ["tiktok.com"] },
    publicationEvidence: { type: "json", equals: { platform: "tiktok" }, matches: { publicUrl: "output.publicUrl.url" } },
  },
};
const publicationEvidence = { version: 1, platform: "tiktok", published: true, publicUrl: "https://www.tiktok.com/@versa/video/123", accountMatches: true, publishedAt: "2026-08-24T01:00:00+08:00" };

test("executes completion rules and output contracts declared by workflow.md", async () => {
  const result = await validateDeclaredCompletion({ checkUrl: async () => true, instanceCreatedAt: "2026-08-24T00:00:00+08:00", loadArtifact: async () => ({ exists: true, json: publicationEvidence, mtimeMs: Date.now() }), manifest, stage });
  assert.equal(result.output.publicUrl.hostAllowed, true);
  assert.equal(result.output.publicationEvidence.published, true);
});

test("rejects an internal link without any platform-specific runtime branch", async () => {
  await assert.rejects(validateDeclaredCompletion({ checkUrl: async () => true, instanceCreatedAt: Date.now(), loadArtifact: async () => ({ exists: true, json: publicationEvidence, mtimeMs: Date.now() }), manifest: { ...manifest, outputs: [{ name: "publicUrl", artifact: "https://www.makaron.app/projects/internal" }, manifest.outputs[1]] }, stage }), /not allowed by the Workflow/);
});

test("rejects false evidence and mismatched cross-output values", async () => {
  await assert.rejects(validateDeclaredCompletion({ checkUrl: async () => true, instanceCreatedAt: Date.now(), loadArtifact: async () => ({ exists: true, json: { ...publicationEvidence, published: false }, mtimeMs: Date.now() }), manifest, stage }), /Completion rule failed/);
  await assert.rejects(validateDeclaredCompletion({ checkUrl: async () => true, instanceCreatedAt: Date.now(), loadArtifact: async () => ({ exists: true, json: { ...publicationEvidence, publicUrl: "https://www.tiktok.com/@versa/video/456" }, mtimeMs: Date.now() }), manifest, stage }), /does not match/);
});

test("derives common JSON completion facts without stage-specific code", async () => {
  const result = await validateDeclaredCompletion({ checkUrl: async () => true, instanceCreatedAt: "2026-08-24T00:00:00+08:00", loadArtifact: async () => ({ exists: true, json: { contentItems: [{ id: "one", title: "One" }] }, mtimeMs: Date.now() }), manifest: { outputs: [{ name: "contentItemsManifest", artifact: "content-items.json" }] }, stage: { completeWhen: ["output.contentItemsManifest.hasAtLeastOneItem", "output.contentItemsManifest.everyItemHasStableIdAndTitle"] } });
  assert.equal(result.output.contentItemsManifest.everyItemHasStableIdAndTitle, true);
});
