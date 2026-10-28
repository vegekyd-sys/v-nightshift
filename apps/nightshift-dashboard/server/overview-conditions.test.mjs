import assert from "node:assert/strict";
import test from "node:test";
import { buildOverview } from "./overview.mjs";
import * as attention from "../client/src/attention.js";
import { stageEnabled } from "../../../packages/nightshift-core/src/workflow.mjs";

const SHA = "a".repeat(64);
const NOW = Date.parse("2026-10-28T00:00:00Z");

function fixture(proxyMode = "buy", accountMode = "buy") {
  const stages = [
    { id: "plan" },
    ...["proxy", "account"].flatMap((kind) => ["buy", "reuse"].map((mode) => ({
      id: `${kind}-${mode}`, when: { input: `${kind}Mode`, equals: mode },
    }))),
    { id: "allocate" },
    ...["environment", "authenticate", "decorate", "writeback"].map((id) => ({ id, scope: "content-item" })),
    { id: "summary" },
  ];
  const instance = {
    id: "SYNTHETIC", status: "done", workflowSha256: SHA,
    inputs: { proxyMode, accountMode, targetCount: 3, privateContext: { password: "DO-NOT-PROJECT" } },
    contentItems: ["a", "b", "c"].map((id) => ({ id })), stageRuns: [], contentItemRuns: [],
  };
  for (const stage of stages.filter((stage) => stageEnabled(stage, instance.inputs))) {
    for (const contentItemId of stage.scope === "content-item" ? ["a", "b", "c"] : [null]) {
      const run = { stageId: stage.id, contentItemId, attempt: 1, status: "done", cardId: `${stage.id}-${contentItemId ?? "project"}` };
      (contentItemId ? instance.contentItemRuns : instance.stageRuns).push(run);
    }
  }
  const cards = [...instance.stageRuns, ...instance.contentItemRuns].map((run) => ({
    id: run.cardId, status: "done", labels: [`instance:${instance.id}`, `stage:${run.stageId}`],
  }));
  const releases = [{ workflowId: "synthetic", workflowSha256: SHA, manifest: { spec: { stages } } }];
  return { instances: [instance], cards, releases, now: NOW };
}

for (const [proxy, account] of [["buy", "buy"], ["reuse", "reuse"], ["buy", "reuse"], ["reuse", "buy"]]) {
  test(`overview branch facts keep nine stages and 17/17 tasks for ${proxy}/${account}`, () => {
    const input = fixture(proxy, account);
    const unchanged = JSON.stringify(input);
    const overview = JSON.parse(JSON.stringify(buildOverview({ ...input, scope: "delivered" })));
    const project = overview.instances[0];
    const stages = overview.workflows[0].manifest.spec.stages;
    assert.equal(attention.projectProgress(stages, project).expected, 17, "lean overview must not lose the two conditional tasks");
    const visible = attention.visibleStages(stages, [project]);
    assert.equal(visible.length, 9);
    assert.equal(attention.projectRuns(project).filter((run) => run.status === "done").length, 17);
    assert.equal(visible.reduce((sum, stage) => sum + attention.stageExpected(stage, [project]), 0), 17);
    for (const [kind, selected] of [["proxy", proxy], ["account", account]]) {
      assert.ok(visible.some((stage) => stage.id === `${kind}-${selected}`));
      assert.ok(!visible.some((stage) => stage.id === `${kind}-${selected === "buy" ? "reuse" : "buy"}`));
      assert.equal(attention.stageExpected(visible.find((stage) => stage.id === `${kind}-${selected}`), [project]), 1);
    }
    assert.equal(project.inputs.proxyMode, undefined);
    assert.equal(project.inputs.accountMode, undefined);
    assert.ok(!JSON.stringify(overview).includes("DO-NOT-PROJECT"));
    assert.equal(JSON.stringify(input), unchanged, "display projection never mutates runtime data");
  });
}

test("overview evaluates generic conditions with engine semantics without exposing their values", () => {
  const { instances, releases } = fixture();
  const conditions = [
    ["false", { input: "flag", equals: false }], ["zero", { input: "amount", equals: 0 }],
    ["null", { input: "nullable", equals: null }], ["missing-equals", { input: "missing", equals: false }],
    ["missing-not-equals", { input: "missing", notEquals: "buy" }],
    ["secret", { input: "credential", equals: true }], ["ordinary", null],
  ];
  const stages = conditions.map(([id, when]) => ({ id, ...(when ? { when } : {}) }));
  releases[0].manifest.spec.stages = stages;
  instances[0].inputs = { flag: false, amount: 0, nullable: null, credential: "SYNTHETIC-PRIVATE-VALUE", arbitrary: "DROP-ME" };
  instances[0].stageRuns = []; instances[0].contentItemRuns = [];
  const overview = buildOverview({ scope: "delivered", instances, releases, cards: [], now: NOW });
  const project = overview.instances[0];
  const expected = stages.filter((stage) => stageEnabled(stage, instances[0].inputs)).map((stage) => stage.id);
  assert.deepEqual(attention.visibleStages(stages, [project]).map((stage) => stage.id), expected);
  assert.deepEqual(project.stageConditions, Object.fromEntries(stages.map((stage) => [stage.id, stageEnabled(stage, instances[0].inputs)])));
  assert.deepEqual(project.inputs, {});
  assert.ok(!JSON.stringify(overview).includes("SYNTHETIC-PRIVATE-VALUE"));
  assert.ok(!JSON.stringify(overview).includes("DROP-ME"));
});

test("conditional work is visible before its cards exist, and projects retain independent branches", () => {
  const data = fixture();
  data.instances[0].stageRuns = [{ stageId: "plan", attempt: 1, status: "done" }];
  data.instances[0].contentItemRuns = [];
  const other = fixture("reuse", "reuse").instances[0];
  other.id = "SYNTHETIC-REUSE";
  data.instances.push(other);
  const overview = buildOverview({ ...data, cards: [], scope: "delivered" });
  const stages = overview.workflows[0].manifest.spec.stages;
  const [pending, complete] = overview.instances;
  assert.equal(attention.projectProgress(stages, pending).expected, 17);
  assert.equal(attention.visibleStages(stages, [pending]).length, 9);
  assert.equal(attention.visibleStages(stages, overview.instances).length, 11);
  for (const id of ["proxy-buy", "proxy-reuse", "account-buy", "account-reuse"]) {
    const stage = stages.find((entry) => entry.id === id);
    assert.equal(attention.stageExpected(stage, overview.instances), 1, id);
  }
  assert.equal(attention.projectProgress(stages, complete).expected, 17);
  assert.equal(stages.reduce((sum, stage) => sum + attention.stageExpected(stage, overview.instances), 0), 34);
});

test("full project responses without branch facts still support conditions and historical work", () => {
  const { instances, releases } = fixture("buy", "reuse");
  const stages = releases[0].manifest.spec.stages;
  assert.equal(attention.visibleStages(stages, instances).length, 9);
  assert.equal(attention.projectProgress(stages, instances[0]).expected, 17);
  assert.equal(stages.reduce((sum, stage) => sum + attention.stageExpected(stage, instances), 0), 17);
});

test("historical tasks remain visible without predicting more work in a disabled stage", () => {
  const data = fixture("reuse", "reuse");
  const stage = { id: "historical", scope: "content-item", when: { input: "oldFlag", equals: true } };
  data.releases[0].manifest.spec.stages.push(stage);
  data.instances[0].contentItemRuns.push(
    { stageId: stage.id, contentItemId: "a", attempt: 1, status: "blocked" },
    { stageId: stage.id, contentItemId: "a", attempt: 2, status: "done" },
  );
  const overview = buildOverview({ ...data, scope: "delivered" });
  const project = overview.instances[0];
  const stages = overview.workflows[0].manifest.spec.stages;
  assert.equal(attention.stageExpected(stage, [project]), 1, "count the historical item once, not all three items");
  assert.equal(project.stageConditions.historical, false, "history does not enable the branch");
  assert.ok(attention.visibleStages(stages, [project]).some((entry) => entry.id === stage.id));
  assert.equal(attention.projectProgress(stages, project).expected, 18);
  project.skippedContentItems = [{ contentItemId: "a" }];
  assert.equal(attention.stageExpected(stage, [project]), 0, "skipped items do not add expected work");
});

test("all disabled branches stay hidden and overview summaries do not invent branch facts", () => {
  const data = fixture();
  data.instances[0].stageRuns = []; data.instances[0].contentItemRuns = [];
  data.releases[0].manifest.spec.stages = [{ id: "disabled", when: { input: "absent", equals: true } }];
  const overview = buildOverview({ ...data, cards: [], scope: "delivered" });
  assert.deepEqual(attention.visibleStages(overview.workflows[0].manifest.spec.stages, overview.instances), []);
  assert.equal(attention.projectProgress(overview.workflows[0].manifest.spec.stages, overview.instances[0]).expected, 0);
  const summary = buildOverview({ ...data, scope: "live" }).instances[0];
  assert.equal(summary.detail, false);
  assert.equal(Object.hasOwn(summary, "stageConditions"), false);
});
