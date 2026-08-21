import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

test("plan CLI emits a deterministic first Workboard action without applying", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "packages/nightshift-core/src/cli.mjs",
      "plan",
      "examples/workflows/xingqing-content-delivery.v0.2.yaml",
      "--instance",
      "examples/instances/xingqing-vlab-smoke.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  const output = JSON.parse(stdout);
  assert.equal(output.ok, true);
  assert.equal(output.applied, null);
  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0].stageId, "plan");
});
