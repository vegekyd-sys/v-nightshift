import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  NeedsYouTracker,
  NightShiftNotificationCoordinator,
  NightShiftRuntime,
  NightShiftStore,
  buildNeedsYou,
  compileWorkflow,
  describeStop,
  groupKey,
  loadWorkflow,
} from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");
const MIN = 60_000;

class DecisionWorkboard {
  constructor() {
    this.cards = [];
    this.updates = [];
  }

  async listCards({ cardIds } = {}) {
    return cardIds ? this.cards.filter((card) => cardIds.includes(card.id)) : this.cards;
  }

  async updateCard(id, patch) {
    this.updates.push({ id, ...patch });
    const card = this.cards.find((entry) => entry.id === id);
    if (patch.notes) card.notes = patch.notes;
    return card;
  }

  async resetCardFailures() {}

  async releaseCard(id, status) {
    const card = this.cards.find((entry) => entry.id === id);
    card.status = status;
    return card;
  }
}

async function fixture({ instanceStatus = "active", instanceUpdatedAt = null } = {}) {
  let clock = Date.parse("2026-09-28T14:00:00Z");
  const store = new NightShiftStore();
  const workboard = new DecisionWorkboard();
  const tracker = new NeedsYouTracker({ store, graceMs: 2 * MIN, now: () => clock });
  const runtime = new NightShiftRuntime({ store, workboard, needsYou: tracker });
  const release = runtime.publish(await readFile(workflowPath, "utf8"));
  runtime.startInstance({
    id: "NS-NY",
    name: "需要你测试",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    inputs: { authorizationScope: { paidProduction: true, externalPublication: false } },
  });
  runtime.setContentItems("NS-NY", [
    { id: "video-1", title: "One", route: "SCENE_EDIT" },
    { id: "video-2", title: "Two", route: "SCENE_EDIT" },
  ]);
  if (instanceStatus !== "active") store.updateInstanceStatus("NS-NY", instanceStatus, new Date(instanceUpdatedAt ?? clock));
  tracker.baselineAt();
  clock += MIN;
  const stage = release.manifest.spec.stages.find((entry) => entry.id === "produce");
  const observe = (card, extra = {}) => tracker.observe({
    card,
    instance: store.getInstance("NS-NY"),
    stage,
    stageId: "produce",
    contentItemId: card.labels.find((label) => label.startsWith("content-item:"))?.slice("content-item:".length) ?? null,
    status: card.status,
    ...extra,
  });
  const card = (id, item, extra = {}) => {
    const entry = {
      id,
      status: "blocked",
      runId: `run-${id}`,
      updatedAt: clock,
      labels: ["instance:NS-NY", "stage:produce", `content-item:${item}`],
      ...extra,
    };
    workboard.cards.push(entry);
    return entry;
  };
  return { advance: (ms) => { clock += ms; }, card, now: () => clock, observe, release, runtime, store, tracker, workboard };
}

const MAKARON_STOP = {
  kind: "contract_error",
  source: "workflow",
  rawError: "External side effect has no succeeded Night Shift operation checkpoint",
  agentReport: "卡已 block（无成片）。**结论**：produce 阶段拿不到视频，Makaron 两次拉取素材超时（400）。建议人工决定是否更换素材。",
};

test("blocked cards from before the first run are history, not requests", async () => {
  const { card, observe, store } = await fixture();
  const old = card("old", "video-1", { updatedAt: Date.parse("2026-09-20T00:00:00Z") });
  observe(old, { failure: MAKARON_STOP });
  assert.equal(store.listDecisionRequests().length, 0);
  store.close();
});

test("a stop with a recorded failure opens a request at once, in the Agent's words", async () => {
  const { card, observe, store } = await fixture();
  const request = observe(card("c1", "video-1"), { failure: MAKARON_STOP });
  assert.equal(request.status, "open");
  assert.equal(request.source, "engine");
  assert.equal(request.scope, "item");
  assert.match(request.problem, /Makaron 两次拉取素材超时/);
  assert.doesNotMatch(request.problem, /checkpoint/);
  assert.deepEqual(request.options.map((option) => option.id), ["retry", "pause"]);
  assert.equal(store.listDecisionRequests().length, 1);
  observe(store.getDecisionRequest(request.id) && card("c1b", "video-1", { id: "c1", runId: "run-c1" }), { failure: MAKARON_STOP });
  assert.equal(store.listDecisionRequests().length, 1, "the same attempt never opens a second request");
  store.close();
});

test("cards the engine will recover by itself never reach 需要你", async () => {
  const { card, observe, store } = await fixture();
  observe(card("auto", "video-1"), { failure: { kind: "database_lock", retryable: true, automaticRetry: true } });
  observe(card("paid", "video-2"), { operation: { status: "executing", externalTaskId: "task-1" } });
  assert.equal(store.listDecisionRequests().length, 0);
  store.close();
});

test("a bare block waits out the grace period as pending, then opens", async () => {
  const { advance, card, observe, store, tracker } = await fixture();
  const bare = card("bare", "video-1");
  observe(bare, { summary: "" });
  assert.equal(store.listDecisionRequests().length, 0);
  assert.equal(tracker.pendingList().length, 1);
  assert.ok(Date.parse(tracker.pendingList()[0].until) > 0);
  advance(3 * MIN);
  const request = observe(bare, { summary: "" });
  assert.equal(request.problem, "Agent 停下了，没有给出原因");
  assert.equal(tracker.pendingList().length, 0);
  store.close();
});

test("a card that moves on, or starts a new attempt, supersedes its request", async () => {
  const { card, observe, store } = await fixture();
  const c = card("moving", "video-1");
  const first = observe(c, { failure: MAKARON_STOP });
  c.status = "running";
  observe(c);
  assert.equal(store.getDecisionRequest(first.id).status, "superseded");
  c.status = "blocked";
  c.runId = "run-moving-2";
  const second = observe(c, { failure: MAKARON_STOP });
  assert.notEqual(second.id, first.id);
  assert.equal(store.listDecisionRequests().length, 1);
  store.close();
});

test("a shelved project opens nothing", async () => {
  const { card, observe, store } = await fixture({ instanceStatus: "paused", instanceUpdatedAt: Date.parse("2026-09-20T00:00:00Z") });
  observe(card("shelved", "video-1"), { failure: MAKARON_STOP });
  assert.equal(store.listDecisionRequests().length, 0);
  store.close();
});

test("the 需要你 queue groups one root cause and includes cards waiting for review", async () => {
  const { card, now, observe, release, store, workboard } = await fixture();
  observe(card("g1", "video-1"), { failure: MAKARON_STOP });
  observe(card("g2", "video-2"), { failure: { ...MAKARON_STOP, agentReport: MAKARON_STOP.agentReport.replace("两次", "两次") } });
  workboard.cards.push({ id: "approval-1", status: "review", title: "确认付费生产", updatedAt: now(), labels: ["instance:NS-NY", "stage:produce", "content-item:video-1", "nightshift:approval"] });
  const queue = buildNeedsYou({
    store,
    instances: store.listInstances(),
    cards: workboard.cards,
    releases: [{ workflowSha256: release.workflowSha256, manifest: release.manifest }],
    now: now(),
  });
  const decisions = queue.items.filter((item) => item.kind === "decision");
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].groupKey, decisions[1].groupKey);
  assert.equal(decisions[0].groupSize, 2);
  assert.ok(decisions[0].problem.length <= 200);
  assert.equal(queue.items.find((item) => item.kind === "approval").id, "approval:approval-1");
  assert.equal(queue.countsByInstance["NS-NY"], 3);
  store.close();
});

test("retry carries the person's decision into the next brief and is recorded once", async () => {
  const { card, observe, runtime, store, workboard } = await fixture();
  const request = observe(card("r1", "video-1"), { failure: MAKARON_STOP });
  const result = await runtime.decide({ decisionId: request.id, optionId: "retry", note: "已补素材，换用 3 段新视频", actor: "Workboard operator" });
  assert.deepEqual(result.affectedCardIds, ["r1"]);
  assert.equal(result.alreadyDecided, false);
  assert.equal(result.request.status, "decided");
  assert.equal(workboard.cards[0].status, "ready");
  assert.match(workboard.cards[0].notes, /^## 人工决定\nWorkboard operator 的决定：重新执行\n已补素材，换用 3 段新视频/);
  const again = await runtime.decide({ decisionId: request.id, optionId: "retry", actor: "Workboard operator" });
  assert.equal(again.alreadyDecided, true);
  assert.deepEqual(again.affectedCardIds, []);
  store.close();
});

test("a decision can apply to every card with the same root cause", async () => {
  const { card, observe, runtime, store, workboard } = await fixture();
  const first = observe(card("a", "video-1"), { failure: MAKARON_STOP });
  observe(card("b", "video-2"), { failure: MAKARON_STOP });
  const result = await runtime.decide({ decisionId: first.id, optionId: "retry", actor: "Workboard operator", applyToGroup: true });
  assert.deepEqual(result.affectedCardIds.sort(), ["a", "b"]);
  assert.equal(store.listDecisionRequests().length, 0);
  assert.ok(workboard.cards.every((entry) => entry.status === "ready"));
  store.close();
});

test("pause stops the project and leaves the request open", async () => {
  const { card, observe, runtime, store } = await fixture();
  const request = observe(card("p", "video-1"), { failure: MAKARON_STOP });
  const result = await runtime.decide({ decisionId: request.id, optionId: "pause", actor: "Workboard operator" });
  assert.equal(store.getInstance("NS-NY").status, "paused");
  assert.equal(result.request.status, "open");
  store.close();
});

test("the needs-you notice batches stops per project, groups them, and is sent once", async () => {
  const { advance, card, now, observe, release, store, workboard } = await fixture();
  const sent = [];
  const coordinator = new NightShiftNotificationCoordinator({
    baseUrl: "https://nightshift.example",
    now: () => new Date(now()),
    sender: { async send(delivery) { sent.push(delivery); return { messageId: `om_${sent.length}` }; } },
    store,
  });
  const releases = [{ workflowSha256: release.workflowSha256, manifest: { spec: { notifications: { instanceCompleted: { enabled: true, to: "oc_group" } } } } }];
  const pass = () => coordinator.reconcile({ cards: workboard.cards, instances: store.listInstances(), releases });
  await pass(); // completion bootstrap
  observe(card("n1", "video-1"), { failure: MAKARON_STOP });
  observe(card("n2", "video-2"), { failure: MAKARON_STOP });
  await pass();
  assert.equal(sent.length, 0, "stops wait out the batch window");
  advance(3 * MIN);
  await pass();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "needs-you");
  assert.equal(sent[0].targetChatId, "oc_group");
  assert.match(sent[0].presentation.title, /需要你 · 需要你测试/);
  assert.match(sent[0].presentation.blocks[0].text, /2 张卡停下了：.*Makaron 两次拉取素材超时/);
  assert.match(sent[0].presentation.blocks[1].text, /重新执行 \/ 暂停项目/);
  advance(3 * MIN);
  await pass();
  assert.equal(sent.length, 1, "announced requests are not announced again");
  store.close();
});

test("without a target the notice is not sent, yet the requests count as seen", async () => {
  const { advance, card, now, observe, release, store, workboard } = await fixture();
  const sent = [];
  const coordinator = new NightShiftNotificationCoordinator({
    baseUrl: "https://nightshift.example",
    now: () => new Date(now()),
    sender: { async send(delivery) { sent.push(delivery); return { messageId: "om" }; } },
    store,
  });
  const releases = [{ workflowSha256: release.workflowSha256, manifest: { spec: { notifications: {} } } }];
  await coordinator.reconcile({ cards: workboard.cards, instances: store.listInstances(), releases });
  const request = observe(card("quiet", "video-1"), { failure: MAKARON_STOP });
  advance(3 * MIN);
  await coordinator.reconcile({ cards: workboard.cards, instances: store.listInstances(), releases });
  assert.equal(sent.length, 0);
  assert.ok(store.getDecisionRequest(request.id).announcedAt);
  store.close();
});

test("describeStop and groupKey read the same root cause across items", () => {
  assert.equal(describeStop({}).problem, "Agent 停下了，没有给出原因");
  assert.match(describeStop({ failure: { kind: "worker_unavailable", rawError: "Worker unavailable" } }).problem, /执行 Worker 未响应/);
  const a = groupKey({ instanceId: "I", stageId: "produce", failure: { kind: "contract_error" }, problem: "第 1 条：Makaron 拉取素材超时 ast_7723013c4f" });
  const b = groupKey({ instanceId: "I", stageId: "produce", failure: { kind: "contract_error" }, problem: "第 2 条：Makaron 拉取素材超时 ast_9912a8b3c0" });
  assert.equal(a, b);
});

test("a Workflow may declare needsYou on its own", async () => {
  const { validateWorkflow } = await import("../src/index.mjs");
  const base = await loadWorkflow(workflowPath);
  const issues = validateWorkflow({ ...base, spec: { ...base.spec, notifications: { needsYou: { enabled: true, to: "oc_88d96b7e42cbdfd33e6d096477a8cac8" } } } })
    .filter((entry) => entry.code.startsWith("notifications"));
  assert.deepEqual(issues, []);
  assert.ok(compileWorkflow(base));
});
