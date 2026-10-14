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
//   - in a delivery folder, it has the exact size of a kept deliverable (a duplicate copy).
// Every applied run writes retention-ledger.json in the project and a storage.retention event.

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
        files.push({ path, rel: relative(root, path).split(sep).join("/"), bytes: stat.size });
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

/** What retention would remove from one finished project directory. Reads only. */
export async function planInstanceRetention(instanceDir) {
  const files = await listFiles(instanceDir);
  const refs = await referencedArtifacts(instanceDir, files);
  const isMedia = (file) => MEDIA_EXTENSIONS.has(extname(file.rel).toLowerCase());
  const isKeptDeliverable = (file) => isReferenced(refs, file.rel) || /^final\./iu.test(basename(file.rel));
  const deliverableSizes = new Set();
  const itemsWithDeliverable = new Set();
  for (const file of files) {
    if (!isMedia(file) || !isKeptDeliverable(file) || isDeliveryFolder(file.rel)) continue;
    deliverableSizes.add(file.bytes);
    const item = contentItemOf(file.rel);
    if (item) itemsWithDeliverable.add(item);
  }
  const remove = [];
  let keptWithoutReference = 0;
  for (const file of files) {
    if (!isMedia(file) || isKeptDeliverable(file) || file.rel === RETENTION_LEDGER) continue;
    if (isDeliveryFolder(file.rel)) {
      if (deliverableSizes.has(file.bytes)) remove.push({ ...file, reason: "duplicate-of-deliverable" });
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
export function retentionCandidates(store, { now = new Date(), minAgeDays = 14 } = {}) {
  const completed = store.latestEventTimes("instance.completed");
  const retained = store.latestEventTimes("storage.retention");
  const cutoff = now.getTime() - minAgeDays * DAY_MS;
  return store.listInstances()
    .filter((instance) => instance.status === "done" || (instance.status === "archived" && completed.has(instance.id)))
    .map((instance) => ({ instance, finishedAt: completed.get(instance.id) ?? instance.updatedAt }))
    .filter(({ finishedAt }) => Date.parse(finishedAt) <= cutoff)
    .filter(({ instance, finishedAt }) => !retained.has(instance.id) || retained.get(instance.id) < finishedAt)
    .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
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
  if (apply) {
    for (const [index, file] of plan.remove.entries()) {
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
        removed: plan.remove.map(({ rel, bytes: size, reason }) => ({ rel, bytes: size, reason })),
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
  return {
    apply,
    minAgeDays,
    projects,
    files: projects.reduce((sum, project) => sum + project.files, 0),
    bytes: projects.reduce((sum, project) => sum + project.bytes, 0),
    errors: projects.filter((project) => project.error).length,
  };
}
