import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compileWorkflow, parseWorkflow, requiredSkillsByRole, validateProjectRequest } from "../src/index.mjs";

const workflowPath = new URL("../../../examples/workflows/xingqing-content-delivery.workflow.md", import.meta.url);

test("validates required workflow inputs and agent bindings for a new project", async () => {
  const release = compileWorkflow(parseWorkflow(await readFile(workflowPath, "utf8")));
  const project = {
    id: "NS-LAB-PROJECT-1",
    name: "Project 1",
    workflowSha256: release.metadata.workflowSha256,
    inputs: {
      customerId: "customer-1",
      briefUrl: "https://example.com/brief",
      authorizationScope: { paidProduction: false, externalPublication: false, vlabOnly: true },
    },
    agentBindings: { "content-operator": "main" },
  };
  assert.equal(validateProjectRequest(release, project), project);
});

test("rejects a project with missing inputs or agent bindings", async () => {
  const release = compileWorkflow(parseWorkflow(await readFile(workflowPath, "utf8")));
  const base = {
    id: "NS-LAB-PROJECT-2",
    name: "Project 2",
    workflowSha256: release.metadata.workflowSha256,
    inputs: { customerId: "customer-2" },
    agentBindings: { "content-operator": "main" },
  };
  assert.throws(() => validateProjectRequest(release, base), /briefUrl/);
  assert.throws(
    () => validateProjectRequest(release, {
      ...base,
      inputs: {
        customerId: "customer-2",
        briefUrl: "https://example.com/brief",
        authorizationScope: {},
      },
      agentBindings: {},
    }),
    /content-operator/,
  );
  assert.throws(
    () => validateProjectRequest(release, { ...base, id: "NS-LAB-PROJECT-ID-THAT-IS-LONGER-THAN-THIRTY-ONE" }),
    /1-31 characters/,
  );
});

test("collects direct and route-specific Skills for Agent preflight", async () => {
  const release = compileWorkflow(parseWorkflow(await readFile(workflowPath, "utf8")));
  const skills = requiredSkillsByRole(release)["content-operator"];
  assert.ok(skills.includes("lark-doc"));
  assert.ok(skills.includes("shooting-checklist-v3"));
  assert.ok(skills.includes("makaron"));
  assert.ok(skills.includes("geelark-cloud-phone"));
  assert.equal(new Set(skills).size, skills.length);
});
