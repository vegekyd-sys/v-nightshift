import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production sandbox allows the OpenClaw CLI health-state write", async () => {
  const unit = await readFile(
    new URL("../../../systemd/nightshift-workboard.service", import.meta.url),
    "utf8",
  );

  assert.match(unit, /^ProtectHome=read-only$/m);
  assert.match(
    unit,
    /^ReadWritePaths=.*\/home\/openclaw\/\.openclaw\/nightshift.*\/home\/openclaw\/\.openclaw\/state$/m,
  );
});

test("production deploy waits for the Workboard health endpoint", async () => {
  const script = await readFile(
    new URL("../../../scripts/manage-nightshift-production.sh", import.meta.url),
    "utf8",
  );

  assert.match(script, /^wait_for_health\(\) \{$/m);
  assert.equal((script.match(/^\s+wait_for_health$/gm) ?? []).length, 2);
});
