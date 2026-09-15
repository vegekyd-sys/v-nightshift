#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createReplaySnapshot, replaySnapshotMetrics } from "../packages/nightshift-core/src/replay-snapshot.mjs";

const baseUrl = process.env.NIGHTSHIFT_URL ?? "http://127.0.0.1:24879";
const output = resolve(process.argv[2] ?? "nightshift-replay.json");
const sourceRelease = process.env.NIGHTSHIFT_SOURCE_RELEASE ?? null;
if (!sourceRelease) throw new Error("NIGHTSHIFT_SOURCE_RELEASE is required so replay cannot use an ambiguous code baseline");

try {
  const [bootstrap, instances, cards] = await Promise.all([
    request("/api/bootstrap"),
    request("/api/instances?includeArchived=1"),
    request("/api/cards?includeArchived=1"),
  ]);
  const snapshot = createReplaySnapshot({ bootstrap, instances, cards, sourceRelease });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, output, metrics: replaySnapshotMetrics(snapshot) }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message, ok: false })}\n`);
  process.exitCode = 1;
}

async function request(path) {
  const response = await fetch(new URL(path, baseUrl));
  if (!response.ok) throw new Error(`Night Shift replay export failed: ${path} returned ${response.status}`);
  return response.json();
}
