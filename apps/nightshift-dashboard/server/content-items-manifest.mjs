import { createHash } from "node:crypto";
import { readFile as readFileDefault } from "node:fs/promises";
import { join } from "node:path";
import { contentItemsManifestIssues, contentItemsOfManifest } from "../../../packages/nightshift-core/src/content-items.mjs";

// Imports each project's content-items.json written by its planning stage. A
// manifest is imported once per content; one that cannot be imported is tried
// again every pass, since the cause may pass, but its failure is marked
// `reported` after the first time so the scheduler records it once. On V two
// broken manifests wrote 16,920 identical audit events in a week
// (2026-10-14..21), one every scheduler pass.
export function createContentItemsManifestSync({ dataDir, setContentItems, readFile = readFileDefault }) {
  const imported = new Map();
  const failures = new Map();
  return async function syncContentItemsManifest(instance) {
    const manifestPath = join(dataDir, "instances", instance.id, "content-items.json");
    let source;
    try {
      source = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const digest = createHash("sha256").update(source).digest("hex");
    if (imported.get(instance.id) === digest) return;
    try {
      const items = manifestItems(manifestPath, source);
      // A stage that found nothing (a timed-publish scan with nothing due) writes
      // an empty list. There is nothing to import; whether the stage may finish
      // empty is its own completion rule. On V (2026-10-22) GEE-TIMED-PUB-20261022-BR
      // was reported every pass as having "no contentItems or items array".
      if (items.length > 0) setContentItems(instance.id, items);
    } catch (error) {
      const failed = failures.get(instance.id);
      if (failed?.digest === digest && failed.message === error.message) error.reported = true;
      failures.set(instance.id, { digest, message: error.message });
      throw error;
    }
    failures.delete(instance.id);
    imported.set(instance.id, digest);
  };
}

function manifestItems(manifestPath, source) {
  const parsed = JSON.parse(source);
  // The array is the file itself, its `contentItems` or its `items` (content-items.mjs).
  const items = contentItemsOfManifest(parsed);
  if (items === null) {
    // "contentItems must contain at least one video task" reads as "the stage
    // produced nothing", which sent us looking in the wrong place while the file
    // held fifteen entries under another key.
    throw new Error(contentItemsManifestIssues(parsed, { path: manifestPath })[0]);
  }
  return items;
}
