import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CARD_LABEL_MAX, compileWorkflow, normalizeContentItems, parseWorkflow, requiredSkillsByRole, validateProjectRequest } from "../src/index.mjs";

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
  assert.throws(
    () => validateProjectRequest(release, {
      ...base,
      inputs: {
        customerId: "customer-2",
        briefUrl: "https://example.com/brief",
        authorizationScope: {},
        publicationTarget: { tiktokHandle: "@fixture" },
      },
    }),
    /publicationTarget is missing required properties/,
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

test("download projects exclude the inactive GeeLark publication Skill during preflight", async () => {
  const release = compileWorkflow(parseWorkflow(await readFile(workflowPath, "utf8")));
  const skills = requiredSkillsByRole(release, { deliveryMode: "download" })["content-operator"];
  assert.ok(skills.includes("lark-base"));
  assert.ok(skills.includes("background-worker-contract"));
  assert.ok(!skills.includes("geelark-cloud-phone"));
  assert.ok(!skills.includes("social-search-apify-first"));
});

test("rejects an unknown delivery mode", async () => {
  const release = compileWorkflow(parseWorkflow(await readFile(workflowPath, "utf8")));
  assert.throws(() => validateProjectRequest(release, {
    id: "NS-BAD-MODE",
    name: "Bad mode",
    workflowSha256: release.metadata.workflowSha256,
    inputs: {
      customerId: "customer-1",
      briefUrl: "https://example.com/brief",
      authorizationScope: {},
      deliveryMode: "email",
    },
    agentBindings: { "content-operator": "main" },
  }), /deliveryMode must be one of: publish, download/);
});

// NS-VIG-0917-01 accepted a 28-character content item id on 2026-09-17 and was
// then undispatchable: every card creation failed on the Workboard's 40-character
// label limit, with an error that named neither the label nor the item.
test("a content item id that would overflow its card label is refused at write time", () => {
  const item = (id) => [{ id, title: "t", route: "SCENE_EDIT" }];
  assert.deepEqual(
    normalizeContentItems(item("a".repeat(27)), { routes: ["SCENE_EDIT"] })[0].id,
    "a".repeat(27),
  );
  assert.throws(
    () => normalizeContentItems(item("curiosity-character-vignette"), { routes: ["SCENE_EDIT"] }),
    /27 characters or fewer.*curiosity-character-vignette \(28\)/,
  );
  assert.equal("content-item:".length + 27, 40);
});

// The Gateway's 40 is one input check with nothing depending on it. When it is
// raised, Night Shift must accept longer ids from a drop-in, not a release.
test("the card label budget is a knob, not a baked-in 40", () => {
  const item = [{ id: "curiosity-character-vignette", title: "t", route: "SCENE_EDIT" }];
  assert.equal(normalizeContentItems(item, { routes: ["SCENE_EDIT"], labelMax: 80 })[0].id, "curiosity-character-vignette");
  assert.throws(() => normalizeContentItems(item, { routes: ["SCENE_EDIT"], labelMax: 40 }), /within 40/);
  assert.equal(CARD_LABEL_MAX, 40, "the default still matches what the Gateway enforces today");
});
