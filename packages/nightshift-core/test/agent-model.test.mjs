import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NightShiftRuntime,
  NightShiftStore,
  normalizeAgentModel,
  resolveAgentModel,
  WorkboardGatewayAdapter,
  workboardSessionKeyForCard,
} from "../src/index.mjs";
import { AGENT_MODEL_STATE_KEY } from "../src/agent-model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");

async function gatewayAdapter({ modelSelectionScope = "session", patch } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nightshift-agent-model-"));
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, JSON.stringify({
    gateway: { auth: { token: "test-token" } },
    agents: { defaults: { model: { primary: "deepseek/vds-deepseek-flash" }, ...(modelSelectionScope ? { modelSelectionScope } : {}) } },
  }));
  const calls = [];
  const adapter = new WorkboardGatewayAdapter({
    board: "nightshift",
    configPath,
    gatewayUrl: "ws://127.0.0.1:23793",
    runner: async (_command, args) => {
      const method = args[2];
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      calls.push({ method, params });
      if (method === "sessions.patch") {
        if (patch) patch(params);
        return JSON.stringify({ ok: true, key: params.key });
      }
      if (method === "workboard.cards.dispatchWithOptions") {
        return JSON.stringify({
          started: params.cardIds.slice(0, params.maxStarts).map((cardId) => ({ cardId, sessionKey: `agent:main:subagent:workboard-nightshift-${cardId}`, runId: `run-${cardId}` })),
          startFailures: [],
        });
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  return { adapter, calls, configPath };
}

const card = (id, extra = {}) => ({
  id,
  agentId: "main",
  status: "ready",
  priority: "normal",
  position: 0,
  createdAt: 1,
  metadata: { automation: { boardId: "nightshift" } },
  ...extra,
});

test("the session key is the one the Workboard starts the card on", () => {
  // extensions/workboard/src/session-link.ts on the 9.1 Gateway V runs.
  assert.equal(workboardSessionKeyForCard(card("8b1f0c3e-6d2a-4c11-9f3e-1a2b3c4d5e6f")),
    "agent:main:subagent:workboard-nightshift-8b1f0c3e-6d2a-4c11-9f3e-1a2b3c4d5e6f");
  assert.equal(workboardSessionKeyForCard({ id: "a b", metadata: {} }), "subagent:workboard-default-a-b");
  assert.equal(workboardSessionKeyForCard({ id: "c", agentId: "v.codex", metadata: { automation: { boardId: "night shift!" } } }),
    "agent:v-codex:subagent:workboard-night-shift-c");
});

test("a model reference is provider/model, and default clears it", () => {
  assert.equal(normalizeAgentModel(" deepseek/deepseek-v4-flash "), "deepseek/deepseek-v4-flash");
  assert.equal(normalizeAgentModel("openrouter/x-ai/grok-4.3"), "openrouter/x-ai/grok-4.3");
  assert.equal(normalizeAgentModel("default"), null);
  assert.equal(normalizeAgentModel(null), null);
  assert.throws(() => normalizeAgentModel("vds"), /provider\/model/);
  assert.throws(() => normalizeAgentModel("deepseek/ flash"), /provider\/model/);
  assert.throws(() => normalizeAgentModel(3), /provider\/model/);
});

test("without a model, dispatch sends exactly the request it always sent", async () => {
  const { adapter, calls } = await gatewayAdapter();
  const result = await adapter.dispatch(2, { cardIds: ["c1", "c2", "c3"] });
  assert.deepEqual(calls, [{
    method: "workboard.cards.dispatchWithOptions",
    params: { boardId: "nightshift", cardIds: ["c1", "c2", "c3"], maxStarts: 2 },
  }]);
  assert.deepEqual(result.started.map((entry) => entry.cardId), ["c1", "c2"]);
});

test("with a model, each card the board may start is pinned on its session before the dispatch", async () => {
  const { adapter, calls } = await gatewayAdapter();
  const cards = [
    card("late", { createdAt: 5 }),
    card("urgent", { priority: "urgent", createdAt: 9 }),
    card("early", { createdAt: 2 }),
    card("low", { priority: "low", createdAt: 1 }),
    card("fifth", { createdAt: 6 }),
  ];
  const result = await adapter.dispatch(2, { cardIds: cards.map((entry) => entry.id), cards, model: "deepseek/deepseek-v4-flash" });

  // The board tries at most twice its start budget, in its own order, so only
  // those four are pinned and the dispatch is narrowed to them.
  assert.deepEqual(calls.slice(0, 4), ["urgent", "early", "late", "fifth"].map((id) => ({
    method: "sessions.patch",
    params: { key: `agent:main:subagent:workboard-nightshift-${id}`, model: "deepseek/deepseek-v4-flash" },
  })));
  assert.deepEqual(calls[4], {
    method: "workboard.cards.dispatchWithOptions",
    params: { boardId: "nightshift", cardIds: ["urgent", "early", "late", "fifth"], maxStarts: 2 },
  });
  assert.equal(calls.length, 5);
  assert.deepEqual(result.startFailures, []);

  // A session already pinned to this model is not patched again; a new model is.
  calls.length = 0;
  adapter.startWindowAt = null;
  await adapter.dispatch(1, { cardIds: ["urgent"], cards, model: "deepseek/deepseek-v4-flash" });
  assert.deepEqual(calls.map((call) => call.method), ["workboard.cards.dispatchWithOptions"]);
  calls.length = 0;
  adapter.startWindowAt = null;
  await adapter.dispatch(1, { cardIds: ["urgent"], cards, model: "openai/gpt-6-luna" });
  assert.deepEqual(calls.map((call) => call.method), ["sessions.patch", "workboard.cards.dispatchWithOptions"]);
  assert.equal(calls[0].params.model, "openai/gpt-6-luna");
});

test("a card whose session refuses the model is not started on the default instead", async () => {
  const { adapter, calls } = await gatewayAdapter({
    patch: (params) => { if (params.key.endsWith("-bad")) throw new Error("model not allowed: nope/nope"); },
  });
  const cards = [card("bad", { createdAt: 1 }), card("good", { createdAt: 2 })];
  const result = await adapter.dispatch(2, { cardIds: ["bad", "good"], cards, model: "nope/nope" });
  assert.deepEqual(calls.at(-1).params.cardIds, ["good"]);
  assert.equal(result.startFailures.length, 1);
  assert.equal(result.startFailures[0].cardId, "bad");
  assert.match(result.startFailures[0].error, /Night Shift model nope\/nope could not be set.*model not allowed/);

  // Nothing pinned: no dispatch at all.
  calls.length = 0;
  adapter.startWindowAt = null;
  const none = await adapter.dispatch(1, { cardIds: ["bad"], cards, model: "nope/nope" });
  assert.deepEqual(calls.map((call) => call.method), ["sessions.patch"]);
  assert.deepEqual(none.started, []);
  assert.equal(none.startFailures[0].cardId, "bad");
});

test("refuses to pin where a session selection would also move the Gateway's default model", async () => {
  for (const scope of [null, "effective", "agent"]) {
    const { adapter, calls } = await gatewayAdapter({ modelSelectionScope: scope });
    await assert.rejects(
      () => adapter.dispatch(1, { cardIds: ["c1"], cards: [card("c1")], model: "deepseek/deepseek-v4-flash" }),
      /modelSelectionScope "session"/,
    );
    assert.deepEqual(calls, []);
  }
});

test("reads unknown cards before pinning when the caller passed none", async () => {
  const { adapter, calls } = await gatewayAdapter();
  adapter.listCards = async ({ cardIds }) => cardIds.map((id) => card(id));
  await adapter.dispatch(1, { cardIds: ["c1"], model: "deepseek/deepseek-v4-flash" });
  assert.deepEqual(calls.map((call) => call.method), ["sessions.patch", "workboard.cards.dispatchWithOptions"]);
});

test("a project's model wins over Night Shift's, and unset falls back to the Gateway default", async () => {
  const store = new NightShiftStore();
  const runtime = new NightShiftRuntime({ store, workboard: { cards: [] } });
  const release = runtime.publish(await readFile(workflowPath, "utf8"));
  runtime.startInstance({ id: "NS-MODEL", workflowSha256: release.workflowSha256, agentBindings: { "content-operator": "main" } });
  assert.deepEqual(resolveAgentModel(store, "NS-MODEL"), { effective: null, source: "gateway-default", project: null, nightshift: null });
  store.setServiceState(AGENT_MODEL_STATE_KEY, { model: "deepseek/deepseek-v4-flash" });
  assert.deepEqual(resolveAgentModel(store, "NS-MODEL"), { effective: "deepseek/deepseek-v4-flash", source: "nightshift", project: null, nightshift: "deepseek/deepseek-v4-flash" });
  store.setInstanceControl("NS-MODEL", { agentModel: "openai/gpt-6-luna" });
  // Other controls keep it.
  store.setInstanceControl("NS-MODEL", { perInstanceLimit: 3 });
  assert.deepEqual(resolveAgentModel(store, "NS-MODEL"), { effective: "openai/gpt-6-luna", source: "project", project: "openai/gpt-6-luna", nightshift: "deepseek/deepseek-v4-flash" });
  store.setInstanceControl("NS-MODEL", { agentModel: null });
  assert.equal(resolveAgentModel(store, "NS-MODEL").effective, "deepseek/deepseek-v4-flash");
  store.close();
});

async function dispatchedWith(setup) {
  const store = new NightShiftStore();
  const calls = [];
  const cards = [{ id: "card-ready", agentId: "main", labels: ["instance:NS-MODEL-RUN", "content-item:video-1", "stage:route"], status: "ready" }];
  const workboard = {
    cards,
    async listCards() { return cards; },
    async applyPlan() { return []; },
    async dispatch(maxStarts, options) { calls.push({ maxStarts, options }); return { started: [], startFailures: [] }; },
  };
  const runtime = new NightShiftRuntime({ store, workboard });
  const release = runtime.publish(await readFile(workflowPath, "utf8"));
  runtime.startInstance({
    id: "NS-MODEL-RUN",
    workflowSha256: release.workflowSha256,
    agentBindings: { "content-operator": "main" },
    contentItems: [{ id: "video-1", title: "Ready video", route: "SCENE_EDIT" }],
  });
  store.upsertStageRun({ instanceId: "NS-MODEL-RUN", stageId: "plan", status: "done" });
  setup(store);
  await runtime.tick("NS-MODEL-RUN", { dispatch: true });
  store.close();
  return calls;
}

test("the scheduler hands the project's model and its cards to the dispatch only when one is set", async () => {
  assert.deepEqual(await dispatchedWith(() => {}), [{ maxStarts: 1, options: { cardIds: ["card-ready"] } }]);
  const [withService] = await dispatchedWith((store) => store.setServiceState(AGENT_MODEL_STATE_KEY, { model: "deepseek/deepseek-v4-flash" }));
  assert.equal(withService.options.model, "deepseek/deepseek-v4-flash");
  assert.deepEqual(withService.options.cardIds, ["card-ready"]);
  assert.deepEqual(withService.options.cards.map((entry) => entry.id), ["card-ready"]);
  const [withProject] = await dispatchedWith((store) => {
    store.setServiceState(AGENT_MODEL_STATE_KEY, { model: "deepseek/deepseek-v4-flash" });
    store.setInstanceControl("NS-MODEL-RUN", { agentModel: "openai/gpt-6-luna" });
  });
  assert.equal(withProject.options.model, "openai/gpt-6-luna");
});
