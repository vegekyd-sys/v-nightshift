import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { buildAgentBrief, compileWorkflow, loadWorkflow, planNextActions, validateWorkflow, WORKBOARD_NOTES_LIMIT } from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");
const genericFixture = resolve(here, "../../../examples/workflows/generic-agent-delivery.workflow.md");

test("compiles the seven-stage workflow.md deterministically", async () => {
  const workflow = await loadWorkflow(fixture);
  const first = compileWorkflow(workflow);
  const second = compileWorkflow(workflow);
  assert.equal(first.metadata.workflowSha256, second.metadata.workflowSha256);
  assert.deepEqual(first.spec.stages.map((stage) => stage.id), [
    "plan", "route", "materials", "brief", "produce", "review", "publish-feedback",
  ]);
  assert.equal(first.spec.stages[1].scope, "content-item");
  assert.deepEqual(first.spec.contentItems.routes, ["AI_GENERATE", "SCENE_EDIT"]);
  assert.equal(first.spec.concurrency.perInstance, 8);
  assert.equal(first.spec.concurrency.maxActiveInstances, 3);
  assert.equal(first.spec.completion.mode, "strict-v1");
  assert.deepEqual(first.spec.stages.at(-1).outputContracts.publicUrl, { type: "https-url", allowedHosts: ["tiktok.com"] });
});

test("the same compiler accepts a non-Xingqing workflow without content items", async () => {
  const release = compileWorkflow(await loadWorkflow(genericFixture));
  assert.equal(release.metadata.id, "generic-agent-delivery");
  assert.deepEqual(release.spec.stages.map((stage) => stage.id), ["understand", "execute", "review"]);
  assert.equal(release.spec.contentItems, undefined);
});

test("rejects duplicate IDs, cycles, and unapproved side effects", async () => {
  const duplicate = structuredClone(await loadWorkflow(fixture));
  duplicate.spec.stages[1].id = "plan";
  delete duplicate.spec.stages[4].approval;
  const codes = validateWorkflow(duplicate).map((entry) => entry.code);
  assert.ok(codes.includes("stage.duplicate"));
  assert.ok(codes.includes("stage.approval.required"));

  const cyclic = structuredClone(await loadWorkflow(fixture));
  cyclic.spec.stages[0].needs = ["publish-feedback"];
  assert.ok(validateWorkflow(cyclic).some((entry) => entry.code === "workflow.cycle"));

  const unknownOutputContract = structuredClone(await loadWorkflow(fixture));
  unknownOutputContract.spec.stages.at(-1).outputContracts.unknown = { type: "json" };
  assert.ok(validateWorkflow(unknownOutputContract).some((entry) => entry.code === "stage.outputContracts.output.unknown"));
});

test("plans the project stage and redacts secrets", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.nightshift = { instanceDir: "/srv/nightshift/NS-LAB-001" };
  instance.inputs.apiKey = "must-not-appear";
  const actions = planNextActions({ release, instance });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].stageId, "plan");
  assert.match(actions[0].card.notes, /每条计划视频拆成独立 ContentItem/);
  assert.match(actions[0].card.notes, /do not search source code or inspect plugin internals/i);
  assert.match(actions[0].card.notes, /workboard\.cards\.complete/);
  assert.match(actions[0].card.notes, /Never probe, test, or enumerate completion RPCs/);
  assert.match(actions[0].card.notes, /never use placeholder input such as summary=test/);
  assert.match(actions[0].card.notes, /verify every completion check/);
  assert.match(actions[0].card.notes, /exactly once/);
  assert.match(actions[0].card.notes, /"apiKey":"\[REDACTED\]"/);
  assert.doesNotMatch(actions[0].card.notes, /must-not-appear/);
});

test("keeps large project blueprints in an authoritative snapshot instead of overflowing native card notes", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.contentBlueprint = Array.from({ length: 10 }, (_, index) => ({
    id: `video-${index + 1}`,
    title: `Overseas video ${index + 1}`,
    angle: "A detailed creative direction that belongs in the full project input snapshot.",
    constraints: "Preserve every customer fact, language requirement, route choice, and source-evidence boundary.",
  }));
  instance.inputs.nightshift = {
    contentItemsManifestPath: "/srv/nightshift/NS-LARGE/content-items.json",
    instanceDir: "/srv/nightshift/NS-LARGE",
    projectInputsPath: "/srv/nightshift/NS-LARGE/project-inputs.json",
  };
  const [action] = planNextActions({ release, instance });
  assert.ok(action.card.notes.length <= WORKBOARD_NOTES_LIMIT);
  assert.match(action.card.notes, /Authoritative project inputs: read \/srv\/nightshift\/NS-LARGE\/project-inputs\.json/);
  assert.match(action.card.notes, /Workboard completion safety/);
  assert.doesNotMatch(action.card.notes, /A detailed creative direction/);
});

test("keeps every stage brief complete instead of truncating at the native card boundary", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.contentBlueprint = Array.from({ length: 10 }, (_, index) => ({
    id: `video-${index + 1}`,
    title: `Overseas video ${index + 1}`,
    longDirection: "preserve this in the project snapshot ".repeat(30),
  }));
  instance.inputs.nightshift = {
    contentItemsManifestPath: "/srv/nightshift/NS-LARGE/content-items.json",
    instanceDir: "/srv/nightshift/NS-LARGE",
    projectInputsPath: "/srv/nightshift/NS-LARGE/project-inputs.json",
  };
  const contentItem = {
    id: "video-1",
    title: "Overseas video 1",
    route: "SCENE_EDIT",
    status: "routing",
    payload: { script: "This long script belongs in content-items.json. ".repeat(200) },
  };
  for (const stage of release.spec.stages) {
    const notes = buildAgentBrief(release, instance, stage, stage.scope === "content-item" ? contentItem : null);
    assert.ok(notes.length < WORKBOARD_NOTES_LIMIT, `${stage.id} notes length ${notes.length}`);
    assert.match(notes, /Workboard completion safety/);
    assert.match(notes, /Return a concise result with evidence links or an explicit blocker\. Do not invent missing evidence\.$/);
    assert.doesNotMatch(notes, /This long script belongs/);
  }
});

test("fans one project out into independent content-item route cards", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  const actions = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems: twoItems(),
  });
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((action) => action.contentItemId), ["video-ai-01", "video-scene-01"]);
  assert.ok(actions.every((action) => action.stageId === "route"));
  assert.match(actions[0].card.title, /AI 产品视觉/);
  assert.ok(actions[0].card.labels.includes("content-item:video-ai-01"));
});

test("selects route-specific material skills without creating a second workflow", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const actions = planNextActions({
    release,
    instance: activeInstance(release),
    runs: [{ stageId: "plan", status: "done" }],
    contentItems: twoItems(),
    contentItemRuns: [
      { contentItemId: "video-ai-01", stageId: "route", status: "done" },
      { contentItemId: "video-scene-01", stageId: "route", status: "done" },
    ],
  });
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0].card.automation.skills, ["lark-doc", "scene-cli", "material-verification"]);
  assert.deepEqual(actions[1].card.automation.skills, ["shooting-checklist-v3", "scene-cli", "material-verification"]);
});

test("brief cards declare the executable artifact contract", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.nightshift = { instanceDir: "/srv/nightshift/NS-LAB-001" };
  const contentItems = [twoItems()[1]];
  const actions = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems,
    contentItemRuns: doneThrough("video-scene-01", "materials"),
  });
  assert.equal(actions[0].stageId, "brief");
  assert.match(actions[0].card.notes, /finishedVideoBrief\.md/);
  assert.match(actions[0].card.notes, /routeMatchesContentItem/);
  assert.match(actions[0].card.notes, /source_url\/start_sec\/end_sec/);
  assert.match(actions[0].card.notes, /Do not inspect Night Shift source code/);
});

test("paid production approval is isolated per content item", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.nightshift = { instanceDir: "/srv/nightshift/NS-LAB-001" };
  const contentItems = [twoItems()[0]];
  const contentItemRuns = doneThrough("video-ai-01", "brief");
  const request = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns });
  assert.equal(request[0].type, "request_approval");
  assert.equal(request[0].contentItemId, "video-ai-01");

  instance.approvals = [{ stageId: "produce", contentItemId: "video-ai-01", effect: "paid-production", scope: "content-item", status: "approved" }];
  const approved = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns });
  assert.equal(approved[0].type, "create_workboard_card");
  assert.equal(approved[0].stageId, "produce");
  assert.equal(approved[0].card.automation.maxRuntimeSeconds, 14_400);
  assert.match(approved[0].card.notes, /Delivery contract: write exactly this v1 shape/);
  assert.match(approved[0].card.notes, /\{"version":1/);
});

test("human review and publication remain per-video and idempotent", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.publicationTarget = publicationTarget();
  const contentItems = [twoItems()[1]];
  let contentItemRuns = doneThrough("video-scene-01", "produce");
  const review = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns })[0];
  assert.equal(review.type, "create_review_card");
  assert.equal(review.stageId, "review");

  contentItemRuns = doneThrough("video-scene-01", "review");
  const publicationApproval = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns })[0];
  assert.equal(publicationApproval.type, "request_approval");
  assert.equal(publicationApproval.approval.bindings.publicationTarget.tiktokHandle, "@fixture");
  instance.approvals = [{ stageId: "publish-feedback", contentItemId: "video-scene-01", ...publicationApproval.approval, status: "approved" }];
  const publish = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns })[0];
  assert.match(publish.idempotencyKey, /video-scene-01:publish-feedback/);
  assert.match(publish.card.notes, /exact Workboard approval is recorded for external-publication/);
  assert.match(publish.card.notes, /control plane will load every declared output artifact/);
  assert.match(publish.card.notes, /Output contract publicUrl/);
  assert.match(publish.card.notes, /tiktok\.com/);
});

test("approval without the exact effect and scope never unlocks a side effect", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.publicationTarget = publicationTarget();
  const contentItems = [twoItems()[1]];
  const contentItemRuns = doneThrough("video-scene-01", "review");
  instance.approvals = [{ stageId: "publish-feedback", contentItemId: "video-scene-01", effect: null, scope: null, status: "approved" }];
  const action = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns })[0];
  assert.equal(action.type, "request_approval");
  assert.equal(action.approval.effect, "external-publication");
  assert.equal(action.approval.scope, "asset-and-account");
  assert.equal(action.approval.bindings.publicationTarget.geelarkDeviceId, "device-1");
  assert.ok(action.approval.bindingHash);

  const blockedAction = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems,
    contentItemRuns: [...contentItemRuns, { contentItemId: "video-scene-01", stageId: "publish-feedback", status: "blocked" }],
  })[0];
  assert.equal(blockedAction.type, "request_approval");
  assert.equal(blockedAction.approval.bindingHash, action.approval.bindingHash);
});

test("changing a bound publication target invalidates the previous approval", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.publicationTarget = publicationTarget();
  const contentItems = [twoItems()[1]];
  const contentItemRuns = doneThrough("video-scene-01", "review");
  const first = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns })[0];
  instance.approvals = [{ stageId: "publish-feedback", contentItemId: "video-scene-01", ...first.approval, status: "approved" }];
  instance.inputs.publicationTarget = { ...instance.inputs.publicationTarget, tiktokHandle: "@changed" };

  const second = planNextActions({ release, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns })[0];

  assert.equal(second.type, "request_approval");
  assert.notEqual(second.approval.bindingHash, first.approval.bindingHash);
});

test("serializes publication cards that share one external device", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.publicationTarget = publicationTarget();
  const contentItems = twoItems().map((item) => ({ ...item, route: "SCENE_EDIT" }));
  const completed = contentItems.flatMap((item) => doneThrough(item.id, "review"));
  const approvals = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems,
    contentItemRuns: completed,
  });
  instance.approvals = approvals.map((action) => ({
    stageId: "publish-feedback",
    contentItemId: action.contentItemId,
    ...action.approval,
    status: "approved",
  }));

  const first = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems,
    contentItemRuns: completed,
  });

  assert.equal(first.length, 1);
  assert.equal(first[0].card.automation.resourceKey, "geelark:device-1");

  const during = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems,
    contentItemRuns: [...completed, { contentItemId: first[0].contentItemId, stageId: "publish-feedback", status: "running" }],
  });
  assert.deepEqual(during, []);

  const after = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems,
    contentItemRuns: [...completed, { contentItemId: first[0].contentItemId, stageId: "publish-feedback", status: "done" }],
  });
  assert.equal(after.length, 1);
  assert.notEqual(after[0].contentItemId, first[0].contentItemId);
});

test("refuses another release and requires an Agent binding", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.workflowSha256 = "different";
  assert.throws(() => planNextActions({ release, instance }), /pinned to a different workflow release/);
  const unbound = activeInstance(release);
  delete unbound.agentBindings;
  assert.throws(() => planNextActions({ release, instance: unbound }), /Missing agent binding/);
});

function activeInstance(release) {
  return {
    id: "NS-LAB-001",
    name: "VLab 星擎试验",
    status: "active",
    workflowSha256: release.metadata.workflowSha256,
    agentBindings: { "content-operator": "main" },
    inputs: { customerId: "fixture-customer", briefUrl: "https://example.invalid/brief" },
  };
}

function publicationTarget() {
  return {
    accountRecordId: "account-1",
    tiktokHandle: "@fixture",
    geelarkDeviceId: "device-1",
    platform: "TikTok",
    market: "US",
    language: "en-US",
    timezone: "America/New_York",
  };
}

function twoItems() {
  return [
    { id: "video-ai-01", title: "AI 产品视觉", route: "AI_GENERATE", status: "planned" },
    { id: "video-scene-01", title: "Scene 实拍剪辑", route: "SCENE_EDIT", status: "planned" },
  ];
}

function doneThrough(contentItemId, lastStage) {
  const stages = ["route", "materials", "brief", "produce", "review"];
  return stages.slice(0, stages.indexOf(lastStage) + 1).map((stageId) => ({ contentItemId, stageId, status: "done" }));
}
