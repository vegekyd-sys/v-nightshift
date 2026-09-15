#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const snapshot = JSON.parse(await readFile(resolve(process.argv[2] ?? "nightshift-replay.json"), "utf8"));
const durationSeconds = 120;
const legacyIntervalSeconds = 30;
const nativeMaxIntervalSeconds = 5;
const legacyCycles = durationSeconds / legacyIntervalSeconds;
const nativePasses = Math.ceil(durationSeconds / nativeMaxIntervalSeconds) + 1;
const tasks = [20, 30];

const scenarios = tasks.map((taskCount) => {
  const legacyRpc = legacyCycles * (taskCount + 1);
  const nativeRpc = nativePasses;
  return {
    taskCount,
    durationSeconds,
    legacy: {
      fullBoardReads: legacyCycles,
      sessionReads: legacyCycles * taskCount,
      gatewayRpc: legacyRpc,
      cliSubprocesses: legacyRpc,
    },
    native: {
      scopedBoardReadsWorstCase: nativeRpc,
      sessionReadsWhileRunning: 0,
      gatewayRpcWorstCase: nativeRpc,
      cliSubprocesses: 0,
      persistentConnections: 1,
      nextStageDelayUpperBoundMs: nativeMaxIntervalSeconds * 1000 + 100,
    },
    reduction: {
      gatewayRpcPercent: Number(((1 - nativeRpc / legacyRpc) * 100).toFixed(1)),
      cliSubprocessPercent: 100,
    },
  };
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  snapshot: snapshot.source,
  model: "worst-case continuous Workboard changes over a two-minute running window",
  scenarios,
}, null, 2)}\n`);
