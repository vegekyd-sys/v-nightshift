import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileWorkflow,
  loadWorkflow,
  NightShiftNotificationCoordinator,
  NightShiftStore,
  OpenClawFeishuNotificationSender,
} from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");
const GROUP = "oc_88d96b7e42cbdfd33e6d096477a8cac8";
const PERSON = "user:ou_cb133fd4414f0607e8b46a3195c7b9d8";

async function setup({ notifications = { instanceCompleted: { enabled: true } }, sendResults = [] } = {}) {
  const store = new NightShiftStore(":memory:");
  const release = compileWorkflow(await loadWorkflow(fixture));
  store.saveRelease(release, "workflow");
  const sha = release.metadata.workflowSha256;
  const sent = [];
  const sender = {
    async send(delivery) {
      sent.push(delivery);
      const result = sendResults.shift() ?? { messageId: `om_${sent.length}` };
      if (result instanceof Error) throw result;
      return result;
    },
  };
  let clock = Date.parse("2026-09-25T12:00:00Z");
  const coordinator = new NightShiftNotificationCoordinator({
    baseUrl: "https://nightshift.example", now: () => new Date(clock += 1_000), sender, store,
  });
  const releases = [{ workflowSha256: sha, manifest: { spec: { notifications } } }];
  const create = (id, collaboration) => store.createInstance({ id, name: `项目 ${id}`, workflowSha256: sha, collaboration });
  const pass = (cards = []) => coordinator.reconcile({ cards, instances: store.listInstances(), releases });
  return { create, pass, sent, store };
}

test("the first pass records a baseline and announces nothing, even for finished projects", async () => {
  const { create, pass, sent, store } = await setup();
  create("DONE-BEFORE", { sourceChatId: GROUP });
  store.updateInstanceStatus("DONE-BEFORE", "done");
  // V still carries the 2026-08-25 build's bootstrap marker; it must not count.
  store.setNotificationMetadata("feishu-notifications-v1.bootstrap", { completedAt: "2026-08-25T15:00:00Z" });

  const first = await pass();
  assert.equal(first.bootstrapped, true);
  assert.equal(sent.length, 0);
  assert.equal((await pass()).bootstrapped, false);
  assert.equal(sent.length, 0, "a project done before the upgrade is never announced");
});

test("a project that finishes is announced once to the chat it came from", async () => {
  const { create, pass, sent, store } = await setup();
  create("NS-1", { createdByOpenId: "ou_cb133fd4414f0607e8b46a3195c7b9d8", sourceChatId: PERSON });
  await pass();
  store.updateInstanceStatus("NS-1", "done");
  const cards = [
    { id: "c1", status: "done", labels: ["instance:NS-1"] },
    { id: "c2", status: "blocked", labels: ["instance:NS-1"] },
  ];
  const outcome = await pass(cards);
  assert.equal(outcome.delivered.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].targetChatId, PERSON);
  assert.equal(sent[0].kind, "instance-completed");
  assert.match(sent[0].presentation.title, /项目已完成 · 项目 NS-1/);
  assert.match(sent[0].presentation.blocks[0].text, /完成 1 项，阻塞 1 项/);
  assert.equal(sent[0].presentation.blocks[2].buttons[0].url, "https://nightshift.example/?project=NS-1&view=workflows");
  await pass(cards);
  assert.equal(sent.length, 1, "no second card for the same transition");
});

test("a schedule-created project uses the Workflow's target; the project's own chat wins", async () => {
  const { create, pass, sent, store } = await setup({ notifications: { instanceCompleted: { enabled: true, to: GROUP } } });
  create("GEE-DAILY");
  create("ASKED-BY-SOMEONE", { sourceChatId: PERSON });
  await pass();
  store.updateInstanceStatus("GEE-DAILY", "done");
  store.updateInstanceStatus("ASKED-BY-SOMEONE", "done");
  await pass();
  assert.deepEqual(sent.map((delivery) => [delivery.instanceId, delivery.targetChatId]).sort(), [
    ["ASKED-BY-SOMEONE", PERSON],
    ["GEE-DAILY", GROUP],
  ]);
});

test("nothing is sent without a target or when the Workflow has not asked for it", async () => {
  for (const notifications of [{ instanceCompleted: { enabled: true } }, { instanceCompleted: { enabled: false, to: GROUP } }, {}]) {
    const { create, pass, sent, store } = await setup({ notifications });
    create("NS-1");
    create("NS-2", notifications.instanceCompleted?.enabled === false ? { sourceChatId: PERSON } : undefined);
    await pass();
    store.updateInstanceStatus("NS-1", "done");
    store.updateInstanceStatus("NS-2", "done");
    await pass();
    assert.equal(sent.length, 0, JSON.stringify(notifications));
  }
});

test("a project given a target later is announced when it finishes", async () => {
  const { create, pass, sent, store } = await setup();
  create("RUNNING");
  await pass();
  store.updateInstanceCollaboration("RUNNING", { sourceChatId: GROUP });
  await pass();
  assert.equal(sent.length, 0, "adding a target to a running project sends nothing");
  store.updateInstanceStatus("RUNNING", "done");
  await pass();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].targetChatId, GROUP);
});

test("a failed send is retried on later passes and recorded as delivered once it goes out", async () => {
  const { create, pass, sent, store } = await setup({ sendResults: [new Error("Feishu 502"), { messageId: "om_ok" }] });
  create("NS-1", { sourceChatId: GROUP });
  await pass();
  store.updateInstanceStatus("NS-1", "done");
  const first = await pass();
  assert.equal(first.delivered[0].ok, false);
  const second = await pass();
  assert.equal(second.delivered[0].ok, true);
  assert.equal(sent.length, 2);
  assert.equal(store.listPendingNotifications().length, 0);
  assert.ok(store.listEvents("NS-1").some((event) => event.type === "notification.delivered"));
});

test("the sender hands the card to OpenClaw's Feishu channel", async () => {
  const calls = [];
  const sender = new OpenClawFeishuNotificationSender({
    command: "node",
    entry: "/opt/openclaw/dist/index.js",
    runner: async (command, args) => { calls.push({ command, args }); return JSON.stringify({ messageId: "om_1" }); },
  });
  const result = await sender.send({ targetChatId: GROUP, fallbackText: "项目已完成", presentation: { title: "t" } });
  assert.equal(result.messageId, "om_1");
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 7), ["/opt/openclaw/dist/index.js", "message", "send", "--channel", "feishu", "--target", GROUP]);
  assert.equal(args[args.indexOf("--presentation") + 1], JSON.stringify({ title: "t" }));
});

test("the completion notice names the items a person skipped, and why", async () => {
  const { completionPresentation } = await import("../src/notifications.mjs");
  const presentation = completionPresentation({
    instance: { id: "DL-0929-10", name: "圣山染整 葡萄牙语 30条" },
    projectUrl: "https://example.com/p",
    summary: { done: 58, blocked: 0 },
    skipped: [{ id: "sshr-21", title: "Fumaça atravessando a malha", reason: "素材库没有烟雾测试画面" }],
  });
  const text = presentation.blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.match(text, /跳过 1 条（有人决定不交付）\*\*\n· Fumaça atravessando a malha：素材库没有烟雾测试画面/);
});
