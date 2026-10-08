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
  DESCRIBE_VERSION,
  describeStop,
  groupKey,
  loadWorkflow,
  stopOptionsFor,
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

  async getSession(sessionKey) {
    this.sessionReads = (this.sessionReads ?? 0) + 1;
    return this.sessions?.get(sessionKey) ?? { messages: [] };
  }

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
  // Written the way the real DL-0928-07 report was: labels at line start.
  agentReport: "卡已 block（无成片）。\n**结论**：produce 阶段拿不到视频，Makaron 两次拉取素材超时（400）。\n**建议**：建议人工决定是否更换素材。",
};

// On V at deploy time the only two cards that truly needed a person (GeeLark
// 圣山-BR-008 and 圣山-US-009) had stopped days earlier. They must show on the
// board; only the notice is for what is new.
test("a stop from before the first run enters the queue but is not announced", async () => {
  const { card, observe, store } = await fixture();
  const old = card("old", "video-1", { updatedAt: Date.parse("2026-09-26T00:04:00Z") });
  const request = observe(old, { failure: MAKARON_STOP });
  assert.equal(request.status, "open");
  assert.ok(request.announcedAt, "treated as already announced");
  const fresh = observe(card("fresh", "video-2"), { failure: MAKARON_STOP });
  assert.equal(fresh.announcedAt, null);
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
  // A stop on one content item may also skip it; pausing stops the whole project.
  assert.deepEqual(request.options.map((option) => option.id), ["retry", "skip", "pause"]);
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
  const blocks = sent[0].presentation.blocks.map((block) => block.text ?? "");
  assert.equal(sent[0].presentation.title, "需要你决定 · 需要你测试");
  assert.match(blocks[0], /停下了：2 张卡，同一个原因/);
  assert.ok(blocks.some((text) => /^\*\*发生了什么\*\*\n.*Makaron 两次拉取素材超时/.test(text)));
  assert.ok(blocks.some((text) => /^\*\*影响\*\*\n2 张卡停在/.test(text)));
  assert.ok(blocks.some((text) => /^\*\*建议怎么做\*\*\n建议人工决定是否更换素材/.test(text)));
  assert.ok(blocks.some((text) => /\*\*重新执行\*\*：按原任务再跑一次/.test(text) && /\*\*跳过这一条\*\*：这一条不做了，其余照常交付/.test(text) && /\*\*暂停项目\*\*：暂停整个项目/.test(text)));
  assert.equal(sent[0].presentation.blocks.at(-1).buttons[0].label, "去看板处理");
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

// An Agent that stops writes 问题 / 原因 / 影响 / 建议; each lands in its place.
const LABELED_REPORT = [
  "卡已 block（无成片）。",
  "**问题**：Makaron 两次都没能在规定时间内下载到素材（报错 400），没有扣积分，也没有出视频。",
  "**原因**：项目在 Scene 里只有 1 段视频素材，每条 brief 都重复用了 7–11 次，Makaron 反复抓同一个链接超时。",
  "**影响**：这个项目 30 条都在用这一段素材，后面的条目大概率也会停下。",
  "**建议**：先确认能否补视频素材；能补就补进 Scene 后重新执行，补不了就暂停项目。",
].join("\n");

test("a labeled stop report fills what happened, why, impact and what to do", () => {
  const described = describeStop({ failure: { kind: "contract_error", agentReport: LABELED_REPORT } });
  assert.match(described.problem, /^Makaron 两次都没能在规定时间内下载到素材/);
  assert.match(described.cause, /只有 1 段视频素材/);
  assert.match(described.impact, /30 条都在用这一段素材/);
  assert.match(described.suggestion, /^先确认能否补视频素材/);
});

test("an unlabeled report still yields a cause and a suggestion, or a fitting default", () => {
  const unlabeled = describeStop({ failure: { kind: "worker_unavailable", agentReport: "拿不到视频。失败点在 Makaron 侧对素材 URL 的抓取超时。建议人工决定是否更换素材传输方式。" } });
  assert.match(unlabeled.cause, /失败点在 Makaron/);
  assert.match(unlabeled.suggestion, /建议人工决定/);
  assert.match(describeStop({}).suggestion, /能补齐就「重新执行」/);
});

test("the card renders in the accepted layout", async () => {
  const { needsYouPresentation, needsYouGroups } = await import("../src/index.mjs");
  const described = describeStop({ failure: { kind: "contract_error", agentReport: LABELED_REPORT } });
  const request = { id: "d1", kind: "decision", stageId: "produce", groupKey: "g", options: [
    { id: "retry", label: "重新执行", effect: "retry", description: "按原任务再跑一次，可以附一句话给 agent（比如「已补素材」）" },
    { id: "pause", label: "暂停项目", effect: "pause", description: "不再派新任务，问题解决后再恢复" },
  ], ...described };
  const groups = needsYouGroups({ items: [request, { ...request, id: "d2" }], stages: [{ id: "produce", title: "出片" }] });
  const card = needsYouPresentation({
    instance: { id: "DL-0928-07", name: "中纺 日语 30条（下载交付）" },
    groups,
    projectUrl: "https://nightshift.example/?project=DL-0928-07",
    now: new Date("2026-09-28T14:07:00Z"),
  });
  assert.equal(card.title, "需要你决定 · 中纺 日语 30条（下载交付）");
  assert.equal(card.tone, "warning");
  assert.deepEqual(card.blocks.map((block) => block.type), ["text", "text", "text", "text", "text", "text", "context", "buttons"]);
  assert.equal(card.blocks[0].text, "**出片停下了：2 张卡，同一个原因**");
  assert.match(card.blocks[1].text, /^\*\*发生了什么\*\*\nMakaron 两次/);
  assert.match(card.blocks[2].text, /^\*\*为什么\*\*\n项目在 Scene 里只有 1 段视频素材/);
  assert.match(card.blocks[3].text, /^\*\*影响\*\*\n2 张卡停在「出片」。这个项目 30 条都在用这一段素材/);
  assert.match(card.blocks[4].text, /^\*\*建议怎么做\*\*\n先确认能否补视频素材/);
  assert.match(card.blocks[5].text, /^\*\*可选操作\*\*\n· \*\*重新执行\*\*：按原任务再跑一次/);
  assert.equal(card.blocks[6].text, "项目 DL-0928-07 · 22:07 · 同一原因的卡会合并在这一条里");
  assert.equal(card.blocks[7].buttons[0].label, "去看板处理");
});

test("the engine's own completion checks read in words a person can act on", () => {
  const sideEffect = describeStop({ failure: { kind: "contract_error", rawError: "Completion validation failed: External side effect has no succeeded Night Shift operation checkpoint" } });
  assert.match(sideEffect.problem, /外部操作.*没有成功记录/);
  assert.match(sideEffect.suggestion, /确认外部平台上这一步成没成/);
  assert.doesNotMatch(sideEffect.problem, /checkpoint/);
  const path = describeStop({ failure: { kind: "contract_error", rawError: "Completion validation failed: Artifact path must stay inside the instance directory" } });
  assert.match(path.problem, /项目目录之外/);
  const unknown = describeStop({ failure: { kind: "contract_error", rawError: "Something new broke" } });
  assert.equal(unknown.problem, "产物没有通过完成校验");
  assert.match(unknown.cause, /Something new broke/);
});

test("a cause that only repeats the problem is left out", () => {
  const described = describeStop({ failure: { kind: "worker_unavailable", agentReport: "**问题**：Makaron 拉取素材超时导致失败。\n**原因**：Makaron 拉取素材超时导致失败。" } });
  assert.equal(described.cause, "");
});

// DL-0928-07 item 1 stopped before #86 kept the Agent's report: its request
// opened with the engine's words while the Agent had written exactly why.
test("a stop recorded without the Agent's words gets them from the Session, and the request is rewritten", async () => {
  const { card, observe, runtime, store, workboard } = await fixture();
  const failure = {
    kind: "contract_error",
    rawError: "External side effect has no succeeded Night Shift operation checkpoint",
    validationPhase: "side_effect",
    retryable: false,
    automaticRetry: false,
  };
  const stopped = card("old-stop", "video-1", { sessionKey: "agent:main:subagent:old-stop" });
  const opened = observe(stopped, { failure });
  // Nothing on the ledger for a paid stage: nothing was submitted.
  assert.match(opened.problem, /付费生成没有提交/);
  store.upsertContentItemRun({ instanceId: "NS-NY", contentItemId: "video-1", stageId: "produce", attempt: 1, cardId: "old-stop", status: "blocked", summary: "blocked", failure });
  workboard.sessions = new Map([["agent:main:subagent:old-stop", { messages: [
    { role: "user", content: "brief" },
    { role: "assistant", content: [{ type: "text", text: LABELED_REPORT }], stopReason: "stop" },
  ] }]]);
  await runtime.reconcile("NS-NY");
  const rewritten = store.getDecisionRequest(opened.id);
  assert.match(rewritten.problem, /^Makaron 两次都没能在规定时间内下载到素材/);
  assert.match(rewritten.cause, /只有 1 段视频素材/);
  assert.match(rewritten.suggestion, /^先确认能否补视频素材/);
  assert.equal(rewritten.announcedAt, opened.announcedAt, "rewriting the text leaves the notice state alone");
  await runtime.reconcile("NS-NY");
  assert.equal(workboard.sessionReads, 1, "the Session is read once per attempt");
});

// GeeLark 圣山-US-009 on V: the Agent published and said so; the engine refused
// the artifact path. The card must say what the engine saw, then what the Agent said.
test("an unlabeled closing message never replaces what the engine saw", () => {
  const described = describeStop({ failure: {
    kind: "contract_error",
    rawError: "Completion validation failed: Artifact path must stay inside the instance directory",
    agentReport: "Card 58dbc363 completed — ✅ PUBLISHED (terminal, recorded=true).",
  } });
  assert.match(described.problem, /项目目录之外/);
  assert.match(described.cause, /^agent 的说法：Card 58dbc363 completed — ✅ PUBLISHED/);
  assert.match(described.suggestion, /重新执行/);
  const makaron = describeStop({ failure: {
    kind: "contract_error",
    rawError: "External side effect has no succeeded Night Shift operation checkpoint",
    agentReport: "卡已 block（无成片）。结论：produce 阶段拿不到视频，两次提交均失败。建议人工决定是否更换素材传输方式。",
  } });
  assert.match(makaron.problem, /外部操作.*没有成功记录/);
  assert.match(makaron.cause, /agent 的说法：/);
  assert.match(makaron.suggestion, /建议人工决定是否更换素材/);
});

test("open requests written under older rules are rewritten under the current ones", async () => {
  const { card, observe, store } = await fixture();
  const stopped = card("stale", "video-1");
  const failure = {
    kind: "contract_error",
    rawError: "Completion validation failed: Artifact path must stay inside the instance directory",
    agentReport: "Card 58dbc363 completed — ✅ PUBLISHED (terminal, recorded=true).",
  };
  const opened = observe(stopped, { failure });
  // Simulate the text an earlier rule set wrote.
  store.updateDecisionRequestText(opened.id, { problem: "Card 58dbc363 completed — ✅ PUBLISHED", evidence: { failure, describeVersion: 1 } });
  const rewritten = observe(stopped, { failure });
  assert.match(rewritten.problem, /项目目录之外/);
  assert.equal(rewritten.evidence.describeVersion, DESCRIBE_VERSION);
  store.close();
});

// DL-1008-04 and GeeLark timed publishing on V, 2026-10-08: the cards named a
// rule ("交接记录", "外部操作没有成功记录"), quoted an English first sentence as
// the cause, and suggested 「重新执行」 for stops where retrying cannot make a
// new attempt: the paid operation's key is the same for the same card, so a
// reserved one blocks again, a failed one stays failed and a succeeded one is
// reused. The engine knows the ledger state; the card says it.
const STOPS = JSON.parse(await readFile(resolve(here, "fixtures/needs-you-stops-20261008.json"), "utf8"));
const PAID_STAGE = { id: "produce", scope: "content-item", actor: "agent", sideEffects: ["paid-production"] };
const PUBLISH_STAGE = { id: "publish", scope: "content-item", actor: "agent", sideEffects: ["external-publication"] };
function stopOf(contentItemId, operationExtra = {}) {
  const stop = STOPS.find((entry) => entry.contentItemId === contentItemId);
  const stage = stop.stageId === "publish" ? PUBLISH_STAGE : PAID_STAGE;
  const operation = stop.operation ? { ...stop.operation, ...operationExtra } : null;
  const described = describeStop({ failure: stop.failure, operation, stage });
  return { ...described, options: stopOptionsFor("item", { stage, operation }).map((option) => option.id), stop };
}

test("a paid result that did not pass its checks says it was paid for, and offers a new generation", () => {
  const card = stopOf("wsfood-es-22");
  assert.match(card.problem, /付费生成已经成功.*没有通过这一步的验收/);
  assert.doesNotMatch(card.problem, /交接记录/);
  assert.match(card.cause, /black frames/, "the Agent's 'Why blocked' section, not its first sentence");
  assert.doesNotMatch(card.cause, /^agent 的说法：Done/);
  assert.match(card.impact, /5d2328da-ccd0-47c4-876c-0529513ec52b.*已经成功.*钱已经花了/);
  assert.match(card.suggestion, /「重新执行」只会沿用这次的结果/);
  assert.match(card.suggestion, /「重做这一条」.*再付一次钱/);
  assert.deepEqual(card.options, ["retry", "redo", "skip", "pause"]);
});

test("a reservation never submitted says nothing was charged and never suggests the retry that loops", () => {
  const card = stopOf("wsfood-es-28");
  assert.match(card.problem, /付费生成登记了，但没有提交出去/);
  assert.match(card.impact, /没有外部任务号.*没有扣费记录/);
  assert.doesNotMatch(card.suggestion, /没成就「重新执行」/);
  assert.match(card.suggestion, /「重新执行」会再停在同一个登记上/);
  assert.match(card.suggestion, /「重做这一条」/);
  assert.deepEqual(card.options, ["redo", "skip", "pause"], "retry would block again on the same reservation");
});

test("a failed paid generation says it failed, with the provider's reason, and that it may have been charged", () => {
  const card = stopOf("wsfood-es-29", { result: { status: "failed", reason: "480p generation failed" } });
  assert.match(card.problem, /付费生成失败了（外部任务 video-pipeline-7e5d5cf6-bdaa-44ef-8994-f2d335ac54c5）：480p generation failed/);
  assert.match(card.cause, /视频渲染失败/, "the sentence that says what failed, not 已按规则执行并结束本卡");
  assert.match(card.impact, /可能已经扣费，以外部平台为准/);
  assert.match(card.suggestion, /「重新执行」不会重新生成/);
  assert.deepEqual(card.options, ["redo", "skip", "pause"]);
});

test("a publication that failed offers to publish again; a broken proxy that submitted nothing offers a plain retry", () => {
  const failed = stopOf("recvvWKAc37Cpf");
  assert.match(failed.problem, /发布失败了（外部任务 638962277126532250）/);
  assert.deepEqual(failed.options, ["redo", "skip", "pause"]);
  const proxy = stopOf("recvvWKAc3HnDK");
  assert.doesNotMatch(proxy.problem, /无法确认它是否真的完成了/, "nothing was registered, so nothing is in doubt");
  assert.match(proxy.problem, /发布没有提交/);
  assert.match(proxy.cause, /代理不可用/);
  assert.match(proxy.impact, /没有登记过发布：没有提交，也没有扣费/);
  assert.match(proxy.suggestion, /「重新执行」/);
  assert.deepEqual(proxy.options, ["retry", "skip", "pause"]);
});

test("a publication that succeeded is never offered as a redo: that would post twice", () => {
  const options = stopOptionsFor("item", { stage: PUBLISH_STAGE, operation: { status: "succeeded", externalTaskId: "639243610537094298" } });
  assert.deepEqual(options.map((option) => option.id), ["retry", "skip", "pause"]);
  assert.match(options[0].description, /沿用已经成功的结果.*不会再/);
  // GeeLark 圣山-US-009: published, then the engine refused the artifact path.
  // The refusal is the news; a table row reading "失败原因=null" is not a cause.
  const card = describeStop({
    failure: {
      kind: "contract_error",
      rawError: "Artifact path must stay inside the instance directory",
      agentReport: "Card 58dbc363 completed — ✅ PUBLISHED (terminal, recorded=true).\n\n| Step | Result |\n|---|---|\n| ⑩ Readback | 状态=已发布, 认领=null, 失败原因=null |\n\nNo failure → no alert (alertsSent=0).",
    },
    operation: { status: "succeeded", externalTaskId: "639243610537094298" },
    stage: PUBLISH_STAGE,
  });
  assert.match(card.problem, /^发布已经成功（外部任务 639243610537094298），但 agent 交付的文件放到了项目目录之外/);
  assert.match(card.cause, /^agent 的说法：Card 58dbc363 completed/);
  assert.match(card.suggestion, /「重新执行」只会沿用这次的结果，不会重新发布/);
});

test("the Agent's four lines lead, and a suggestion that would loop is corrected first", () => {
  const report = "问题：成片有 2.8 秒黑屏\n原因：Makaron 的时间线编辑插入了黑帧，修了两次被拒\n影响：这一条没有可交付的成片\n建议：重新执行\n\n## 详细\n…";
  const reserved = describeStop({
    failure: { kind: "contract_error", rawError: "External side effect has no succeeded Night Shift operation checkpoint", agentReport: report },
    operation: { status: "reserved", externalTaskId: null },
    stage: PAID_STAGE,
  });
  assert.equal(reserved.problem, "成片有 2.8 秒黑屏");
  assert.equal(reserved.cause, "Makaron 的时间线编辑插入了黑帧，修了两次被拒");
  assert.match(reserved.impact, /^台账上只有登记/);
  assert.match(reserved.impact, /这一条没有可交付的成片/);
  assert.match(reserved.suggestion, /^「重新执行」会再停在同一个登记上/);
  assert.match(reserved.suggestion, /agent 的建议：重新执行$/);
  const free = describeStop({ failure: { kind: "contract_error", rawError: "Stage handoff is required: produce", agentReport: report } });
  assert.equal(free.suggestion, "重新执行", "outside a paid ledger the Agent's own suggestion stands");
});

test("an open request is rewritten with the ledger's facts and the options they allow", async () => {
  const { card, observe, store } = await fixture();
  const stopped = card("es-29", "video-1");
  const failure = STOPS.find((entry) => entry.contentItemId === "wsfood-es-29").failure;
  const opened = observe(stopped, { failure });
  // Simulate what the previous rules wrote on V.
  store.updateDecisionRequestText(opened.id, { problem: "外部操作（付费生成、发布或上传）没有成功记录，无法确认它是否真的完成了", evidence: { failure, describeVersion: 2 } });
  const rewritten = observe(stopped, { failure, operation: { status: "failed", externalTaskId: "video-pipeline-7e5d", result: { reason: "480p generation failed" } } });
  assert.match(rewritten.problem, /付费生成失败了/);
  assert.deepEqual(rewritten.options.map((option) => option.id), ["redo", "skip", "pause"]);
  assert.equal(rewritten.evidence.describeVersion, DESCRIBE_VERSION);
  store.close();
});
