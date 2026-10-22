import assert from "node:assert/strict";
import test from "node:test";
import { access, link, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cdnHoldsCopy,
  compileWorkflow,
  FINALS_EVENT,
  loadWorkflow,
  NightShiftStore,
  planDeliveredFinals,
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

// Delivered finals. A download project's page serves every video from the CDN, so V's final is a
// backup once the CDN is seen to hold the same bytes (V, 2026-10-22: 70.8 GB in 114 projects).
const CDN = "https://cdn.makaron.app/storage/v1/object/public/images/x/media";
async function deliveredProject(root, id) {
  const dir = join(root, id);
  await put(dir, "content-items/a1/produce/final.mp4", "VIDEO-A1");
  await link(join(dir, "content-items/a1/produce/final.mp4"), join(dir, "content-items/a1/produce/final-copy.mp4"));
  await put(dir, "content-items/a1/produce/qc/frame.jpg", "frame");
  await put(dir, "content-items/a1/handoffs/produce.json", { outputs: [{ artifact: "content-items/a1/produce/final.mp4" }] });
  await put(dir, "content-items/a2/produce/final.mp4", "VIDEO-A2");
  await put(dir, "content-items/a3/produce/final.mp4", "VIDEO-A3-redone"); // the CDN has the earlier render
  await put(dir, "content-items/a4/produce/final.mp4", "VIDEO-A4"); // its suffix is a hash, not an id
  await put(dir, "content-items/a5/produce/final.mp4", "VIDEO-A5"); // delivered from another host
  await put(dir, "deliver-page/link-resolution.json", { items: [
    { contentItemId: "a1", url: `${CDN}/a1.mp4` },
    { contentItemId: "a5", url: "https://example.com/a5.mp4" },
  ] });
  await put(dir, "deliver-page/manifest.json", { version: 1, items: [
    { url: `${CDN}/a1.mp4`, fileName: "DL 企业 英语 One a1.mp4" },
    { url: `${CDN}/a2.mp4`, fileName: "DL 企业 英语 Two a2.mp4" },
    { url: `${CDN}/a3.mp4`, fileName: "DL 企业 英语 Three a3.mp4" },
    { url: `${CDN}/a4.mp4`, fileName: "DL 企业 英语 Four 9f3c2b1a.mp4" },
  ] });
  return dir;
}

function fakeCdn(lengths, { failing = new Set() } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url, options) => {
    calls.push({ url, method: options.method });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((done) => setTimeout(done, 2));
    inFlight -= 1;
    if (failing.has(url)) throw new Error("connect timeout");
    const length = lengths[url];
    return { status: length === undefined ? 404 : 200, headers: new Map([["content-length", String(length ?? 0)]]) };
  };
  return { fetch, calls, maxInFlight: () => maxInFlight };
}

test("only a delivered final with a cdn.makaron.app link is planned, with its hard links", async () => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-finals-"));
  const dir = await deliveredProject(root, "DL-1");
  const plan = await planDeliveredFinals(dir);
  assert.equal(plan.delivered, true);
  assert.deepEqual(plan.finals.map((final) => [final.contentItemId, final.url, final.links.map((file) => file.rel).sort()]).sort(), [
    ["a1", `${CDN}/a1.mp4`, ["content-items/a1/produce/final-copy.mp4", "content-items/a1/produce/final.mp4"]],
    ["a2", `${CDN}/a2.mp4`, ["content-items/a2/produce/final.mp4"]],
    ["a3", `${CDN}/a3.mp4`, ["content-items/a3/produce/final.mp4"]],
  ]);
  assert.equal(plan.notDelivered, 2, "a4 has no id or size to map and a5 is not on the CDN");
  // A page that ends names in a hash still names each video's size; a unique size maps it.
  await put(dir, "deliver-page/manifest.json", { version: 1, items: [
    { url: `${CDN}/a1.mp4`, fileName: "DL 企业 英语 One a1.mp4" },
    { url: `${CDN}/a4.mp4`, fileName: "DL 企业 英语 Four 9f3c2b1a.mp4", bytes: "VIDEO-A4".length + 100 },
    { url: `${CDN}/h1.mp4`, fileName: "DL 企业 英语 Hashed 1b2c3d4e.mp4", bytes: "VIDEO-A3-redone".length },
  ] });
  const bySize = await planDeliveredFinals(dir);
  assert.deepEqual(bySize.finals.map((final) => [final.contentItemId, final.url]).sort(), [["a1", `${CDN}/a1.mp4`], ["a3", `${CDN}/h1.mp4`]]);
  // Two videos of one size map to neither.
  await put(dir, "content-items/a6/produce/final.mp4", "VIDEO-A6-redone");
  assert.deepEqual((await planDeliveredFinals(dir)).finals.map((final) => final.contentItemId), ["a1"]);
  await put(root, "PUBLISH/content-items/p1/produce/final.mp4", "published");
  assert.deepEqual(await planDeliveredFinals(join(root, "PUBLISH")), { delivered: false, finals: [], notDelivered: 1 });
});

test("the CDN must answer 200 with the same length", async () => {
  const cdn = fakeCdn({ [`${CDN}/ok.mp4`]: 8, [`${CDN}/short.mp4`]: 7 }, { failing: new Set([`${CDN}/down.mp4`]) });
  assert.deepEqual(await cdnHoldsCopy(`${CDN}/ok.mp4`, 8, { fetch: cdn.fetch }), { verified: true });
  assert.match((await cdnHoldsCopy(`${CDN}/short.mp4`, 8, { fetch: cdn.fetch })).reason, /CDN has 7 bytes, V has 8/);
  assert.match((await cdnHoldsCopy(`${CDN}/gone.mp4`, 8, { fetch: cdn.fetch })).reason, /HEAD 404/);
  const down = await cdnHoldsCopy(`${CDN}/down.mp4`, 8, { fetch: cdn.fetch, attempts: 2 });
  assert.equal(down.unreachable, true);
  assert.ok(cdn.calls.every((call) => call.method === "HEAD"));
});

test("applied, finals the CDN holds go with their links, and the run is recorded once", async () => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-finals-"));
  const store = new NightShiftStore(":memory:");
  const release = compileWorkflow(await loadWorkflow(fixture));
  store.saveRelease(release, "workflow");
  const day = (n) => new Date(Date.parse("2026-10-01T00:00:00Z") + n * 86_400_000);
  const finish = (id, at) => {
    store.createInstance({ id, workflowSha256: release.metadata.workflowSha256 }, at);
    store.appendEvent({ instanceId: id, type: "instance.completed", now: at });
    store.updateInstanceStatus(id, "done", at);
  };
  const dir = await deliveredProject(root, "DL-1");
  await put(root, "PUBLISH/content-items/p1/produce/final.mp4", "published");
  await deliveredProject(root, "DL-RECENT");
  finish("DL-1", day(0));
  finish("PUBLISH", day(0));
  finish("DL-RECENT", day(18));
  const lengths = { [`${CDN}/a1.mp4`]: "VIDEO-A1".length, [`${CDN}/a2.mp4`]: "VIDEO-A2".length, [`${CDN}/a3.mp4`]: "VIDEO-A3".length };
  // a2's HEAD cannot reach the CDN on the first run.
  const first = fakeCdn(lengths, { failing: new Set([`${CDN}/a2.mp4`]) });
  const dry = await runRetention({ store, instancesRoot: root, now: day(20), minAgeDays: 30, finalsMinAgeDays: 7, fetch: first.fetch });
  assert.equal(first.calls.length, 0, "a plan fetches nothing");
  assert.deepEqual(dry.finals.projects.map((project) => [project.id, project.finals]).sort(), [["DL-1", 3], ["PUBLISH", 0]]);

  const applied = await runRetention({ store, instancesRoot: root, now: day(20), minAgeDays: 30, finalsMinAgeDays: 7, fetch: first.fetch, actor: "test", finalsConcurrency: 2, apply: true });
  assert.ok(first.maxInFlight() <= 2);
  assert.equal(applied.finals.finals, 1);
  assert.equal(await exists(join(dir, "content-items/a1/produce/final.mp4")), false);
  assert.equal(await exists(join(dir, "content-items/a1/produce/final-copy.mp4")), false, "the hard link goes too");
  assert.equal(applied.finals.bytes, "VIDEO-A1".length);
  for (const kept of ["a2", "a3", "a4", "a5"]) assert.equal(await exists(join(dir, `content-items/${kept}/produce/final.mp4`)), true, kept);
  assert.equal(await exists(join(root, "PUBLISH/content-items/p1/produce/final.mp4")), true);
  assert.equal(await exists(join(root, "DL-RECENT/content-items/a1/produce/final.mp4")), true);
  const ledger = JSON.parse(await readFile(join(dir, RETENTION_LEDGER), "utf8"));
  const [removedA1] = ledger.runs.at(-1).removedFinals;
  assert.deepEqual({ ...removedA1, files: [...removedA1.files].sort() },
    { contentItemId: "a1", files: ["content-items/a1/produce/final-copy.mp4", "content-items/a1/produce/final.mp4"], bytes: 8, cdn: `${CDN}/a1.mp4` });
  assert.deepEqual(ledger.runs.at(-1).keptFinals.map((entry) => [entry.contentItemId, entry.retry]).sort(), [["a2", true], ["a3", false]]);
  assert.equal(store.listEvents("DL-1", 20).filter((event) => event.type === FINALS_EVENT).length, 0, "an unreachable CDN leaves the project due");
  assert.equal(store.listEvents("PUBLISH", 20).filter((event) => event.type === FINALS_EVENT).length, 1, "a project without a delivery page is settled");

  const second = fakeCdn(lengths);
  const next = await runRetention({ store, instancesRoot: root, now: day(21), minAgeDays: 30, finalsMinAgeDays: 7, fetch: second.fetch, actor: "test", apply: true });
  assert.equal(next.finals.finals, 1);
  assert.equal(await exists(join(dir, "content-items/a2/produce/final.mp4")), false);
  assert.equal(await exists(join(dir, "content-items/a3/produce/final.mp4")), true, "a final redone after delivery stays");
  const event = store.listEvents("DL-1", 20).find((entry) => entry.type === FINALS_EVENT);
  assert.equal(event.payload.finals, 1);
  assert.equal(event.payload.kept, 1);
  assert.deepEqual((await runRetention({ store, instancesRoot: root, now: day(22), minAgeDays: 30, finalsMinAgeDays: 7, fetch: second.fetch })).finals.projects, []);
  assert.equal((await runRetention({ store, instancesRoot: root, now: day(22), minAgeDays: 30, fetch: second.fetch })).finals.projects.length, 0, "off unless asked");
});

test("an item whose final the CDN now holds still has a deliverable, so its working media is cleaned", async () => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-finals-"));
  const dir = await deliveredProject(root, "DL-2");
  const before = await planInstanceRetention(dir);
  assert.ok(before.remove.some((file) => file.rel === "content-items/a1/produce/qc/frame.jpg"));
  const store = new NightShiftStore(":memory:");
  const release = compileWorkflow(await loadWorkflow(fixture));
  store.saveRelease(release, "workflow");
  store.createInstance({ id: "DL-2", workflowSha256: release.metadata.workflowSha256 }, new Date("2026-10-01T00:00:00Z"));
  store.appendEvent({ instanceId: "DL-2", type: "instance.completed", now: new Date("2026-10-01T00:00:00Z") });
  store.updateInstanceStatus("DL-2", "done", new Date("2026-10-01T00:00:00Z"));
  await runRetention({ store, instancesRoot: root, now: new Date("2026-10-20T00:00:00Z"), minAgeDays: 30, finalsMinAgeDays: 7,
    fetch: fakeCdn({ [`${CDN}/a1.mp4`]: 8 }).fetch, apply: true });
  assert.equal(await exists(join(dir, "content-items/a1/produce/final.mp4")), false);
  const after = await planInstanceRetention(dir);
  assert.ok(after.remove.some((file) => file.rel === "content-items/a1/produce/qc/frame.jpg"), "a1 is not treated as an item without a final");
  assert.equal(after.keptWithoutReference, before.keptWithoutReference);
});
