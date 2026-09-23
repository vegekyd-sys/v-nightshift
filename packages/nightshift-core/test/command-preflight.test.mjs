import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { missingCommands, requiredCommands } from "../src/index.mjs";

function binDirectory(names) {
  const directory = mkdtempSync(join(tmpdir(), "ns-cmd-"));
  for (const name of names) {
    const path = join(directory, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  return directory;
}

test("collects required commands from the spec, enabled agent stages, and route strategies", () => {
  const release = {
    spec: {
      requiredCommands: ["lark-cli"],
      stages: [
        { id: "brief", actor: "agent", routeStrategies: { AI_GENERATE: { requiredCommands: ["scene"] }, SCENE_EDIT: { requiredCommands: ["scene"] } } },
        { id: "produce", actor: "agent", requiredCommands: ["makaron-cli"] },
        { id: "review", actor: "human", requiredCommands: ["ignored-human-tool"] },
        { id: "publish", actor: "agent", requiredCommands: ["geelark"], when: { input: "deliveryMode", equals: "publish" } },
      ],
    },
  };
  assert.deepEqual(requiredCommands(release, { deliveryMode: "download" }), ["lark-cli", "makaron-cli", "scene"]);
  assert.deepEqual(requiredCommands(release, { deliveryMode: "publish" }), ["geelark", "lark-cli", "makaron-cli", "scene"]);
  assert.deepEqual(requiredCommands({ spec: { stages: [] } }), []);
});

test("reports commands that are not executable on PATH", () => {
  const present = binDirectory(["scene", "makaron-cli"]);
  const notExecutable = binDirectory([]);
  writeFileSync(join(notExecutable, "lark-cli"), "not executable");
  chmodSync(join(notExecutable, "lark-cli"), 0o644);
  const pathEnv = [present, notExecutable, join(present, "does-not-exist")].join(delimiter);
  assert.deepEqual(missingCommands(["scene", "makaron-cli", "lark-cli", "geelark"], { pathEnv }), ["lark-cli", "geelark"]);
  assert.deepEqual(missingCommands([], { pathEnv }), []);
  assert.deepEqual(missingCommands(["scene"], { pathEnv: "" }), ["scene"]);
});
