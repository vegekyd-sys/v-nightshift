#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  WorkflowValidationError,
  compileWorkflow,
  loadWorkflow,
  validateWorkflow,
} from "./index.mjs";

const [command, input, ...rest] = process.argv.slice(2);
if (!command || !input || !["validate", "compile"].includes(command)) {
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
    } else {
      const release = compileWorkflow(workflow);
      const outIndex = rest.indexOf("--out");
      const output = outIndex >= 0 ? rest[outIndex + 1] : null;
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
    "Usage: cli.mjs validate <workflow.yaml> | compile <workflow.yaml> [--out release.json]",
  );
}
