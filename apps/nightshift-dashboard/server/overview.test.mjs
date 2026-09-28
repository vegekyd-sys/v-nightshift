import assert from "node:assert/strict";
import test from "node:test";
import { buildOverview, leanCard, leanRun } from "./overview.mjs";

const NOW = Date.parse("2026-09-28T10:00:00Z");
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();
const bigBrief = "x".repeat(20_000);

function fixture() {
  const instances = [
    { id: "LIVE", name: "在产", status: "active", updatedAt: daysAgo(0), workflowSha256: "a".repeat(64), inputs: { targetCount: 20, deliveryMode: "download", authorizationScope: { paidProduction: true }, nightshift: { instanceDir: "/srv/x" }, brief: bigBrief }, approvals: [], contentItems: [{ id: "i1", title: "条目", route: "SCENE_EDIT", brief: bigBrief }], contentItemRuns: [{ stageId: "brief", contentItemId: "i1", attempt: 1, cardId: "c-live", status: "blocked", updatedAt: daysAgo(0), failure: { kind: "database_lock", automaticRetry: true, nextRetryAt: daysAgo(0), rawError: "y".repeat(5_000) } }], stageRuns: [] },
    { id: "OLD", name: "搁置", status: "paused", updatedAt: daysAgo(9), workflowSha256: "b".repeat(64), inputs: { targetCount: 5 }, contentItems: [{ id: "o1", title: "旧" }], contentItemRuns: [{ stageId: "brief", contentItemId: "o1", attempt: 1, cardId: "c-old", status: "blocked" }], stageRuns: [] },
    { id: "GONE", name: "归档", status: "archived", updatedAt: daysAgo(1), workflowSha256: "a".repeat(64) },
  ];
  const card = (id, instance) => ({
    id, title: `卡 ${id}`, status: "blocked", agentId: "makaron", updatedAt: 1, createdAt: 1,
    labels: [`instance:${instance}`, "stage:brief", "workboard:internal", "nightshift:approval"],
    notes: bigBrief, events: [{ type: "moved", at: 1 }], execution: { big: bigBrief },
    metadata: { automation: { instanceId: instance, stageId: "brief", contentItemId: "i1", idempotencyKey: "k", prompt: bigBrief }, comments: [{ body: bigBrief }], attempts: [{ runId: "r" }] },
  });
  const releases = [
    { workflowId: "wf", name: "WF", version: "1.1", workflowSha256: "a".repeat(64), publishedAt: "2026-09-20", sourceMarkdown: bigBrief, sourceYaml: bigBrief, manifest: { spec: { ownerAgentRole: "op", inputs: { targetCount: { type: "number" } }, stages: [{ id: "brief", title: "Brief", scope: "content-item", actor: "agent", objective: bigBrief, approval: { before: "paid-production" } }] } } },
    { workflowId: "wf", name: "WF", version: "1.0", workflowSha256: "b".repeat(64), publishedAt: "2026-09-01", sourceMarkdown: bigBrief, manifest: { spec: { stages: [{ id: "brief", objective: bigBrief }] } } },
  ];
  return { instances, cards: [card("c-live", "LIVE"), card("c-old", "OLD")], releases };
}

test("the live overview carries only projects in production in detail, and no heavy fields", () => {
  const { instances, cards, releases } = fixture();
  const overview = buildOverview({ scope: "live", instances, cards, releases, operationsFor: () => [{ ownerCardId: "c-live", status: "executing", idempotencyKey: "k", result: bigBrief }], now: NOW });
  assert.deepEqual(overview.instances.map((instance) => [instance.id, instance.detail]), [["LIVE", true], ["OLD", false]], "archived projects are gone; the shelved one is a summary");
  assert.deepEqual(overview.cards.map((card) => card.id), ["c-live"]);
  assert.ok(JSON.stringify(overview).length < 6_000, `payload stays small: ${JSON.stringify(overview).length}`);
});

test("a lean card keeps what the pages draw and drops the brief, events and comments", () => {
  const { cards } = fixture();
  const lean = leanCard(cards[0]);
  assert.deepEqual(lean.labels, ["instance:LIVE", "stage:brief", "nightshift:approval"]);
  assert.deepEqual(lean.metadata, { automation: { instanceId: "LIVE", stageId: "brief", contentItemId: "i1" } });
  for (const heavy of ["notes", "events", "execution"]) assert.equal(heavy in lean, false, heavy);
});

test("a lean run keeps the failure fields the attention rules read, and a short error", () => {
  const { instances } = fixture();
  const run = leanRun(instances[0].contentItemRuns[0]);
  assert.equal(run.failure.automaticRetry, true);
  assert.equal(run.failure.nextRetryAt, instances[0].contentItemRuns[0].failure.nextRetryAt);
  assert.equal(run.failure.rawError.length, 200);
});

test("a detailed project keeps the inputs that size its bar and authorize its work, not its brief", () => {
  const { instances, cards, releases } = fixture();
  const live = buildOverview({ scope: "live", instances, cards, releases, now: NOW }).instances[0];
  assert.deepEqual(Object.keys(live.inputs).sort(), ["authorizationScope", "deliveryMode", "targetCount"]);
  assert.deepEqual(live.contentItems, [{ id: "i1", title: "条目", route: "SCENE_EDIT" }]);
});

test("workflows carry stage structure for releases in use or latest, and never their source", () => {
  const { instances, cards, releases } = fixture();
  const [latest, old] = buildOverview({ scope: "live", instances, cards, releases, now: NOW }).workflows;
  assert.deepEqual(latest.manifest.spec.stages, [{ id: "brief", title: "Brief", scope: "content-item", actor: "agent", approval: { before: "paid-production" } }]);
  assert.equal("sourceMarkdown" in latest, false);
  assert.equal("manifest" in old, false, "an old release nobody shown uses is a summary");
});

test("other scopes and an unknown scope", () => {
  const { instances, cards, releases } = fixture();
  assert.deepEqual(buildOverview({ scope: "shelved", instances, cards, releases, now: NOW }).cards.map((card) => card.id), ["c-old"]);
  assert.equal(buildOverview({ scope: "all", instances, cards, releases, now: NOW }).cards.length, 2);
  assert.equal(buildOverview({ scope: "everything", instances, cards, releases, now: NOW }).scope, "live");
});

test("tab sizes and agents' finished work count every project, not only the loaded scope", () => {
  const { instances, cards, releases } = fixture();
  cards[1].status = "done";
  cards[1].updatedAt = NOW - 60_000;
  const overview = buildOverview({ scope: "live", instances, cards, releases, now: NOW });
  assert.deepEqual(overview.cardCounts, { live: 1, paused: 0, delivered: 0, shelved: 1, all: 2 });
  assert.deepEqual(overview.agentDoneToday, { makaron: 1 });
});
