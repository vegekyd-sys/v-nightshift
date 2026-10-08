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
  readStopReport,
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
  // The two lines every brief asks a stopping Agent to open with.
  agentReport: "需要人做：请确认能不能补视频素材，能补就补进 Scene\n原因：Makaron 两次拉取素材超时（400）\n\n详细：…",
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
  assert.equal(request.problem, "请确认能不能补视频素材，能补就补进 Scene");
  assert.equal(request.cause, "Makaron 两次拉取素材超时（400）");
  // A stop on one content item may also skip it; pausing stops the whole project.
  assert.deepEqual(request.options.map((option) => option.label), ["处理好了，继续", "这条不做了", "暂停项目"]);
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
  assert.equal(request.problem, "这一条没做成：要再试一次，还是不做了？");
  assert.equal(request.cause, "Agent 停下了，没有给出原因");
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
  const result = await runtime.decide({ decisionId: request.id, optionId: "continue", note: "已补素材，换用 3 段新视频", actor: "Workboard operator" });
  assert.deepEqual(result.affectedCardIds, ["r1"]);
  assert.equal(result.alreadyDecided, false);
  assert.equal(result.request.status, "decided");
  assert.equal(workboard.cards[0].status, "ready");
  assert.match(workboard.cards[0].notes, /^## 人工决定\nWorkboard operator 的决定：处理好了，继续\n已补素材，换用 3 段新视频/);
  const again = await runtime.decide({ decisionId: request.id, optionId: "continue", actor: "Workboard operator" });
  assert.equal(again.alreadyDecided, true);
  assert.deepEqual(again.affectedCardIds, []);
  store.close();
});

test("a decision can apply to every card with the same root cause", async () => {
  const { card, observe, runtime, store, workboard } = await fixture();
  const first = observe(card("a", "video-1"), { failure: MAKARON_STOP });
  observe(card("b", "video-2"), { failure: MAKARON_STOP });
  const result = await runtime.decide({ decisionId: first.id, optionId: "continue", actor: "Workboard operator", applyToGroup: true });
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
  assert.equal(sent[0].presentation.title, "需要你处理 · 需要你测试");
  assert.match(blocks[0], /停下了：2 张卡，同一件事/);
  assert.ok(blocks.some((text) => text === "**需要你做**\n请确认能不能补视频素材，能补就补进 Scene"));
  assert.ok(blocks.some((text) => text === "**为什么**\nMakaron 两次拉取素材超时（400）"));
  assert.equal(blocks.some((text) => /\*\*(影响|建议怎么做)\*\*/.test(text)), false, "no system-side impact or advice");
  assert.ok(blocks.some((text) => /^\*\*做完后选\*\*/.test(text) && /\*\*处理好了，继续\*\*：接着做这一步，不会再付钱/.test(text) && /\*\*这条不做了\*\*：其余照常交付/.test(text) && /\*\*暂停项目\*\*：暂停整个项目/.test(text)));
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
  assert.equal(describeStop({}).problem, "这一步没做成：要再试一次，还是暂停项目？");
  assert.equal(describeStop({}).cause, "Agent 停下了，没有给出原因");
  assert.match(describeStop({ failure: { kind: "worker_unavailable", rawError: "Worker unavailable" } }).cause, /执行 Worker 未响应/);
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

// The two lines a stopping Agent writes first: what a person must do, and why.
test("the Agent's two lines become what the person must do and why", () => {
  const described = describeStop({ failure: { kind: "contract_error", agentReport: "需要人做：请去代理后台更新巴西两台手机的代理账号\n原因：巴西代理的账号密码被拒，发布没有提交\n\n## 细节\n…" } });
  assert.equal(described.problem, "请去代理后台更新巴西两台手机的代理账号");
  assert.equal(described.cause, "巴西代理的账号密码被拒，发布没有提交");
  assert.equal(described.asked, true);
  assert.equal(described.impact, "");
  assert.equal(described.suggestion, "");
});

test("无 means no person is needed; a missing line means the Agent did not say", () => {
  assert.deepEqual(readStopReport("需要人做：无\n原因：模型超时"), { action: "", cause: "模型超时", problem: "" });
  assert.equal(readStopReport("**需要人做**：无。").action, "");
  assert.equal(readStopReport("Done — blocked.").action, null);
  const described = describeStop({ failure: { kind: "contract_error", agentReport: "需要人做：无\n原因：模型超时" }, stage: { scope: "content-item" } });
  assert.equal(described.problem, "这一条没做成：要再试一次，还是不做了？");
  assert.equal(described.asked, false);
});

test("a report from before the two lines still yields its cause", () => {
  const legacy = "卡已 block（无成片）。\n**问题**：Makaron 两次都没能下载到素材。\n**原因**：项目在 Scene 里只有 1 段视频素材。\n**建议**：先确认能否补视频素材。";
  assert.equal(describeStop({ failure: { kind: "contract_error", agentReport: legacy } }).cause, "项目在 Scene 里只有 1 段视频素材。");
  const unlabeled = describeStop({ failure: { kind: "worker_unavailable", agentReport: "拿不到视频。失败点在 Makaron 侧对素材 URL 的抓取超时。" } });
  assert.match(unlabeled.cause, /失败点在 Makaron/);
  // A table row reading 失败原因=null is evidence, not a cause.
  const table = describeStop({ failure: { kind: "contract_error", agentReport: "Card completed — ✅ PUBLISHED.\n\n| ⑩ Readback | 状态=已发布, 失败原因=null |" } });
  assert.match(table.cause, /^Card completed/);
});

test("the engine's own checks give a plain cause when the Agent said nothing", () => {
  const cause = (rawError) => describeStop({ failure: { kind: "contract_error", rawError } }).cause;
  assert.equal(cause("Completion validation failed: External side effect has no succeeded Night Shift operation checkpoint"), "付费或外部操作没有成功的记录");
  assert.equal(cause("Artifact path must stay inside the instance directory"), "交付的文件放在了项目目录之外");
  assert.match(cause("Something new broke"), /^引擎的检查没通过：Something new broke/);
  const failed = describeStop({ failure: { kind: "contract_error", rawError: "x" }, stage: PAID_STAGE, operation: { status: "failed", externalTaskId: "t", result: { reason: "480p generation failed" } } });
  assert.equal(failed.cause, "外部平台返回失败：480p generation failed");
});

test("a cause that only repeats what to do is left out", () => {
  assert.equal(describeStop({ failure: { kind: "worker_unavailable", agentReport: "需要人做：请充值。\n原因：请充值。" } }).cause, "");
});

test("the card renders in the accepted layout", async () => {
  const { needsYouPresentation, needsYouGroups } = await import("../src/index.mjs");
  const described = describeStop({ failure: { kind: "contract_error", agentReport: "需要人做：请给 seedance 视频服务充值\n原因：额度不足，两次提交都被拒" }, stage: PAID_STAGE });
  const request = { id: "d1", kind: "decision", stageId: "produce", groupKey: "g", options: stopOptionsFor("item", { stage: PAID_STAGE, operation: { status: "failed", externalTaskId: "t" }, asked: true }), ...described };
  const groups = needsYouGroups({ items: [request, { ...request, id: "d2" }], stages: [{ id: "produce", title: "出片" }] });
  const card = needsYouPresentation({
    instance: { id: "DL-0929-02", name: "天元昌 韩语 20条" },
    groups,
    projectUrl: "https://nightshift.example/?project=DL-0929-02",
    now: new Date("2026-09-29T13:07:00Z"),
  });
  assert.equal(card.title, "需要你处理 · 天元昌 韩语 20条");
  assert.deepEqual(card.blocks.map((block) => block.text ?? block.type), [
    "**出片停下了：2 张卡，同一件事**",
    "**需要你做**\n请给 seedance 视频服务充值",
    "**为什么**\n额度不足，两次提交都被拒",
    "**做完后选**\n· **处理好了，继续**：重新做这一步，会再付一次钱；可以附一句话给 agent\n· **这条不做了**：其余照常交付；完成通知会写明这条没做、为什么\n· **暂停项目**：暂停整个项目：不再派任何新任务，问题解决后再恢复",
    "项目 DL-0929-02 · 21:07 · 同一原因的卡会合并在这一条里",
    "buttons",
  ]);
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
  assert.equal(opened.problem, "这一条没做成：要再试一次，还是不做了？");
  store.upsertContentItemRun({ instanceId: "NS-NY", contentItemId: "video-1", stageId: "produce", attempt: 1, cardId: "old-stop", status: "blocked", summary: "blocked", failure });
  workboard.sessions = new Map([["agent:main:subagent:old-stop", { messages: [
    { role: "user", content: "brief" },
    { role: "assistant", content: [{ type: "text", text: MAKARON_STOP.agentReport }], stopReason: "stop" },
  ] }]]);
  await runtime.reconcile("NS-NY");
  const rewritten = store.getDecisionRequest(opened.id);
  assert.equal(rewritten.problem, "请确认能不能补视频素材，能补就补进 Scene");
  assert.equal(rewritten.options[0].label, "处理好了，继续");
  assert.equal(rewritten.announcedAt, opened.announcedAt, "rewriting the text leaves the notice state alone");
  await runtime.reconcile("NS-NY");
  assert.equal(workboard.sessionReads, 1, "the Session is read once per attempt");
});

test("open requests written under older rules are rewritten under the current ones, options included", async () => {
  const { card, observe, store } = await fixture();
  const stopped = card("stale", "video-1");
  const failure = STOPS.find((entry) => entry.contentItemId === "wsfood-es-29").failure;
  const opened = observe(stopped, { failure });
  // What the previous rules wrote on V.
  store.updateDecisionRequestText(opened.id, {
    problem: "外部操作（付费生成、发布或上传）没有成功记录，无法确认它是否真的完成了",
    options: [{ id: "retry", label: "重新执行", effect: "retry" }],
    evidence: { failure, describeVersion: 2 },
  });
  const rewritten = observe(stopped, { failure, operation: { status: "failed", externalTaskId: "video-pipeline-7e5d", result: { reason: "480p generation failed" } } });
  assert.equal(rewritten.problem, "这一条没做成：要再试一次，还是不做了？");
  assert.match(rewritten.cause, /视频渲染失败/);
  assert.deepEqual(rewritten.options.map((option) => option.id), ["continue", "skip", "pause"]);
  assert.match(rewritten.options[0].description, /会再付一次钱/);
  assert.equal(rewritten.evidence.describeVersion, DESCRIBE_VERSION);
  store.close();
});

// The stops open on V on 2026-10-08 (DL-1008-04 and GeeLark timed publishing),
// written before the two lines existed. Their cards ask whether to go on, say
// why in one sentence, and price the answer.
const STOPS = JSON.parse(await readFile(resolve(here, "fixtures/needs-you-stops-20261008.json"), "utf8"));
const PAID_STAGE = { id: "produce", scope: "content-item", actor: "agent", sideEffects: ["paid-production"] };
const PUBLISH_STAGE = { id: "publish", scope: "content-item", actor: "agent", sideEffects: ["external-publication"] };
function stopOf(contentItemId, operationExtra = {}) {
  const stop = STOPS.find((entry) => entry.contentItemId === contentItemId);
  const stage = stop.stageId === "publish" ? PUBLISH_STAGE : PAID_STAGE;
  const operation = stop.operation ? { ...stop.operation, ...operationExtra } : null;
  const described = describeStop({ failure: stop.failure, operation, stage });
  return { ...described, options: stopOptionsFor("item", { stage, operation, asked: described.asked }) };
}
const labels = (card) => card.options.map((option) => option.label);

test("tonight's stops: one question, one sentence of why, and what each answer costs", () => {
  const es22 = stopOf("wsfood-es-22");
  assert.equal(es22.problem, "这一条没做成：要再试一次，还是不做了？");
  assert.match(es22.cause, /black frames/, "the Agent's 'Why blocked' section, not 'Done — the card is blocked'");
  assert.deepEqual(labels(es22), ["用这次的结果", "重新生成", "这条不做了", "暂停项目"]);
  assert.match(es22.options[1].description, /会再付一次钱/);

  const es28 = stopOf("wsfood-es-28");
  assert.match(es28.cause, /model-provider error/);
  assert.deepEqual(labels(es28), ["再试一次", "这条不做了", "暂停项目"]);
  assert.match(es28.options[0].description, /会再付一次钱/);

  const es29 = stopOf("wsfood-es-29");
  assert.match(es29.cause, /视频渲染失败/, "not 已按规则执行并结束本卡");

  const proxy = stopOf("recvvWKAc3HnDK");
  assert.match(proxy.cause, /代理不可用/);
  assert.match(proxy.options[0].description, /不会再付钱/);
});

test("a published post is never offered again: going on reuses it", () => {
  const options = stopOptionsFor("item", { stage: PUBLISH_STAGE, operation: { status: "succeeded", externalTaskId: "639243610537094298" } });
  assert.deepEqual(options.map((option) => option.effect), ["continue", "skip", "pause"]);
  assert.match(options[0].description, /不会再付钱/);
});
