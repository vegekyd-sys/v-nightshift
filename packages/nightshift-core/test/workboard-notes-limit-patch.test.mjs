import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const script = new URL("../../../scripts/apply-workboard-notes-limit-patch.mjs", import.meta.url);

test("raises the native Workboard notes limit to twelve thousand and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "workboard-notes-limit-"));
  const dist = join(root, "dist");
  const backup = join(root, "backup");
  mkdirSync(dist);
  mkdirSync(backup);
  const bundle = join(dist, "runtime-api-fixture.js");
  writeFileSync(bundle, 'if (notes.length > 4e3) throw new Error("notes must be 4000 characters or fewer.");\n');

  const result = JSON.parse(execFileSync(process.execPath, [script.pathname, `--dist=${dist}`, `--backup-dir=${backup}`], { encoding: "utf8" }));
  assert.equal(result.limit, 12000);
  assert.match(readFileSync(bundle, "utf8"), /notes\.length > 12000/);
  assert.match(readFileSync(bundle, "utf8"), /12000 characters or fewer/);
  assert.match(readFileSync(join(backup, "runtime-api-fixture.js"), "utf8"), /notes\.length > 4e3/);

  const second = JSON.parse(execFileSync(process.execPath, [script.pathname, `--dist=${dist}`, `--backup-dir=${backup}`], { encoding: "utf8" }));
  assert.equal(second.status, "already-patched");
});

test("refuses an unknown native Workboard validation shape", () => {
  const root = mkdtempSync(join(tmpdir(), "workboard-notes-shape-"));
  const dist = join(root, "dist");
  const backup = join(root, "backup");
  mkdirSync(dist);
  mkdirSync(backup);
  writeFileSync(join(dist, "runtime-api-fixture.js"), "const changedUpstream = true;\n");
  assert.throws(
    () => execFileSync(process.execPath, [script.pathname, `--dist=${dist}`, `--backup-dir=${backup}`]),
    /Expected exactly one Workboard runtime bundle/,
  );
});
