import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto, createHash } from "node:crypto";
import { canonicalJson, reviewContext, selectReviewItems, manifestDigest } from "./review.js";

const manifest = () => ({ version: 1, batchId: "F-TEST-1", review: { enabled: true, sourceProjectId: "F-TEST-1" }, items: Array.from({ length: 7 }, (_, i) => ({ id: `v${i}`, title: `视频${i}`, url: `https://cdn.makaron.app/${i}.mp4` })) });
test("ordinary D/E manifests never acquire review controls", () => {
  assert.equal(reviewContext({ version: 1, items: [] }), null);
  assert.equal(reviewContext({ version: 1, review: { enabled: false }, items: [] }), null);
});
test("selection refers to stable ids and preserves source order", () => {
  const context = reviewContext(manifest());
  const selected = selectReviewItems(context.items, ["v3", "v1"]);
  assert.equal(selected.accepted.length, 5);
  assert.deepEqual(selected.rejected.map(item => item.id), ["v1", "v3"]);
});
test("invalid batches, missing or duplicate ids and untrusted videos are visible errors, not silent approval", () => {
  for (const change of [raw => { raw.batchId = "D-TEST"; }, raw => { delete raw.items[0].id; }, raw => { raw.items[0].id = "v1"; }, raw => { raw.items[0].url = "https://unknown.example/a.mp4"; }]) {
    const raw = manifest(); change(raw); assert.throws(() => reviewContext(raw));
  }
});
test("browser and server agree on the frozen manifest digest even when object key order differs", async () => {
  const raw = manifest();
  const reordered = Object.fromEntries(Object.entries(raw).reverse());
  assert.equal(await manifestDigest(raw, webcrypto.subtle), createHash("sha256").update(canonicalJson(reordered)).digest("hex"));
});
