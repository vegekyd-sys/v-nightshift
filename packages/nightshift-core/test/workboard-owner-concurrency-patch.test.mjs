import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const script = new URL("../../../scripts/apply-workboard-owner-concurrency-patch.mjs", import.meta.url);

test("patches same-owner Workboard concurrency from one to eight and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "workboard-owner-concurrency-"));
  const dist = join(root, "dist");
  const backup = join(root, "backup");
  mkdirSync(dist);
  mkdirSync(backup);
  const bundle = join(dist, "runtime-api-fixture.js");
  writeFileSync(bundle, [
    "const DEFAULT_DISPATCH_MAX_STARTS = 3;",
    "function fixture(cards) {",
    "\tconst runningByOwner = new Map();",
    "\tconst selected = [];",
    "\tfor (const card of cards) {",
    "\t\tconst owner = card.owner;",
    "\t\tif ((runningByOwner.get(owner) ?? 0) > 0) continue;",
    "\t\tselected.push(card);",
    "\t\trunningByOwner.set(owner, 1);",
    "\t}",
    "\treturn selected;",
    "}",
  ].join("\n"));

  execFileSync(process.execPath, [script.pathname, `--dist=${dist}`, `--backup-dir=${backup}`]);
  const patched = readFileSync(bundle, "utf8");
  assert.match(patched, /DEFAULT_DISPATCH_MAX_PER_OWNER = 8/);
  assert.doesNotMatch(patched, /^\+const/m);
  assert.match(patched, />= DEFAULT_DISPATCH_MAX_PER_OWNER/);
  assert.match(patched, /runningByOwner\.set\(owner, \(runningByOwner\.get\(owner\) \?\? 0\) \+ 1\)/);
  execFileSync(process.execPath, ["--check", bundle]);
  assert.match(readFileSync(join(backup, "runtime-api-fixture.js"), "utf8"), /> 0\) continue/);

  const second = JSON.parse(execFileSync(process.execPath, [script.pathname, `--dist=${dist}`, `--backup-dir=${backup}`], { encoding: "utf8" }));
  assert.equal(second.status, "already-patched");
});

test("upgrades the accepted three-per-owner patch to eight", () => {
  const root = mkdtempSync(join(tmpdir(), "workboard-owner-concurrency-upgrade-"));
  const dist = join(root, "dist");
  const backup = join(root, "backup");
  mkdirSync(dist);
  mkdirSync(backup);
  const bundle = join(dist, "runtime-api-fixture.js");
  writeFileSync(bundle, [
    "const DEFAULT_DISPATCH_MAX_STARTS = 3;",
    "const DEFAULT_DISPATCH_MAX_PER_OWNER = 3;",
    "function fixture(cards) {",
    "\tconst runningByOwner = new Map();",
    "\tconst selected = [];",
    "\tfor (const card of cards) {",
    "\t\tconst owner = card.owner;",
    "\t\tif ((runningByOwner.get(owner) ?? 0) >= DEFAULT_DISPATCH_MAX_PER_OWNER) continue;",
    "\t\tselected.push(card);",
    "\t\trunningByOwner.set(owner, (runningByOwner.get(owner) ?? 0) + 1);",
    "\t}",
    "\treturn selected;",
    "}",
  ].join("\n"));

  const result = JSON.parse(execFileSync(process.execPath, [script.pathname, `--dist=${dist}`, `--backup-dir=${backup}`], { encoding: "utf8" }));
  assert.equal(result.maxPerOwner, 8);
  assert.match(readFileSync(bundle, "utf8"), /DEFAULT_DISPATCH_MAX_PER_OWNER = 8/);
  assert.match(readFileSync(join(backup, "runtime-api-fixture.js"), "utf8"), /DEFAULT_DISPATCH_MAX_PER_OWNER = 3/);
});
