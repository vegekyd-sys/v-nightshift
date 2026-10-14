import assert from "node:assert/strict";
import test from "node:test";
import { access, link, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileWorkflow,
  loadWorkflow,
  NightShiftStore,
  planInstanceRetention,
  RETENTION_LEDGER,
  runRetention,
} from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");

async function put(root, rel, content = "x") {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), typeof content === "string" ? content : JSON.stringify(content));
}

const exists = (path) => access(path).then(() => true, () => false);

async function project(root, id) {
  const dir = join(root, id);
  await put(dir, "content-items/w1/produce/final.mp4", "FINAL-VIDEO");
  await put(dir, "content-items/w1/produce/finishedAsset.json", { sha256: "abc" });
  await put(dir, "content-items/w1/produce/poster.jpg", "poster");
  await put(dir, "content-items/w1/produce/qc/src/src1.mp4", "source-1");
  await put(dir, "content-items/w1/produce/qc/frame-001.jpg", "frame");
  await put(dir, "content-items/w1/evidence/assets/ref.png", "reference");
  await put(dir, "content-items/w1/keep/clip.mov", "kept by directory reference");
  await put(dir, "content-items/w1/absolute.wav", "kept by absolute reference");
  await put(dir, "content-items/w1/result.mp4", "kept by handoff-relative reference");
  await put(dir, "content-items/w1/handoffs/produce.json", {
    outputs: [
      { artifact: "content-items/w1/produce/final.mp4" },
      { artifact: "produce/poster.jpg" },
      { artifact: "content-items/w1/keep" },
      { artifact: join(dir, "content-items/w1/absolute.wav") },
      { artifact: "../result.mp4" },
    ],
  });
  // An item whose workflow recorded nothing keeps all of its media.
  await put(dir, "content-items/w2/render/cut.mp4", "unreferenced item");
  // deliverables.json paths are relative to the item.
  await put(dir, "content-items/w3/deliverables.json", { version: 1, video: { path: "out/cut.mp4", posterPath: "out/cover.png" } });
  await put(dir, "content-items/w3/out/cut.mp4", "manifest video");
  await put(dir, "content-items/w3/out/cover.png", "manifest poster");
  await put(dir, "content-items/w3/out/rough.mp4", "rough cut");
  // Delivery copies: an exact-size duplicate of a kept final goes, anything else stays.
  await put(dir, "deliver-download/package/w1.mp4", "FINAL-VIDEO");
  await link(join(dir, "content-items/w1/produce/final.mp4"), join(dir, "deliver-download/package/w1-linked.mp4"));
  await put(dir, "deliver-download/package/other.mp4", "a different video");
  await put(dir, "deliver-download/package/same-size.mp4", "FINAL-VIDEX"); // same size, other bytes
  await put(dir, "deliver-download/oss-delivery.json", { uploaded: true });
  await put(dir, "deliver-download/delivery-package.zip", "zip");
  return dir;
}

test("plans to remove only unreferenced working media of items that keep a deliverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-retention-"));
  const dir = await project(root, "NS-1");
  const plan = await planInstanceRetention(dir);
  assert.deepEqual(plan.remove.map((file) => [file.rel, file.reason]).sort(), [
    ["content-items/w1/evidence/assets/ref.png", "intermediate"],
    ["content-items/w1/produce/qc/frame-001.jpg", "intermediate"],
    ["content-items/w1/produce/qc/src/src1.mp4", "intermediate"],
    ["content-items/w3/out/rough.mp4", "intermediate"],
    ["deliver-download/package/same-size.mp4", "duplicate-of-deliverable"],
    ["deliver-download/package/w1.mp4", "duplicate-of-deliverable"],
  ]);
  assert.equal(plan.keptWithoutReference, 1);
  assert.equal(plan.bytes, plan.remove.reduce((sum, file) => sum + file.bytes, 0));
});

test("applies retention once to projects finished long enough ago and records it", async () => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-retention-"));
  const store = new NightShiftStore(":memory:");
  const release = compileWorkflow(await loadWorkflow(fixture));
  store.saveRelease(release, "workflow");
  const day = (n) => new Date(Date.parse("2026-10-01T00:00:00Z") + n * 86_400_000);
  const finish = (id, at, status = "done") => {
    store.createInstance({ id, workflowSha256: release.metadata.workflowSha256 }, at);
    store.appendEvent({ instanceId: id, type: "instance.completed", now: at });
    store.updateInstanceStatus(id, status, at);
  };
  for (const id of ["OLD", "RECENT", "ARCHIVED", "PAUSED", "ABANDONED"]) await project(root, id);
  finish("OLD", day(0));
  finish("NO-DIRECTORY", day(0)); // a finished canary on V has no project directory
  finish("RECENT", day(10));
  finish("ARCHIVED", day(1), "archived");
  store.createInstance({ id: "PAUSED", workflowSha256: release.metadata.workflowSha256 }, day(0));
  store.updateInstanceStatus("PAUSED", "paused", day(0));
  store.createInstance({ id: "ABANDONED", workflowSha256: release.metadata.workflowSha256 }, day(0));
  store.archiveInstance("ABANDONED", day(0));

  const now = day(20);
  const dry = await runRetention({ store, instancesRoot: root, now });
  assert.deepEqual(dry.projects.map((entry) => [entry.id, entry.files]).sort(), [["ARCHIVED", 6], ["NO-DIRECTORY", 0], ["OLD", 6]]);
  assert.equal(await exists(join(root, "OLD/content-items/w1/produce/qc/src/src1.mp4")), true);

  const applied = await runRetention({ store, instancesRoot: root, now, apply: true, actor: "test" });
  // The same-size delivery file with other bytes is planned but kept.
  assert.equal(applied.files, 10);
  assert.equal(await exists(join(root, "OLD/deliver-download/package/same-size.mp4")), true);
  assert.equal(await exists(join(root, "OLD/deliver-download/package/w1.mp4")), false);
  assert.equal(await exists(join(root, "OLD/deliver-download/package/w1-linked.mp4")), true);
  assert.equal(applied.errors, 0);
  assert.equal(await exists(join(root, "NO-DIRECTORY")), false);
  assert.equal(applied.bytes, dry.bytes - 2 * "FINAL-VIDEX".length);
  assert.equal(await exists(join(root, "OLD/content-items/w1/produce/qc/src/src1.mp4")), false);
  assert.equal(await exists(join(root, "OLD/content-items/w1/produce/final.mp4")), true);
  assert.equal(await exists(join(root, "OLD/deliver-download/delivery-package.zip")), true);
  assert.equal(await exists(join(root, "RECENT/content-items/w1/produce/qc/src/src1.mp4")), true);
  assert.equal(await exists(join(root, "PAUSED/content-items/w1/produce/qc/src/src1.mp4")), true);
  assert.equal(await exists(join(root, "ABANDONED/content-items/w1/produce/qc/src/src1.mp4")), true);

  const ledger = JSON.parse(await readFile(join(root, "OLD", RETENTION_LEDGER), "utf8"));
  assert.equal(ledger.runs.length, 1);
  assert.equal(ledger.runs[0].removed.length, 5);
  assert.deepEqual(ledger.runs[0].keptNotIdentical, ["deliver-download/package/same-size.mp4"]);
  const event = store.listEvents("OLD", 10).find((entry) => entry.type === "storage.retention");
  assert.equal(event.payload.files, 5);
  assert.equal(event.payload.actor, "test");

  // Already retained: the next day's run leaves the project alone.
  assert.deepEqual((await runRetention({ store, instancesRoot: root, now: day(21) })).projects, []);
});
