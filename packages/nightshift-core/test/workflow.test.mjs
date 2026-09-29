import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { buildAgentBrief, compileWorkflow, loadWorkflow, planNextActions, validateWorkflow, WORKBOARD_NOTES_LIMIT } from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");
const genericFixture = resolve(here, "../../../examples/workflows/generic-agent-delivery.workflow.md");

test("compiles the branched workflow.md deterministically", async () => {
  const workflow = await loadWorkflow(fixture);
  const first = compileWorkflow(workflow);
  const second = compileWorkflow(workflow);
  assert.equal(first.metadata.workflowSha256, second.metadata.workflowSha256);
  assert.deepEqual(first.spec.stages.map((stage) => stage.id), [
    "plan", "route", "materials", "brief", "produce", "review", "publish-feedback", "deliver-download",
  ]);
  assert.equal(first.spec.stages[1].scope, "content-item");
  assert.deepEqual(first.spec.contentItems.routes, ["AI_GENERATE", "SCENE_EDIT"]);
  assert.equal(first.spec.concurrency.perInstance, 8);
  assert.equal(first.spec.completion.mode, "strict-v1");
  assert.deepEqual(first.spec.stages.find((stage) => stage.id === "publish-feedback").outputContracts.publicUrl, { type: "https-url", allowedHosts: ["tiktok.com"] });
  assert.deepEqual(first.spec.inputs.deliveryMode.enum, ["publish", "download"]);
});

test("the same compiler accepts a non-Xingqing workflow without content items", async () => {
  const release = compileWorkflow(await loadWorkflow(genericFixture));
  assert.equal(release.metadata.id, "generic-agent-delivery");
  assert.deepEqual(release.spec.stages.map((stage) => stage.id), ["understand", "execute", "review"]);
  assert.equal(release.spec.contentItems, undefined);
});

test("refuses maxActiveInstances: every project shares one first-come queue", async () => {
  const workflow = await loadWorkflow(genericFixture);
  workflow.spec.concurrency = { perInstance: 1, maxActiveInstances: 3 };
  const issues = validateWorkflow(workflow);
  assert.ok(issues.some((entry) => entry.code === "concurrency.maxActiveInstances.removed"), JSON.stringify(issues));
  workflow.spec.concurrency = { perInstance: 1 };
  assert.equal(validateWorkflow(workflow).some((entry) => entry.code === "concurrency.maxActiveInstances.removed"), false);
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

  const invalidCondition = structuredClone(await loadWorkflow(fixture));
  invalidCondition.spec.stages[0].when = { input: "missingInput", equals: "one", notEquals: "two" };
  const conditionCodes = validateWorkflow(invalidCondition).map((entry) => entry.code);
  assert.ok(conditionCodes.includes("stage.when.input.unknown"));
  assert.ok(conditionCodes.includes("stage.when.operator.invalid"));
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
  assert.match(actions[0].card.notes, /When the outputs are written, call workboard_complete exactly once/);
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
  assert.match(action.card.notes, /Project inputs: \/srv\/nightshift\/NS-LARGE\/project-inputs\.json/);
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

test("AI brief lists its Skills as a hint, not a load-before-acting ritual", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const actions = planNextActions({
    release,
    instance: activeInstance(release),
    runs: [{ stageId: "plan", status: "done" }],
    contentItems: [twoItems()[0]],
    contentItemRuns: doneThrough("video-ai-01", "materials"),
  });
  assert.deepEqual(actions[0].card.automation.skills, ["finished-video-brief", "lark-doc", "makaron"]);
  assert.match(actions[0].card.notes, /Skills likely useful here: finished-video-brief, lark-doc, makaron/);
  assert.match(actions[0].card.notes, /this attempt owns only this card/);
  assert.doesNotMatch(actions[0].card.notes, /load in order|before acting|every artifact they reference/);
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
  // The brief's content belongs to the route's Skill; the card only carries
  // the declared outputs and completion rules from the Workflow.
  assert.match(actions[0].card.notes, /- finishedVideoBrief: .*routeMatchesContentItem must be true/);
  assert.match(actions[0].card.notes, /listed by name|list it by name in the stage handoff outputs\[\]\.artifact/);
  assert.doesNotMatch(actions[0].card.notes, /source_url\/start_sec\/end_sec|shot table/);
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
  assert.deepEqual(approved[0].card.automation.sideEffects, ["paid-production"]);
  assert.match(approved[0].card.notes, /External-operation gate/);
});

test("SCENE_EDIT production requires temporal duplicate evidence", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.nightshift = { instanceDir: "/srv/nightshift/NS-LAB-001" };
  instance.approvals = [{ stageId: "produce", contentItemId: "video-scene-01", effect: "paid-production", scope: "content-item", status: "approved" }];
  const action = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems: [twoItems()[1]],
    contentItemRuns: doneThrough("video-scene-01", "brief"),
  })[0];
  assert.match(action.card.notes, /check-video-duplicates\.mjs/);
  assert.match(action.card.notes, /duplicate-check\.json/);
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
  assert.match(publish.card.notes, /Output contract publicUrl/);
  assert.match(publish.card.notes, /tiktok\.com/);
});

test("download delivery fans in after every produce run and bypasses review, publication approval, and GeeLark", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.deliveryMode = "download";
  instance.inputs.nightshift = { instanceDir: "/srv/nightshift/NS-DOWNLOAD" };
  const contentItems = twoItems();
  const firstItemOnly = doneThrough(contentItems[0].id, "produce");

  const waiting = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems,
    contentItemRuns: firstItemOnly,
  });
  assert.ok(waiting.every((action) => !["deliver-download", "review", "publish-feedback"].includes(action.stageId)));
  assert.equal(waiting[0].stageId, "route");

  const actions = planNextActions({
    release,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems,
    contentItemRuns: [...firstItemOnly, ...doneThrough(contentItems[1].id, "produce")],
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "create_workboard_card");
  assert.equal(actions[0].stageId, "deliver-download");
  assert.equal(actions[0].contentItemId, undefined);
  assert.deepEqual(actions[0].card.automation.skills, ["lark-base", "background-worker-contract"]);
  assert.deepEqual(actions[0].card.automation.sideEffects, ["external-delivery"]);
  assert.doesNotMatch(actions[0].card.automation.skills.join(" "), /geelark/i);
  assert.match(actions[0].card.notes, /content-items\/video-ai-01\/handoffs\/produce\.json/);
  assert.match(actions[0].card.notes, /content-items\/video-scene-01\/handoffs\/produce\.json/);
  assert.match(actions[0].card.notes, /aggregate every validated ContentItem/);
  assert.match(actions[0].card.notes, /no separate human approval gate/);
  assert.ok(actions.every((action) => !["review", "publish-feedback"].includes(action.stageId)));
  assert.ok(actions.every((action) => action.type !== "request_approval"));
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

// A finished video that must not go out until a wall-clock moment. The card is
// planned and visible right away; the release time rides on it as scheduledAt,
// which is what puts the native board's hold in charge instead of withholding
// the card from the board.
function publishAt(release, spec, { now, deliveryMode = "publish" } = {}) {
  const timed = structuredClone(release);
  const stage = timed.spec.stages.find((entry) => entry.id === "publish-feedback");
  stage.releaseAt = spec;
  const instance = activeInstance(timed);
  instance.inputs.deliveryMode = deliveryMode;
  instance.inputs.publicationTarget = publicationTarget();
  const contentItems = [twoItems()[1]];
  const contentItemRuns = doneThrough(contentItems[0].id, "review");
  const plan = (extraRuns = []) => planNextActions({
    release: timed,
    instance,
    runs: [{ stageId: "plan", status: "done" }],
    contentItems,
    contentItemRuns: [...contentItemRuns, ...extraRuns],
    now: new Date(now),
  });
  const approvals = plan();
  instance.approvals = approvals
    .filter((action) => action.type === "request_approval")
    .map((action) => ({ stageId: "publish-feedback", contentItemId: action.contentItemId, ...action.approval, status: "approved" }));
  return { plan, instance, contentItems };
}

const NY = "America/New_York";

test("a publication stage carries its release moment on the card instead of withholding it", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  // 14:00 in New York on 17 September, so tonight's window is still ahead.
  const now = Date.parse("2026-09-17T18:00:00Z");
  const { plan } = publishAt(release, { dailyAt: "21:00", timezone: NY }, { now });
  const actions = plan();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "create_workboard_card");
  assert.equal(actions[0].stageId, "publish-feedback");
  // 21:00 EDT is 01:00 UTC the next day.
  assert.equal(actions[0].card.scheduledAt, Date.parse("2026-09-18T01:00:00Z"));
});

test("a video finished after tonight's window is held for the next one, not published late", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  // 22:30 in New York: tonight's 21:00 has passed.
  const now = Date.parse("2026-09-18T02:30:00Z");
  const { plan } = publishAt(release, { dailyAt: "21:00", timezone: NY }, { now });
  assert.equal(plan()[0].card.scheduledAt, Date.parse("2026-09-19T01:00:00Z"));
});

test("a daily release window follows the zone across a daylight-saving change", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const summer = publishAt(release, { dailyAt: "21:00", timezone: NY }, { now: Date.parse("2026-10-30T18:00:00Z") });
  const winter = publishAt(release, { dailyAt: "21:00", timezone: NY }, { now: Date.parse("2026-11-05T18:00:00Z") });
  // Both are 21:00 in New York, but the UTC instants differ by an hour because
  // the zone left daylight saving in between. A fixed offset would publish the
  // second one an hour early.
  assert.equal(summer.plan()[0].card.scheduledAt, Date.parse("2026-10-31T01:00:00Z"));
  assert.equal(winter.plan()[0].card.scheduledAt, Date.parse("2026-11-06T02:00:00Z"));
});

test("the release window can follow the publication target's own timezone", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const now = Date.parse("2026-09-17T18:00:00Z");
  const { plan } = publishAt(release, { dailyAt: "21:00", timezone: "${input.publicationTarget.timezone}" }, { now });
  assert.equal(plan()[0].card.scheduledAt, Date.parse("2026-09-18T01:00:00Z"));
});

test("an exact release moment can be set per video", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const timed = structuredClone(release);
  timed.spec.stages.find((entry) => entry.id === "publish-feedback").releaseAt = "${item.publishAt}";
  const instance = activeInstance(timed);
  instance.inputs.deliveryMode = "publish";
  instance.inputs.publicationTarget = publicationTarget();
  const contentItems = twoItems().map((item, index) => ({
    ...item,
    route: "SCENE_EDIT",
    publishAt: index === 0 ? "2026-09-18T01:00:00Z" : "2026-09-19T01:00:00Z",
  }));
  const contentItemRuns = contentItems.flatMap((item) => doneThrough(item.id, "review"));
  const args = { release: timed, instance, runs: [{ stageId: "plan", status: "done" }], contentItems, contentItemRuns };
  instance.approvals = planNextActions(args)
    .filter((action) => action.type === "request_approval")
    .map((action) => ({ stageId: "publish-feedback", contentItemId: action.contentItemId, ...action.approval, status: "approved" }));
  const actions = planNextActions(args);
  // One device serializes the two, so only the first is planned; it carries its
  // own moment rather than the project's.
  assert.equal(actions[0].contentItemId, "video-ai-01");
  assert.equal(actions[0].card.scheduledAt, Date.parse("2026-09-18T01:00:00Z"));
});

test("a stage the board is already holding is not planned a second time", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const now = Date.parse("2026-09-17T18:00:00Z");
  const { plan, contentItems } = publishAt(release, { dailyAt: "21:00", timezone: NY }, { now });
  const held = [{ contentItemId: contentItems[0].id, stageId: "publish-feedback", status: "scheduled" }];
  // Without "scheduled" counting as present work, every pass re-plans the stage
  // and asks the board for another card.
  assert.deepEqual(plan(held), []);
});

test("a stage held for release does not consume the project's concurrency", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const now = Date.parse("2026-09-17T18:00:00Z");
  const { plan, contentItems } = publishAt(release, { dailyAt: "21:00", timezone: NY }, { now });
  const held = Array.from({ length: release.spec.concurrency.perInstance }, () => ({
    contentItemId: contentItems[0].id, stageId: "publish-feedback", status: "scheduled",
  }));
  // Held cards are waiting on a clock, not on a worker, so they must not stand
  // in the way of the rest of the project.
  assert.equal(planNextActions({
    release, instance: activeInstance(release), runs: [], contentItems: twoItems(), contentItemRuns: held,
    now: new Date(now),
  }).length > 0, true);
});

test("a release time that cannot be resolved fails validation instead of publishing now", async () => {
  const workflow = await loadWorkflow(fixture);
  const stage = workflow.spec.stages.find((entry) => entry.id === "publish-feedback");
  for (const [label, spec] of [
    ["a twelve-hour clock", { dailyAt: "9pm", timezone: NY }],
    ["an unknown zone", { dailyAt: "21:00", timezone: "America/Nowhere" }],
    ["a missing zone", { dailyAt: "21:00" }],
    ["a non-timestamp", 42],
  ]) {
    stage.releaseAt = spec;
    const issues = validateWorkflow(workflow);
    assert.ok(
      issues.some((entry) => entry.code === "stage.releaseAt.invalid"),
      `${label} must be rejected at publish time`,
    );
  }
  // An expression is only resolvable against a project, so it passes here.
  stage.releaseAt = { dailyAt: "21:00", timezone: "${input.publicationTarget.timezone}" };
  assert.deepEqual(validateWorkflow(workflow).filter((entry) => entry.code === "stage.releaseAt.invalid"), []);
});

test("accepts bare executable names in requiredCommands and rejects paths or shell fragments", async () => {
  const declared = structuredClone(await loadWorkflow(fixture));
  declared.spec.requiredCommands = ["scene", "makaron-cli", "lark-cli"];
  declared.spec.stages[0].requiredCommands = ["lark-cli"];
  assert.deepEqual(validateWorkflow(declared).filter((entry) => entry.code === "requiredCommands.invalid"), []);

  const invalid = structuredClone(await loadWorkflow(fixture));
  invalid.spec.requiredCommands = ["/usr/bin/scene"];
  invalid.spec.stages[0].requiredCommands = [];
  const paths = validateWorkflow(invalid).filter((entry) => entry.code === "requiredCommands.invalid").map((entry) => entry.path);
  assert.deepEqual(paths, ["spec.requiredCommands", "spec.stages[0].requiredCommands"]);
});

test("spells each declared output as a file with the facts completion reads, including derived ones", () => {
  const release = { metadata: { name: "W", version: "1", workflowSha256: "x".repeat(64), id: "w" }, spec: { stages: [] } };
  const stage = {
    id: "produce",
    title: "Produce",
    actor: "agent",
    outputs: ["finishedAsset", "machineQc", "deliveryManifest", "notes"],
    completeWhen: ["output.finishedAsset.newForThisRun", "output.machineQc.terminal", "output.deliveryManifest.accessible", "output.deliveryManifest.approvedByLegal"],
  };
  const notes = buildAgentBrief(release, { id: "I", inputs: {} }, stage);
  assert.match(notes, /- finishedAsset: newForThisRun \(automatic: the file was written during this project run\)/);
  assert.match(notes, /- machineQc: terminal \(automatic: its JSON status is passed/);
  assert.match(notes, /- deliveryManifest: accessible \(automatic: the referenced file exists\); approvedByLegal must be true/);
  assert.match(notes, /- notes: no fact is checked beyond the handoff entry/);
  assert.doesNotMatch(notes, /Completion checks: output\./);
});

test("a project that authorized paid production does not also need an approval card per item", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const instance = activeInstance(release);
  instance.inputs.nightshift = { instanceDir: "/srv/nightshift/NS-LAB-001" };
  const runs = [{ stageId: "plan", status: "done" }];
  const contentItems = [twoItems()[0]];
  const contentItemRuns = doneThrough("video-ai-01", "brief");

  instance.inputs.authorizationScope = { paidProduction: false, externalPublication: false };
  assert.equal(planNextActions({ release, instance, runs, contentItems, contentItemRuns })[0].type, "request_approval");

  instance.inputs.authorizationScope = { paidProduction: true, externalPublication: false };
  const [action] = planNextActions({ release, instance, runs, contentItems, contentItemRuns });
  assert.equal(action.type, "create_workboard_card");
  assert.equal(action.stageId, "produce");

  // Publication binds an account and a device, so it keeps its own approval.
  const publishItems = [twoItems()[1]];
  const publishRuns = doneThrough("video-scene-01", "review");
  instance.inputs.authorizationScope = { paidProduction: true, externalPublication: true };
  instance.inputs.publicationTarget = publicationTarget();
  const publish = planNextActions({ release, instance, runs, contentItems: publishItems, contentItemRuns: publishRuns })[0];
  assert.equal(publish.type, "request_approval");
  assert.equal(publish.approval.effect, "external-publication");
});

test("a Workflow may name who hears when its projects finish", async () => {
  const base = await loadWorkflow(resolve(dirname(fileURLToPath(import.meta.url)), "../../../examples/workflows/xingqing-content-delivery.workflow.md"));
  const codes = (notifications) => validateWorkflow({ ...base, spec: { ...base.spec, notifications } })
    .filter((entry) => entry.code.startsWith("notifications")).map((entry) => `${entry.code} ${entry.path}`);
  assert.deepEqual(codes({ instanceCompleted: { enabled: true, to: "oc_88d96b7e42cbdfd33e6d096477a8cac8" } }), []);
  assert.deepEqual(codes({ instanceCompleted: { enabled: true, to: "user:ou_cb133fd4414f0607e8b46a3195c7b9d8" } }), []);
  assert.deepEqual(codes({ reviewRequested: { enabled: true }, instanceCompleted: { enabled: false } }), []);
  assert.deepEqual(codes({ instanceCompleted: { enabled: true, to: "Tianyi" } }), ["notifications.to.invalid spec.notifications.instanceCompleted.to"]);
  assert.deepEqual(codes({ instanceCompleted: { to: "oc_1" } }), ["notifications.event.config.invalid spec.notifications.instanceCompleted"]);
  assert.deepEqual(codes({ onFailure: { enabled: true } }), ["notifications.event.invalid spec.notifications.onFailure"]);
});
