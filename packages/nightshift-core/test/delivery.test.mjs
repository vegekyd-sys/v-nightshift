import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeliveryManifest,
  deliveryFileName,
  deliveryTitle,
  ledgerVideoUrl,
  publicDelivery,
} from "../src/delivery.mjs";
import { completionPresentation } from "../src/notifications.mjs";
import { NightShiftStore } from "../src/store.mjs";

const CDN = "https://cdn.makaron.app/storage/v1/object/public/images/x";

test("titles drop the delivery-mode suffix", () => {
  assert.equal(deliveryTitle("广东哆比 阿拉伯语 20条（下载交付）"), "广东哆比 阿拉伯语 20条");
  assert.equal(deliveryTitle("Plain"), "Plain");
});

test("file names are safe on Windows and keep the item apart", () => {
  // V, 2026-09-30: a Korean title with ? and : hid 14 of 20 videos when
  // the customer unzipped the package on Windows.
  assert.equal(deliveryFileName('Is it "real"? A: yes / no', "item-07"), "Is it real A yes no item-07.mp4");
  assert.equal(deliveryFileName("结尾有点...", "x1"), "结尾有点 x1.mp4");
  assert.equal(deliveryFileName("", ""), "video.mp4");
  assert.ok(Array.from(deliveryFileName("长".repeat(200), "id")).length <= 60 + 8);
});

test("a produce call's URL is read from the ledger when the stage wrote only the video", () => {
  const operations = [
    { contentItemId: "a", stageId: "produce", status: "succeeded", updatedAt: "2026-09-30T01:00:00Z", result: { videoUrl: `${CDN}/old.mp4` } },
    { contentItemId: "a", stageId: "produce", status: "succeeded", updatedAt: "2026-09-30T02:00:00Z", result: { videoUrl: `${CDN}/new.mp4` } },
    { contentItemId: "a", stageId: "deliver", status: "succeeded", result: { publicUrls: [`${CDN}/zip.zip`] } },
    { contentItemId: "b", stageId: "produce", status: "reserved", result: null },
  ];
  assert.equal(ledgerVideoUrl(operations, "a"), `${CDN}/new.mp4`);
  assert.equal(ledgerVideoUrl(operations, "b"), null);
});

function project(items) {
  return {
    instance: { id: "DL-1", name: "客户 英语 3条（下载交付）" },
    contentItems: items.map(({ id, title }) => ({ id, title })),
    readAsset: async (id) => items.find((item) => item.id === id).found,
    probe: async (url) => ({ ok: true, status: 200, bytes: items.find((item) => url.endsWith(`/${item.id}.mp4`) || url.endsWith(`/${item.id}-upload.mp4`))?.cdnBytes }),
  };
}

test("the manifest takes each video at its CDN URL when the CDN serves the same file", async () => {
  const { manifest, missing } = await buildDeliveryManifest({
    ...project([
      { id: "v1", title: "First", found: { asset: { sourceUrl: `${CDN}/v1.mp4`, durationSec: 20.1, resolution: "1080x1920" }, bytes: 100 }, cdnBytes: 100 },
      { id: "v2", title: "Second", found: { asset: null, bytes: 200, ledgerUrl: `${CDN}/v2.mp4`, durationSec: 15 }, cdnBytes: 200 },
    ]),
    now: new Date("2026-10-02T05:00:00Z"),
  });
  assert.deepEqual(missing, []);
  assert.equal(manifest.project.title, "客户 英语 3条");
  assert.deepEqual(manifest.items.map((item) => [item.url, item.bytes, item.durationSec]), [
    [`${CDN}/v1.mp4`, 100, 20.1],
    [`${CDN}/v2.mp4`, 200, 15],
  ]);
  assert.equal(manifest.totalBytes, 300);
});

test("a video the CDN does not serve as finished is missing, with the reason the Agent acts on", async () => {
  const { manifest, missing } = await buildDeliveryManifest(project([
    { id: "same", title: "OK", found: { asset: null, bytes: 10, ledgerUrl: `${CDN}/same.mp4` }, cdnBytes: 10 },
    { id: "edited", title: "Edited after Makaron", found: { asset: { sourceUrl: `${CDN}/edited.mp4` }, bytes: 99 }, cdnBytes: 50 },
    { id: "nourl", title: "No URL", found: { asset: null, bytes: 10 } },
    { id: "fal", title: "Temporary host", found: { asset: { videoUrl: "https://v3b.fal.media/files/fal.mp4" }, bytes: 10 } },
    { id: "gone", title: "No video", found: null },
  ]));
  assert.deepEqual(manifest.items.map((item) => item.id), ["same"]);
  assert.deepEqual(missing.map((entry) => entry.id), ["edited", "nourl", "fal", "gone"]);
  assert.match(missing.find((entry) => entry.id === "edited").reason, /not the same file/);
  assert.match(missing.find((entry) => entry.id === "fal").reason, /not an allowed delivery host/);
});

test("an uploaded URL passed by the Agent is used, and skipped items stay out", async () => {
  const { manifest, missing } = await buildDeliveryManifest({
    ...project([
      { id: "nourl", title: "Uploaded", found: { asset: null, bytes: 10 }, cdnBytes: 10 },
      { id: "skip", title: "Skipped", found: null },
    ]),
    sources: { nourl: `${CDN}/nourl-upload.mp4` },
    skippedIds: new Set(["skip"]),
  });
  assert.deepEqual(missing, []);
  assert.equal(manifest.items[0].url, `${CDN}/nourl-upload.mp4`);
});

test("the public form shows what the page needs and nothing internal", () => {
  const view = publicDelivery({
    updatedAt: "2026-10-02T05:00:00Z",
    manifest: { project: { id: "DL-1", title: "客户", deliveredAt: "x" }, totalBytes: 1, items: [{ id: "v1", title: "T", url: `${CDN}/v1.mp4`, fileName: "T v1.mp4", bytes: 1, durationSec: 1, resolution: null }] },
  });
  assert.equal(view.title, "客户");
  assert.equal(view.archiveName, "客户.zip");
  assert.deepEqual(Object.keys(view.items[0]).sort(), ["bytes", "durationSec", "fileName", "resolution", "title", "url"]);
  assert.equal(JSON.stringify(view).includes("DL-1"), false);
});

test("publishing again keeps the link already sent", () => {
  const store = new NightShiftStore();
  const first = store.upsertDelivery({ instanceId: "DL-1", manifest: { items: [1] }, token: "tokentokentoken01" });
  const again = store.upsertDelivery({ instanceId: "DL-1", manifest: { items: [1, 2] }, token: "anothertokentoken" });
  assert.equal(again.token, first.token);
  assert.equal(store.getDeliveryByToken(first.token).manifest.items.length, 2);
  assert.equal(store.getDeliveryByToken("anothertokentoken"), null);
  store.close();
});

test("the completion notice opens the delivery page first", () => {
  const card = completionPresentation({
    instance: { id: "DL-1", name: "客户" },
    projectUrl: "https://board/?project=DL-1",
    summary: { done: 3, blocked: 0 },
    deliveryUrl: "https://board/d/token",
    deliveredCount: 3,
  });
  const buttons = card.blocks.find((block) => block.type === "buttons").buttons;
  assert.deepEqual(buttons.map((button) => button.label), ["打开交付页", "查看项目"]);
  assert.equal(buttons[0].url, "https://board/d/token");
});
