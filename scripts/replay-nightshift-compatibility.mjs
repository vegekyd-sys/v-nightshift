#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { planNextActions as nativePlanner } from "../packages/nightshift-core/src/orchestrator.mjs";

const snapshotPath = resolve(process.argv[2] ?? "nightshift-replay.json");
const baselineRoot = resolve(process.argv[3] ?? ".");
const baselineModule = await import(pathToFileURL(resolve(baselineRoot, "packages/nightshift-core/src/orchestrator.mjs")).href);
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const baselineCommit = execFileSync("git", ["-C", baselineRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (snapshot.source?.releaseCommit && baselineCommit !== snapshot.source.releaseCommit) {
  throw new Error(`Replay baseline mismatch: snapshot=${snapshot.source.releaseCommit} baseline=${baselineCommit}`);
}
const workflowBySha = new Map(snapshot.workflows.map((workflow) => [workflow.workflowSha256, workflow.structure]));
const mismatches = [];
let comparedActions = 0;
let comparedInstances = 0;

for (const instance of snapshot.instances) {
  const release = workflowBySha.get(instance.workflowSha256);
  if (!release) {
    mismatches.push({ instanceId: instance.id, reason: "missing-workflow" });
    continue;
  }
  const input = {
    release,
    instance,
    runs: instance.stageRuns ?? [],
    contentItems: instance.contentItems ?? [],
    contentItemRuns: instance.contentItemRuns ?? [],
    now: new Date(snapshot.capturedAt),
  };
  let before;
  let after;
  try {
    before = baselineModule.planNextActions(input);
    after = nativePlanner(input);
  } catch (error) {
    mismatches.push({ instanceId: instance.id, reason: `planner-error:${error.message}` });
    continue;
  }
  comparedInstances += 1;
  comparedActions += before.length;
  const normalizedBefore = JSON.stringify(before.map(normalizeAction));
  const normalizedAfter = JSON.stringify(after.map(normalizeAction));
  if (normalizedBefore !== normalizedAfter) {
    mismatches.push({ instanceId: instance.id, reason: "behavior-changed", before: before.length, after: after.length });
  }
}

const result = {
  ok: mismatches.length === 0,
  schema: snapshot.schema,
  baselineCommit,
  workflows: snapshot.workflows.length,
  instances: snapshot.instances.length,
  comparedInstances,
  comparedActions,
  mismatches: mismatches.slice(0, 20),
  allowedDifference: "native card parents only",
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;

function normalizeAction(action) {
  if (!action.card) return action;
  const { notes: _notes, parents: _parents, title: _title, ...card } = action.card;
  return { ...action, card };
}
