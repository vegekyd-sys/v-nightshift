#!/usr/bin/env node
// Writes a VLab candidate plan that runs the given test files with every
// engine, Live Board server and script module beside them, plus the one
// runtime dependency the engine imports (yaml): the candidate's input
// directory has no node_modules, and a plan V wrote on 2026-10-02 missed both
// scripts/nightshiftctl.mjs and yaml.
//
//   node lab/candidate/make-plan.mjs packages/nightshift-core/test/x.test.mjs [...] > /tmp/plan.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tests = process.argv.slice(2);
if (tests.length === 0) {
  console.error("usage: node lab/candidate/make-plan.mjs <test file>... > plan.json");
  process.exit(2);
}
if (!fs.existsSync(path.join(repo, "node_modules/yaml/package.json"))) {
  console.error("node_modules/yaml is missing: run npm ci in this worktree first");
  process.exit(2);
}
const filesUnder = (dir) => fs.readdirSync(path.join(repo, dir), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(repo, path.join(entry.parentPath ?? entry.path, entry.name)));
const modules = (dir) => fs.readdirSync(path.join(repo, dir))
  .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
  .map((name) => `${dir}/${name}`);
const support = [
  ...modules("packages/nightshift-core/src"),
  ...modules("apps/nightshift-dashboard/server"),
  "apps/nightshift-dashboard/client/src/attention.js", // imported by server/overview.mjs
  ...modules("scripts"),
  "node_modules/yaml/package.json",
  ...filesUnder("node_modules/yaml/dist"),
  ...fs.readdirSync(path.join(repo, "examples/workflows")).map((name) => `examples/workflows/${name}`),
  ...tests,
];
for (const file of tests) {
  if (!fs.existsSync(path.join(repo, file))) throw new Error(`no such file: ${file}`);
}
console.log(JSON.stringify({
  support: [...new Set(support)],
  command: ["/opt/vlab/node-v22.23.1-linux-x64/bin/node", "--no-warnings", "--test", ...tests],
  timeoutSeconds: 1800,
}, null, 2));
