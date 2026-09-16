#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  WorkflowValidationError,
  WorkboardCliAdapter,
  compileWorkflow,
  loadWorkflow,
  planNextActions,
  validateWorkflow,
} from "./index.mjs";

const [command, input, ...rest] = process.argv.slice(2);
if (!command || !input || !["validate", "compile", "plan"].includes(command)) {
  usage();
  process.exitCode = 2;
} else {
  try {
    const filePath = resolve(input);
    const workflow = await loadWorkflow(filePath);
    if (command === "validate") {
      const issues = validateWorkflow(workflow);
      if (issues.length > 0) throw new WorkflowValidationError(issues);
      console.log(
        JSON.stringify({ ok: true, workflow: workflow.metadata.id, stages: workflow.spec.stages.length }),
      );
    } else if (command === "compile") {
      const release = compileWorkflow(workflow);
      const output = optionValue(rest, "--out");
      const serialized = `${JSON.stringify(release, null, 2)}\n`;
      if (output) {
        await writeFile(resolve(output), serialized, "utf8");
        console.log(
          JSON.stringify({
            ok: true,
            output: resolve(output),
            releaseId: release.metadata.releaseId,
          }),
        );
      } else {
        process.stdout.write(serialized);
      }
    } else {
      const release = compileWorkflow(workflow);
      const instancePath = optionValue(rest, "--instance");
      if (!instancePath) throw new Error("plan requires --instance <instance.json>");
      const runsPath = optionValue(rest, "--runs");
      const instance = await readJson(instancePath);
      const runs = runsPath ? await readJson(runsPath) : [];
      const actions = planNextActions({ release, instance, runs });
      const apply = rest.includes("--apply");
      const board = optionValue(rest, "--board") ?? "nightshift";
      const applied = apply
        ? await new WorkboardCliAdapter({ board }).applyPlan(actions)
        : null;
      console.log(
        JSON.stringify(
          {
            ok: true,
            releaseId: release.metadata.releaseId,
            actions,
            applied,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      console.error(JSON.stringify({ ok: false, issues: error.issues }, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

function usage() {
  console.error(
    "Usage: cli.mjs validate <workflow.md> | compile <workflow.md> [--out release.json] | plan <workflow.md> --instance <instance.json> [--runs <runs.json>] [--board <id>] [--apply]",
  );
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(resolve(filePath), "utf8"));
}
