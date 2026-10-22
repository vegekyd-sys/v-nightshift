import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { artifactFromHandoffDirectory, instanceRelativeArtifactPath, normalizeArtifactPath } from "./deliverables.mjs";
import { setImmediate as nextTurn } from "node:timers/promises";

// Finished projects keep their deliverables and records and drop the working media that
// produced them. On V on 2026-10-14 the instance data disk (197 GB) filled up with finished
// projects' QC frames, reference clips, render masters, downloaded Scene sources and duplicate
// delivery copies; nothing ever removed them, and agents of running projects hit ENOSPC.
//
// A file is removed only when all of these hold:
//   - its project finished (done, or archived after completing) at least `minAgeDays` ago;
//   - it is a media file (video, image, audio or probe dump; never JSON, Markdown, text, zip);
//   - no stage handoff or deliverables.json names it (or a directory holding it), and it is
//     not a final.* render;
//   - its content item still has a kept deliverable (an item where nothing is referenced keeps
//     everything, so a project written by an older workflow loses nothing);
//   - in a delivery folder, it is a separate copy of a kept deliverable: planned by size, removed
//     only when its bytes are the same (hard links take no space and stay).
// Every applied run writes retention-ledger.json in the project and a storage.retention event.
//
// Delivered finals go later, on their own schedule (finalsMinAgeDays). A project's delivery page
// already serves every video from the CDN, so V's copy of a delivered final.* is a backup. It is
// removed only when the project has a delivery page, the page names the item's cdn.makaron.app
// URL, and a fresh HEAD on that URL answers 200 with the local file's exact length; hard links of
// it inside the project go with it. On V on 2026-10-22 a one-off run of this rule freed 70.8 GB
// (2,278 finals in 114 projects) and kept 7 whose CDN copy no longer matched (redone after
// delivery). Each applied run writes the ledger and a storage.retention.finals event.

export const RETENTION_LEDGER = "retention-ledger.json";
export const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff",
  ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg",
  ".bin",
]);
const DAY_MS = 86_400_000;

async function listFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        const stat = await lstat(path);
        files.push({ path, rel: relative(root, path).split(sep).join("/"), bytes: stat.size, inode: stat.ino, links: stat.nlink });
      }
    }
  }
  return files;
}

function contentItemOf(rel) {
  const parts = rel.split("/");
  return parts[0] === "content-items" && parts.length > 2 ? parts[1] : null;
}

function isDeliveryFolder(rel) {
  return /deliver/i.test(rel.split("/")[0]);
}

function toInstancePath(instanceDir, value) {
  try {
    return normalizeArtifactPath(instanceRelativeArtifactPath(value, [instanceDir]));
  } catch {
    return null;
  }
}

// Every path a stage handoff or a deliverables manifest names. Handoffs cite artifacts relative to
// the project, relative to their own directory ("../result.json"), relative to their content item,
// or absolute; each reading is kept, since keeping a file too many costs only disk.
async function referencedArtifacts(instanceDir, files) {
  const refs = new Set();
  const add = (value) => {
    const path = toInstancePath(instanceDir, value);
    if (path) refs.add(path);
  };
  for (const file of files) {
    const parts = file.rel.split("/");
    const item = contentItemOf(file.rel);
    const itemPrefix = item ? `content-items/${item}/` : "";
    if (parts.at(-2) === "handoffs" && file.rel.endsWith(".json")) {
      const handoff = await readJson(file.path);
      for (const entry of [...(handoff?.inputs ?? []), ...(handoff?.outputs ?? [])]) {
        if (typeof entry?.artifact !== "string") continue;
        const artifact = entry.artifact.trim();
        add(artifactFromHandoffDirectory(artifact, dirname(file.path)));
        if (itemPrefix && !isAbsolute(artifact)) add(`${itemPrefix}${artifact}`);
      }
    } else if (parts.at(-1) === "deliverables.json") {
      const manifest = await readJson(file.path);
      const base = parts.slice(0, -1).join("/");
      for (const path of [
        manifest?.proposal?.summaryPath,
        manifest?.video?.path,
        manifest?.video?.posterPath,
        manifest?.qc?.reportPath,
        manifest?.qc?.duplicateCheck?.reportPath,
      ]) {
        if (typeof path === "string" && path.trim()) add(base ? `${base}/${path.trim()}` : path);
      }
    }
  }
  return refs;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function isReferenced(refs, rel) {
  if (refs.has(rel)) return true;
  // A reference to a directory keeps everything in it.
  for (let index = rel.lastIndexOf("/"); index > 0; index = rel.lastIndexOf("/", index - 1)) {
    if (refs.has(rel.slice(0, index))) return true;
  }
  return false;
}

// Content items whose final an earlier run removed because the CDN holds it: they still have a
// deliverable, so their working media is cleaned like any other delivered item's.
async function itemsWithRemovedFinal(instanceDir) {
  const ledger = await readJson(join(instanceDir, RETENTION_LEDGER));
  const items = new Set();
  for (const run of ledger?.runs ?? []) {
    for (const entry of run?.removedFinals ?? []) {
      if (typeof entry?.contentItemId === "string" && entry.contentItemId) items.add(entry.contentItemId);
    }
  }
  return items;
}

/** What retention would remove from one finished project directory. Reads only. */
export async function planInstanceRetention(instanceDir) {
  const files = await listFiles(instanceDir);
  const refs = await referencedArtifacts(instanceDir, files);
  const isMedia = (file) => MEDIA_EXTENSIONS.has(extname(file.rel).toLowerCase());
  const isKeptDeliverable = (file) => isReferenced(refs, file.rel) || /^final\./iu.test(basename(file.rel));
  const deliverablesBySize = new Map();
  const itemsWithDeliverable = new Set();
  for (const file of files) {
    if (!isMedia(file) || !isKeptDeliverable(file) || isDeliveryFolder(file.rel)) continue;
    deliverablesBySize.set(file.bytes, [...(deliverablesBySize.get(file.bytes) ?? []), file]);
    const item = contentItemOf(file.rel);
    if (item) itemsWithDeliverable.add(item);
  }
  for (const item of await itemsWithRemovedFinal(instanceDir)) itemsWithDeliverable.add(item);
  const remove = [];
  let keptWithoutReference = 0;
  for (const file of files) {
    if (!isMedia(file) || isKeptDeliverable(file) || file.rel === RETENTION_LEDGER) continue;
    if (isDeliveryFolder(file.rel)) {
      const originals = deliverablesBySize.get(file.bytes);
      // A hard link to a deliverable takes no space of its own; it stays.
      if (originals && !originals.some((original) => original.inode === file.inode)) {
        remove.push({ ...file, reason: "duplicate-of-deliverable", originals });
      }
      continue;
    }
    const item = contentItemOf(file.rel);
    if (item && !itemsWithDeliverable.has(item)) {
      keptWithoutReference += 1;
      continue;
    }
    if (!item && itemsWithDeliverable.size === 0) {
      keptWithoutReference += 1;
      continue;
    }
    remove.push({ ...file, reason: "intermediate" });
  }
  return {
    files: files.length,
    referenced: refs.size,
    keptWithoutReference,
    remove,
    bytes: remove.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/**
 * Finished projects (done, or archived after they completed) that finished at least minAgeDays
 * ago and were not retained since, oldest first. Paused and abandoned projects are never touched.
 */
export function retentionCandidates(store, { now = new Date(), minAgeDays = 14, eventType = "storage.retention" } = {}) {
  const completed = store.latestEventTimes("instance.completed");
  const retained = store.latestEventTimes(eventType);
  const cutoff = now.getTime() - minAgeDays * DAY_MS;
  return store.listInstances()
    .filter((instance) => instance.status === "done" || (instance.status === "archived" && completed.has(instance.id)))
    .map((instance) => ({ instance, finishedAt: completed.get(instance.id) ?? instance.updatedAt }))
    .filter(({ finishedAt }) => Date.parse(finishedAt) <= cutoff)
    .filter(({ instance, finishedAt }) => !retained.has(instance.id) || retained.get(instance.id) < finishedAt)
    .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// Size picks the candidates; removal needs the same bytes.
async function isCopyOfAny(file, originals = [], digests = new Map()) {
  const digestOf = async (path) => {
    if (!digests.has(path)) digests.set(path, await sha256(path));
    return digests.get(path);
  };
  const digest = await digestOf(file.path);
  for (const original of originals) {
    if (await digestOf(original.path) === digest) return true;
  }
  return false;
}

async function appendLedger(instanceDir, run) {
  const path = join(instanceDir, RETENTION_LEDGER);
  let ledger = { version: 1, runs: [] };
  try {
    ledger = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  ledger.runs.push(run);
  await writeFile(`${path}.tmp`, `${JSON.stringify(ledger, null, 1)}\n`);
  await rename(`${path}.tmp`, path);
}

async function retainInstance({ store, instance, finishedAt, instanceDir, now, minAgeDays, apply, actor }) {
  const plan = await planInstanceRetention(instanceDir);
  let removed = 0;
  let bytes = 0;
  const skipped = [];
  const digests = new Map();
  if (apply) {
    for (const [index, file] of plan.remove.entries()) {
      if (file.reason === "duplicate-of-deliverable" && !(await isCopyOfAny(file, file.originals, digests))) {
        skipped.push(file.rel);
        continue;
      }
      try {
        await unlink(file.path);
        removed += 1;
        bytes += file.bytes;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (index % 50 === 49) await nextTurn();
    }
    if (plan.files > 0) {
      await appendLedger(instanceDir, {
        at: now.toISOString(),
        minAgeDays,
        actor,
        removed: plan.remove.filter((file) => !skipped.includes(file.rel)).map(({ rel, bytes: size, reason }) => ({ rel, bytes: size, reason })),
        keptNotIdentical: skipped,
        keptWithoutReference: plan.keptWithoutReference,
      });
    }
    store.appendEvent({
      instanceId: instance.id,
      type: "storage.retention",
      payload: { version: 1, finishedAt, files: removed, bytes, keptWithoutReference: plan.keptWithoutReference, actor },
      now,
    });
  }
  return {
    id: instance.id,
    finishedAt,
    files: apply ? removed : plan.remove.length,
    bytes: apply ? bytes : plan.bytes,
    keptWithoutReference: plan.keptWithoutReference,
  };
}

export const FINALS_EVENT = "storage.retention.finals";
const FINAL_FILE = /^final\.(?:mp4|mov|webm)$/iu;
const CDN_HOST = "cdn.makaron.app";

function cdnUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" && url.hostname === CDN_HOST ? url.href : null;
  } catch {
    return null;
  }
}

// The URL the delivery page gave each content item. link-resolution.json records it per item
// (items[].contentItemId, or itemsList[].id in older pages). Otherwise the manifest's fileName ends
// in "<suffix>.mp4", taken when the suffix is the id of an item of this project; failing that, the
// manifest entry's bytes name the one final of that exact size. Pages that end the name in a short
// hash (DL-1020-*) have only the size: 670 finals on V on 2026-10-22. Either way the CDN copy is
// checked against the local bytes before anything goes.
async function deliveredUrls(instanceDir, itemIds, finals = []) {
  const urls = new Map();
  const resolution = await readJson(join(instanceDir, "deliver-page", "link-resolution.json"));
  for (const entry of [...(resolution?.items ?? []), ...(resolution?.itemsList ?? [])]) {
    const id = entry?.contentItemId ?? entry?.id;
    const url = cdnUrl(entry?.url);
    if (typeof id === "string" && url && !urls.has(id)) urls.set(id, url);
  }
  const manifest = await readJson(join(instanceDir, "deliver-page", "manifest.json"));
  const bySize = [];
  for (const entry of manifest?.items ?? []) {
    const id = String(entry?.fileName ?? "").match(/ ([^ ]+)\.mp4$/u)?.[1];
    const url = cdnUrl(entry?.url);
    if (!url) continue;
    if (id && itemIds.has(id)) {
      if (!urls.has(id)) urls.set(id, url);
    } else if (Number.isSafeInteger(entry?.bytes) && entry.bytes > 0) {
      bySize.push({ bytes: entry.bytes, url });
    }
  }
  const mappedUrls = new Set(urls.values());
  for (const { bytes, url } of bySize) {
    if (mappedUrls.has(url) || bySize.filter((entry) => entry.bytes === bytes).length !== 1) continue;
    const matches = finals.filter((final) => final.bytes === bytes && !urls.has(contentItemOf(final.rel)));
    if (matches.length === 1) urls.set(contentItemOf(matches[0].rel), url);
  }
  return { delivered: manifest !== null, urls };
}

/**
 * V's copies of a finished project's delivered finals: each with its CDN URL, its bytes and every
 * hard link of it inside the project. Reads only; nothing is fetched.
 */
export async function planDeliveredFinals(instanceDir) {
  const files = await listFiles(instanceDir);
  const finals = files.filter((file) => {
    const parts = file.rel.split("/");
    return parts.length === 4 && parts[0] === "content-items" && parts[2] === "produce" && FINAL_FILE.test(parts[3]);
  });
  const itemIds = new Set(files.map((file) => contentItemOf(file.rel)).filter(Boolean));
  const { delivered, urls } = await deliveredUrls(instanceDir, itemIds, finals);
  if (!delivered) return { delivered, finals: [], notDelivered: finals.length };
  const planned = [];
  let notDelivered = 0;
  for (const final of finals) {
    const contentItemId = contentItemOf(final.rel);
    const url = urls.get(contentItemId);
    if (!url) {
      notDelivered += 1;
      continue;
    }
    const links = files.filter((file) => file.inode === final.inode && file.bytes === final.bytes);
    planned.push({ contentItemId, url, bytes: final.bytes, links, frees: links.length >= final.links });
  }
  return { delivered, finals: planned, notDelivered };
}

/** Does the CDN hold this exact file? A fresh HEAD must answer 200 with the same length. */
export async function cdnHoldsCopy(url, bytes, { fetch = globalThis.fetch, timeoutMs = 30_000, attempts = 3 } = {}) {
  let error = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { method: "HEAD", cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      const length = Number(response.headers.get("content-length"));
      if (response.status !== 200) return { verified: false, reason: `HEAD ${response.status}` };
      if (length !== bytes) return { verified: false, reason: `CDN has ${Number.isFinite(length) ? length : "no"} bytes, V has ${bytes}` };
      return { verified: true };
    } catch (failure) {
      error = failure;
    }
  }
  return { verified: false, unreachable: true, reason: `HEAD failed: ${error?.message ?? error}` };
}

// At most `limit` requests in flight; the event loop stays free between them.
async function mapWithLimit(values, limit, fn) {
  const results = new Array(values.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]);
      await nextTurn();
    }
  });
  await Promise.all(lanes);
  return results;
}

async function retainDeliveredFinals({ store, instance, finishedAt, instanceDir, now, minAgeDays, apply, actor, fetch, concurrency }) {
  const plan = await planDeliveredFinals(instanceDir);
  const summary = { id: instance.id, finishedAt, delivered: plan.delivered, finals: plan.finals.length, files: 0, bytes: 0, kept: [] };
  if (!apply) {
    summary.bytes = plan.finals.reduce((sum, final) => sum + (final.frees ? final.bytes : 0), 0);
    return summary;
  }
  const checks = await mapWithLimit(plan.finals, concurrency, (final) => cdnHoldsCopy(final.url, final.bytes, { fetch }));
  const removedFinals = [];
  for (const [index, final] of plan.finals.entries()) {
    const check = checks[index];
    if (!check.verified) {
      summary.kept.push({ contentItemId: final.contentItemId, reason: check.reason, retry: Boolean(check.unreachable) });
      continue;
    }
    const removed = [];
    for (const file of final.links) {
      try {
        await unlink(file.path);
        removed.push(file.rel);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    summary.files += removed.length;
    if (final.frees) summary.bytes += final.bytes;
    removedFinals.push({ contentItemId: final.contentItemId, files: removed, bytes: final.bytes, cdn: final.url });
  }
  summary.finals = removedFinals.length;
  if (removedFinals.length || summary.kept.length) {
    await appendLedger(instanceDir, {
      at: now.toISOString(), minAgeDays, actor, rule: "delivered-finals", removedFinals, keptFinals: summary.kept,
    });
  }
  // A CDN that could not be reached leaves the project due for the next run; anything else is final.
  if (!summary.kept.some((entry) => entry.retry)) {
    store.appendEvent({
      instanceId: instance.id,
      type: FINALS_EVENT,
      payload: { version: 1, finishedAt, delivered: plan.delivered, finals: removedFinals.length, files: summary.files, bytes: summary.bytes, kept: summary.kept.length, actor },
      now,
    });
  }
  return summary;
}

/**
 * Plans (apply=false) or applies retention over the finished projects.
 * Applying removes files one by one, yielding to the event loop, and records each project.
 */
export async function runRetention({
  store,
  instancesRoot,
  now = new Date(),
  minAgeDays = 14,
  apply = false,
  maxInstances = 100,
  actor = null,
  // Delivered finals: removed from V this many days after the project finished; null keeps them.
  finalsMinAgeDays = null,
  fetch = globalThis.fetch,
  finalsConcurrency = 4,
}) {
  const projects = [];
  for (const { instance, finishedAt } of retentionCandidates(store, { now, minAgeDays }).slice(0, maxInstances)) {
    // One project's failure (on V a finished canary has no directory at all) must not stop the rest.
    try {
      projects.push(await retainInstance({ store, instance, finishedAt, instanceDir: join(instancesRoot, instance.id), now, minAgeDays, apply, actor }));
    } catch (error) {
      projects.push({ id: instance.id, finishedAt, files: 0, bytes: 0, keptWithoutReference: 0, error: error.message });
    }
    await nextTurn();
  }
  const finals = [];
  if (finalsMinAgeDays !== null) {
    for (const { instance, finishedAt } of retentionCandidates(store, { now, minAgeDays: finalsMinAgeDays, eventType: FINALS_EVENT }).slice(0, maxInstances)) {
      try {
        finals.push(await retainDeliveredFinals({
          store, instance, finishedAt, instanceDir: join(instancesRoot, instance.id), now, minAgeDays: finalsMinAgeDays, apply, actor, fetch, concurrency: finalsConcurrency,
        }));
      } catch (error) {
        finals.push({ id: instance.id, finishedAt, finals: 0, files: 0, bytes: 0, kept: [], error: error.message });
      }
      await nextTurn();
    }
  }
  return {
    apply,
    minAgeDays,
    projects,
    files: projects.reduce((sum, project) => sum + project.files, 0),
    bytes: projects.reduce((sum, project) => sum + project.bytes, 0),
    errors: projects.filter((project) => project.error).length + finals.filter((project) => project.error).length,
    finals: {
      minAgeDays: finalsMinAgeDays,
      projects: finals,
      finals: finals.reduce((sum, project) => sum + project.finals, 0),
      files: finals.reduce((sum, project) => sum + project.files, 0),
      bytes: finals.reduce((sum, project) => sum + project.bytes, 0),
      kept: finals.reduce((sum, project) => sum + project.kept.length, 0),
    },
  };
}
