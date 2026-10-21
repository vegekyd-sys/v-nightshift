import { createHash } from "node:crypto";
import { readFile as readFileDefault } from "node:fs/promises";
import { join } from "node:path";

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
      setContentItems(instance.id, manifestItems(manifestPath, source));
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
  // The planning skill documents the array as `items`; earlier manifests use
  // `contentItems`. Accept both rather than rejecting a manifest that follows
  // the published contract.
  const items = Array.isArray(parsed) ? parsed : (parsed?.contentItems ?? parsed?.items);
  if (!Array.isArray(items) || items.length === 0) {
    // "contentItems must contain at least one video task" reads as "the stage
    // produced nothing", which sent us looking in the wrong place while the file
    // held fifteen entries under another key.
    const arrays = Object.entries(parsed ?? {})
      .filter(([, value]) => Array.isArray(value) && value.length > 0)
      .map(([key, value]) => `${key}(${value.length})`);
    throw new Error(`${manifestPath} has no contentItems or items array`
      + (arrays.length ? `; it holds ${arrays.join(", ")}` : "")
      + ". Each entry needs stableId (or id) and title.");
  }
  return items;
}
