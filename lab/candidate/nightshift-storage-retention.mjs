// Pre-merge candidate for finished-project storage retention (2026-10-14).
//
// Builds a private copy of V's projects from a fixture exported on V (its Night Shift database
// with project events, every non-media file of the finished projects plus a few recent and
// paused ones, and the path and size of every media file, recreated here as sparse files; the
// shared VLab's own copy has its media stripped). Runs this branch's Live Board server on the
// copy without a Gateway, and checks against the project trees that:
//   1. GET /api/storage/retention plans without touching a file;
//   2. the daily run fires at the configured hour and removes exactly the planned files;
//   3. nothing else changed: every other file is still there, every content item that had a
//      video still has one, and no JSON, Markdown or zip was removed;
//   4. every retained project has a ledger and a storage.retention event, and a second run
//      finds nothing to do.
//   5. recently finished and paused projects are untouched.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const FIXTURE = process.env.NIGHTSHIFT_RETENTION_FIXTURE ?? "/tmp/ns-retention-fixture.tgz";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const work = fs.mkdtempSync(path.join(process.env.VLAB_CANDIDATE_DATA ?? os.tmpdir(), "nightshift-retention-"));
const dataDir = path.join(work, "data");
const VIDEO = /\.(mp4|mov|webm)$/iu;

function walk(root) {
  const files = new Map();
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    files.set(path.relative(root, full), fs.statSync(full).size);
  }
  return files;
}

function itemsWithVideo(files) {
  const items = new Set();
  for (const rel of files.keys()) {
    const match = rel.match(/^([^/]+)\/content-items\/([^/]+)\//u);
    if (match && VIDEO.test(rel)) items.add(`${match[1]}/${match[2]}`);
  }
  return items;
}

async function startServer(port, env) {
  const childEnv = { ...process.env, NIGHTSHIFT_DATA_DIR: dataDir, NIGHTSHIFT_PORT: String(port), ...env };
  delete childEnv.OPENCLAW_CONFIG_PATH; // no Gateway: the server must not dispatch anything
  const child = spawn(process.execPath, ["--no-warnings", path.join(repo, "apps/nightshift-dashboard/server/index.mjs")], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  for (let i = 0; i < 120 && !log.includes("listening on"); i += 1) await sleep(500);
  assert(log.includes("listening on"), `server did not start:\n${log}`);
  return { child, log: () => log, stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); }) };
}

const api = async (port, method = "GET") => {
  const response = await fetch(`http://127.0.0.1:${port}/api/storage/retention`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify({ actor: "candidate" }) : undefined,
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};

const started = Date.now();
fs.mkdirSync(dataDir, { recursive: true });
assert.equal(spawnSync("tar", ["-xzf", FIXTURE, "-C", dataDir], { stdio: "inherit" }).status, 0);
const fixture = JSON.parse(fs.readFileSync(path.join(dataDir, "media.json"), "utf8"));
const instancesRoot = path.join(dataDir, "instances");
for (const [rel, size] of fixture.media) {
  fs.mkdirSync(path.dirname(path.join(instancesRoot, rel)), { recursive: true });
  fs.closeSync(fs.openSync(path.join(instancesRoot, rel), "w"));
  fs.truncateSync(path.join(instancesRoot, rel), size);
}
const before = walk(instancesRoot);
const videoItemsBefore = itemsWithVideo(before);
console.log(`built ${before.size} files (${fixture.media.length} media) in ${fs.readdirSync(instancesRoot).length} projects (${((Date.now() - started) / 1000).toFixed(0)} s)`);

try {
  // 1. Plan only.
  const planning = await startServer(24991, { NIGHTSHIFT_RETENTION_DISABLED: "1" });
  const plan = await api(24991);
  await planning.stop();
  assert.equal(plan.apply, false);
  assert.deepEqual(new Set(plan.projects.map((project) => project.id)), new Set(fixture.eligible), "plans exactly the finished projects");
  assert(plan.files > 0);
  assert.deepEqual(walk(instancesRoot), before, "planning changed no file");
  console.log(`plan: ${plan.projects.length} projects, ${plan.files} files, ${(plan.bytes / 2 ** 20).toFixed(1)} MiB`);

  // 2. The daily run at this hour.
  const daily = await startServer(24992, { NIGHTSHIFT_RETENTION_HOUR: String(new Date().getHours()), NIGHTSHIFT_RETENTION_CHECK_MS: "1000" });
  for (let i = 0; i < 600 && !/storage retention (removed|failed)/u.test(daily.log()); i += 1) await sleep(500);
  const status = await api(24992);
  const second = await api(24992, "POST");
  await daily.stop();
  assert.match(daily.log(), /storage retention removed/u, daily.log());
  assert.equal(status.last.actor, "nightshift-retention");
  assert.equal(status.last.files, plan.files);
  assert.equal(status.last.bytes, plan.bytes);
  assert.equal(status.projects.length, 0, "nothing left to plan after the daily run");
  assert.equal(second.projects.length, 0, "a second run finds nothing to do");

  // 3. Exactly the planned files went; everything else stayed.
  const after = walk(instancesRoot);
  const ledgers = [...after.keys()].filter((rel) => rel.endsWith("/retention-ledger.json"));
  const removed = [...before.keys()].filter((rel) => !after.has(rel));
  const planned = new Set();
  for (const ledger of ledgers) {
    const project = ledger.split("/")[0];
    for (const run of JSON.parse(fs.readFileSync(path.join(instancesRoot, ledger), "utf8")).runs) {
      for (const file of run.removed) planned.add(`${project}/${file.rel}`);
    }
  }
  assert.equal(removed.length, plan.files);
  assert.deepEqual(new Set(removed), planned, "removed files are exactly the ledgered ones");
  assert.deepEqual(removed.filter((rel) => /\.(json|md|txt|zip|html|srt|csv|ya?ml)$/iu.test(rel)), []);
  for (const rel of after.keys()) if (!rel.endsWith("/retention-ledger.json")) assert.equal(after.get(rel), before.get(rel), rel);
  assert.deepEqual([...videoItemsBefore].filter((item) => !itemsWithVideo(after).has(item)), [], "every item keeps a video");

  for (const id of [...fixture.recent, ...fixture.paused]) {
    assert.deepEqual(removed.filter((rel) => rel.startsWith(`${id}/`)), [], `${id} is untouched`);
  }

  // 4. Records.
  const db = new DatabaseSync(path.join(dataDir, "nightshift.sqlite"), { readOnly: true });
  const events = db.prepare("SELECT instance_id, payload_json FROM audit_events WHERE type = 'storage.retention'").all();
  db.close();
  assert.equal(events.length, plan.projects.length);
  assert.equal(ledgers.length, plan.projects.length);
  assert.equal(events.reduce((sum, event) => sum + JSON.parse(event.payload_json).files, 0), plan.files);

  const sample = removed.slice(0, 8).join("\n  ");
  console.log(`daily run removed ${removed.length} files (${(plan.bytes / 2 ** 30).toFixed(2)} GiB) from ${plan.projects.length} projects; ${videoItemsBefore.size} items with video all keep one; ${fixture.recent.length} recent and ${fixture.paused.length} paused projects untouched`);
  console.log(`sample:\n  ${sample}`);
  console.log("PASS nightshift storage retention");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
