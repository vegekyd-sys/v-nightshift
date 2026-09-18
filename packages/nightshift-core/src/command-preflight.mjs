import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { stageEnabled } from "./workflow.mjs";

// Stage skills name CLIs (scene, makaron-cli, lark-cli). When one is missing
// from the worker host the agent does not stop: it searches the filesystem,
// greps for keys, and reads other boards' cards for hints. Declaring the
// commands on the workflow lets the control plane refuse the project before a
// single card is dispatched.
export function requiredCommands(release, inputs = {}) {
  const result = new Set(commandList(release?.spec?.requiredCommands));
  for (const stage of release?.spec?.stages ?? []) {
    if (stage.actor !== "agent" || !stageEnabled(stage, inputs)) continue;
    for (const command of commandList(stage.requiredCommands)) result.add(command);
    for (const strategy of Object.values(stage.routeStrategies ?? {})) {
      for (const command of commandList(strategy?.requiredCommands)) result.add(command);
    }
  }
  return [...result].sort();
}

export function missingCommands(commands, { pathEnv = process.env.PATH ?? "" } = {}) {
  const directories = pathEnv.split(delimiter).filter(Boolean);
  return commands.filter((command) => !directories.some((directory) => executable(join(directory, command))));
}

function executable(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
}
