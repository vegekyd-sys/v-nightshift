import assert from "node:assert/strict";
import test from "node:test";

import { readManifest, safeFileName, trustedUrl } from "./manifest.js";

const CDN = "https://cdn.makaron.app/storage/v1/object/public/images";

test("only https URLs on the trusted CDNs are shown", () => {
  assert.ok(trustedUrl(`${CDN}/a.mp4`));
  assert.ok(trustedUrl("https://orywxdeppjtwckzqehpr.supabase.co/storage/v1/object/public/x/a.mp4"));
  assert.equal(trustedUrl("http://cdn.makaron.app/a.mp4"), null);
  assert.equal(trustedUrl("https://v3b.fal.media/files/a.mp4"), null);
  assert.equal(trustedUrl("https://cdn.makaron.app.evil.example/a.mp4"), null);
  assert.equal(trustedUrl("javascript:alert(1)"), null);
});

test("file names are safe on Windows", () => {
  // V, 2026-09-30: a title with ? and : hid 14 of 20 videos when unzipped.
  assert.equal(safeFileName('Is it "real"? A: yes / no'), "Is it real A yes no.mp4");
  assert.equal(safeFileName("结尾有点..."), "结尾有点.mp4");
  assert.equal(safeFileName("clip.mp4"), "clip.mp4");
  assert.equal(safeFileName("", "video"), "video.mp4");
});

test("a manifest becomes what the page shows; untrusted videos are left out", () => {
  const { delivery, rejected } = readManifest({
    version: 1,
    title: "客户 英语 3条",
    deliveredAt: "2026-10-02T08:00:00+08:00",
    items: [
      { title: "第一条", url: `${CDN}/a.mp4`, bytes: 100, durationSec: 20.1 },
      { title: "第一条", url: `${CDN}/b.mp4`, bytes: 200 },
      { title: "临时地址", url: "https://v3b.fal.media/files/c.mp4" },
    ],
  });
  assert.equal(delivery.title, "客户 英语 3条");
  assert.equal(delivery.archiveName, "客户 英语 3条.zip");
  assert.deepEqual(delivery.items.map((item) => item.fileName), ["第一条.mp4", "第一条 (2).mp4"], "two items never share a name in the zip");
  assert.equal(delivery.totalBytes, 300);
  assert.deepEqual(rejected, [{ index: 2, title: "临时地址" }]);
});

test("a manifest without sizes still shows, without a total", () => {
  const { delivery } = readManifest({ version: 1, title: "x", items: [{ title: "a", url: `${CDN}/a.mp4` }] });
  assert.equal(delivery.totalBytes, null);
  assert.equal(delivery.items[0].bytes, null);
});

test("anything that is not a version 1 manifest is refused", () => {
  for (const raw of [null, {}, { version: 2, items: [] }, { version: 1, items: "x" }]) {
    assert.throws(() => readManifest(raw), /格式不对/);
  }
});
