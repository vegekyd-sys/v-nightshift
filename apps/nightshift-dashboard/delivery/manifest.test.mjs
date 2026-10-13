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

test("names are the Agent's; only characters Windows refuses are replaced", () => {
  // V, 2026-09-30: a title with ? and : hid 14 of 20 videos when unzipped.
  assert.equal(safeFileName('Is it "real"? A: yes / no.mp4'), "Is it real A yes no.mp4");
  assert.equal(safeFileName("结尾有点..."), "结尾有点");
  const long = `DL 广东哆比 阿拉伯语 ${"很长的标题".repeat(20)} a1b2c3d4.mov`;
  const { delivery } = readManifest({
    version: 1,
    title: "广东哆比 阿拉伯语 2条",
    archiveName: "DL 2026-10-02 广东哆比 阿拉伯语 2条 a1b2c3d4",
    items: [
      { title: "a", url: `${CDN}/a.mov`, fileName: long },
      { title: "封面", url: `${CDN}/cover.jpg` },
    ],
  });
  assert.equal(delivery.items[0].fileName, long, "no length cut, no extension forced");
  assert.equal(delivery.items[1].fileName, "封面.jpg", "without a fileName: the title plus the URL's extension");
  assert.equal(delivery.archiveName, "DL 2026-10-02 广东哆比 阿拉伯语 2条 a1b2c3d4.zip");
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
  assert.equal(delivery.archiveName, "客户 英语 3条.zip", "without an archiveName the zip takes the title");
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

test("reviewable F manifests retain stable item identity without changing legacy delivery", () => {
  const { delivery } = readManifest({ version: 1, title: "F测试", items: [{ id: "video-01", title: "第一条", url: `${CDN}/a.mp4` }] });
  assert.equal(delivery.items[0].id, "video-01", "review submission must refer to the production item, not a page index");
  const legacy = readManifest({ version: 1, items: [{ title: "a", url: `${CDN}/a.mp4` }] }).delivery;
  assert.equal(Object.hasOwn(legacy.items[0], "id"), false);
});
