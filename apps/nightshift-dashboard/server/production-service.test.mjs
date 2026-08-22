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
