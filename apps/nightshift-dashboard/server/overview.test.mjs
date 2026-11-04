import assert from "node:assert/strict";
import test from "node:test";
import { ALL_SCOPE_DONE_CARDS, buildOverview, leanCard, leanRun, overviewDetails } from "./overview.mjs";
import { needsYouQueue } from "../client/src/attention.js";

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
  assert.deepEqual(buildOverview({ scope: "shelved", instances, cards, releases, now: NOW }).cards.map((card) => card.id), [], "a shelved project is a tally");
  assert.deepEqual(buildOverview({ scope: "shelved", project: "OLD", instances, cards, releases, now: NOW }).cards.map((card) => card.id), ["c-old"], "until a page opens it");
  assert.equal(buildOverview({ scope: "all", instances, cards, releases, now: NOW }).cards.length, 2, "全部 keeps the open cards of every project");
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

test("a detailed project carries the items a person skipped, with a short reason", () => {
  const { instances, cards, releases } = fixture();
  const overview = buildOverview({ scope: "live", instances, cards, releases, skippedFor: (id) => id === "LIVE" ? [{ contentItemId: "i1", reason: "r".repeat(500), actor: "x", skippedAt: "t" }] : [], now: NOW });
  assert.deepEqual(overview.instances[0].skippedContentItems, [{ contentItemId: "i1", reason: "r".repeat(200) }]);
  assert.equal("skippedContentItems" in overview.instances[1], false, "a summary does not carry them");
});

test("each project carries when an Agent first worked on it, which a queued project lacks", () => {
  const { instances, releases } = fixture();
  const cards = [
    { id: "c1", status: "done", labels: ["instance:LIVE"], createdAt: NOW - 5 * 3_600_000, startedAt: NOW - 3_600_000, metadata: { automation: {} } },
    { id: "c2", status: "running", labels: ["instance:LIVE"], createdAt: NOW - 3_000_000, execution: { startedAt: NOW - 1_800_000 }, metadata: { automation: {} } },
    { id: "c3", status: "ready", labels: ["instance:OLD"], createdAt: NOW - 3_600_000, metadata: { automation: {} } },
  ];
  const overview = buildOverview({ scope: "live", instances, cards, releases, now: NOW });
  const byId = Object.fromEntries(overview.instances.map((instance) => [instance.id, instance]));
  assert.equal(byId.LIVE.workStartedAt, new Date(NOW - 3_600_000).toISOString(), "earliest start across the project's cards");
  assert.equal(byId.OLD.workStartedAt, null, "a card that only waits has no start");
});


test("only projects in the shown scope need their items and runs loaded", () => {
  const { instances } = fixture();
  const loaded = (scope) => instances.filter((instance) => overviewDetails(instance, scope, NOW)).map((instance) => instance.id);
  assert.deepEqual(loaded("live"), ["LIVE"]);
  assert.deepEqual(loaded("shelved"), [], "shelved and delivered projects go out as tallies");
  assert.deepEqual(loaded("all"), ["LIVE"], "archived projects are never loaded");
  assert.deepEqual(instances.filter((instance) => overviewDetails(instance, "shelved", NOW, "OLD")).map((instance) => instance.id), ["OLD"], "the opened project is loaded");
  assert.deepEqual(instances.filter((instance) => overviewDetails(instance, "all", NOW, "GONE")).map((instance) => instance.id), ["LIVE"], "never an archived one");
  assert.deepEqual(loaded("everything"), ["LIVE"], "an unknown scope reads as live, as buildOverview does");
});

test("a project sent as a tally draws like the same project in detail, in a fraction of the size", () => {
  const { releases } = fixture();
  const items = Array.from({ length: 80 }, (_, index) => ({ id: `i${index}`, title: `条目 ${index}`, route: "SCENE_EDIT", brief: bigBrief }));
  const done = {
    id: "DONE", name: "交付", status: "done", updatedAt: daysAgo(0), workflowSha256: "a".repeat(64), inputs: { targetCount: 80, authorizationScope: { paidProduction: true } }, approvals: [],
    contentItems: items, stageRuns: [],
    contentItemRuns: items.map((item) => ({ stageId: "brief", contentItemId: item.id, attempt: 1, cardId: `c-${item.id}`, status: "done", updatedAt: daysAgo(0) })),
  };
  const cards = items.map((item) => ({ id: `c-${item.id}`, title: `卡 ${item.id}`, status: "done", agentId: "makaron", updatedAt: NOW - 60_000, createdAt: 1, labels: ["instance:DONE", "stage:brief"], metadata: { automation: { instanceId: "DONE", stageId: "brief", contentItemId: item.id } } }));
  const tallied = buildOverview({ scope: "delivered", instances: [done], cards, releases, now: NOW });
  const opened = buildOverview({ scope: "delivered", project: "DONE", instances: [done], cards, releases, now: NOW });
  assert.equal(tallied.cards.length, 0);
  assert.deepEqual(tallied.instances[0].tally, { progress: { expected: 80, estimated: false, splitting: false }, stages: { brief: { planned: 80, counts: { done: 80 }, today: 80 } } });
  assert.equal(opened.instances[0].detail, true);
  assert.equal(opened.cards.length, 80);
  assert.ok(JSON.stringify(tallied).length * 10 < JSON.stringify(opened).length, `${JSON.stringify(tallied).length} vs ${JSON.stringify(opened).length}`);
});

test("全部 sends the open and today's cards of undetailed projects, the newest finished ones, and counts the rest", () => {
  const { releases } = fixture();
  const old = { id: "OLD", name: "旧", status: "done", updatedAt: daysAgo(5), workflowSha256: "a".repeat(64), contentItems: [], contentItemRuns: [], stageRuns: [] };
  const card = (id, status, updatedAt) => ({ id, status, updatedAt, labels: ["instance:OLD"], metadata: { automation: { instanceId: "OLD" } } });
  const cards = [
    ...Array.from({ length: ALL_SCOPE_DONE_CARDS + 5 }, (_, index) => card(`d${index}`, "done", NOW - 2 * 86_400_000 - index * 1000)),
    card("open", "blocked", NOW - 9 * 86_400_000),
    card("today", "done", NOW - 60_000),
    { id: "native", status: "done", updatedAt: NOW, labels: [] },
  ];
  const overview = buildOverview({ scope: "all", instances: [old], cards, releases, now: NOW });
  const ids = overview.cards.map((entry) => entry.id);
  assert.ok(ids.includes("open") && ids.includes("today") && ids.includes("d0"));
  assert.ok(!ids.includes(`d${ALL_SCOPE_DONE_CARDS}`), "older finished cards are only counted");
  assert.ok(!ids.includes("native"), "cards outside Night Shift projects stay out, as before");
  assert.equal(overview.cards.length, ALL_SCOPE_DONE_CARDS + 2);
  assert.equal(overview.omittedDoneCards, 5);
  assert.equal("omittedDoneCards" in buildOverview({ scope: "delivered", instances: [old], cards, releases, now: NOW }), false);
});

test("a tally judges a blocked task by the 需要你 queue, as the pages do", () => {
  const { releases } = fixture();
  const done = { id: "DONE", name: "交付", status: "done", updatedAt: daysAgo(1), workflowSha256: "a".repeat(64), inputs: { authorizationScope: { paidProduction: true } }, approvals: [], stageRuns: [],
    contentItems: [{ id: "i1" }, { id: "i2" }],
    contentItemRuns: ["i1", "i2"].map((id) => ({ stageId: "brief", contentItemId: id, attempt: 1, cardId: `c-${id}`, status: "blocked" })) };
  const cards = ["i1", "i2"].map((id) => ({ id: `c-${id}`, status: "blocked", labels: ["instance:DONE", "stage:brief"], metadata: { automation: { instanceId: "DONE", stageId: "brief", contentItemId: id } } }));
  const queue = needsYouQueue({ items: [{ cardId: "c-i1", kind: "decision", problem: "选一个" }] });
  const counts = (options) => buildOverview({ scope: "delivered", instances: [done], cards, releases, now: NOW, ...options }).instances[0].tally.stages.brief.counts;
  assert.deepEqual(counts({ queue }), { "needs-you": 1, healing: 1 }, "only the queued card needs a person");
  assert.deepEqual(counts({}), { "needs-you": 2 }, "without a queue the board judges blocked cards itself");
});
