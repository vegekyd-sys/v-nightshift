import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkboardGatewayAdapter } from "../src/index.mjs";

test("creates and reuses native cards through Gateway RPC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nightshift-gateway-"));
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ gateway: { auth: { token: "test-token" } } }));
  const calls = [];
  let cards = [];
  const runner = async (_command, args, env) => {
    calls.push({ args, env });
    const method = args[2];
    const params = JSON.parse(args[args.indexOf("--params") + 1]);
    if (method === "workboard.cards.list") return JSON.stringify({ cards });
    if (method === "workboard.cards.create") {
      const card = { id: "card-1", ...params };
      cards = [card];
      return JSON.stringify({ card });
    }
    if (method === "sessions.get") {
      return JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "text", text: params.key }] }] });
    }
    if (method === "skills.status") {
      return JSON.stringify({ agentId: params.agentId, skills: [{ name: "night-shift-operator", eligible: true }] });
    }
    throw new Error(`unexpected ${method}`);
  };
  const adapter = new WorkboardGatewayAdapter({
    board: "nightshift-lab",
    configPath,
    gatewayUrl: "ws://127.0.0.1:23793",
    runner,
  });
  const action = {
    type: "create_workboard_card",
    instanceId: "NS-1",
    stageId: "plan",
    idempotencyKey: "stable-key",
    card: {
      title: "Plan",
      status: "todo",
      assignedAgent: "main",
      labels: ["instance:NS-1"],
      automation: { workflowId: "xingqing", maxAttempts: 2, maxRuntimeSeconds: 14_400 },
    },
  };
  const first = await adapter.applyAction(action);
  const second = await adapter.applyAction(action);
  assert.equal(first.status, "created");
  assert.equal(second.status, "reused");
  assert.equal(first.card.metadata.automation.boardId, "nightshift-lab");
  assert.match(first.card.metadata.automation.idempotencyKey, /^nightshift:[a-f0-9]{64}$/);
  assert.ok(first.card.metadata.automation.idempotencyKey.length <= 160);
  assert.equal(first.card.metadata.automation.nightshiftActionKey, undefined);
  assert.equal(first.card.maxRetries, 2);
  assert.equal(first.card.maxRuntimeSeconds, 14_400);
  assert.ok(calls.every(({ args }) => !args.includes("--token")));
  assert.ok(calls.every(({ args }) => !args.join(" ").includes("test-token")));
  assert.ok(calls.every(({ env }) => env.OPENCLAW_GATEWAY_TOKEN === "test-token"));
  assert.ok(calls.every(({ env }) => env.OPENCLAW_GATEWAY_URL === "ws://127.0.0.1:23793"));
  const session = await adapter.getSession("agent:main:subagent:workboard-card-1", { limit: 25 });
  assert.equal(session.messages[0].content[0].text, "agent:main:subagent:workboard-card-1");
  const sessionCall = calls.find(({ args }) => args[2] === "sessions.get");
  assert.deepEqual(JSON.parse(sessionCall.args[sessionCall.args.indexOf("--params") + 1]), {
    key: "agent:main:subagent:workboard-card-1",
    limit: 25,
  });
  const skills = await adapter.getSkillsStatus("main");
  assert.equal(skills.skills[0].name, "night-shift-operator");
  const skillsCall = calls.find(({ args }) => args[2] === "skills.status");
  assert.deepEqual(JSON.parse(skillsCall.args[skillsCall.args.indexOf("--params") + 1]), { agentId: "main" });

});

test("uses one persistent Gateway transport and forwards native Workboard changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nightshift-persistent-gateway-"));
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ gateway: { auth: { token: "test-token" } } }));
  const requests = [];
  let eventListener;
  let created = 0;
  const rpcClient = {
    connected: true,
    async close() {},
    async ensureConnected() {},
    onEvent(listener) { eventListener = listener; return () => {}; },
    async request(method, params) {
      requests.push({ method, params });
      return { cards: [] };
    },
  };
  const adapter = new WorkboardGatewayAdapter({
    board: "nightshift-lab",
    configPath,
    entry: "/opt/openclaw/dist/index.js",
    gatewayUrl: "ws://127.0.0.1:23793",
    rpcClientFactory: () => { created += 1; return rpcClient; },
  });
  const changes = [];
  adapter.onChange((change) => changes.push(change));

  await Promise.all([adapter.connect(), adapter.listCards(), adapter.listCards()]);
  eventListener({ event: "plugin.workboard.changed", payload: { revision: 7 } });

  assert.equal(created, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(changes, [{ revision: 7 }]);
  assert.equal(adapter.connected, true);
  await adapter.close();
});

test("creates cards with native board, parent dependency and suggested Skills", async () => {
  const calls = [];
  const adapter = new WorkboardGatewayAdapter();
  adapter.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "workboard.cards.list") return { cards: [] };
    return { card: { id: "child", ...params } };
  };

  await adapter.applyAction({
    type: "create_workboard_card",
    instanceId: "NS-1",
    stageId: "produce",
    idempotencyKey: "child-action",
    card: {
      title: "Produce",
      status: "ready",
      assignedAgent: "makaron",
      labels: ["instance:NS-1"],
      parents: ["parent-card"],
      automation: { skills: ["makaron", "ecommerce-video"] },
    },
  });

  const create = calls.find((entry) => entry.method === "workboard.cards.create");
  assert.equal(create.params.boardId, "nightshift");
  assert.deepEqual(create.params.parents, ["parent-card"]);
  assert.deepEqual(create.params.skills, ["makaron", "ecommerce-video"]);
});

test("dispatches only explicit card IDs through one scoped native Workboard dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nightshift-gateway-dispatch-"));
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ gateway: { auth: { token: "test-token" } } }));
  const calls = [];
  const adapter = new WorkboardGatewayAdapter({
    board: "nightshift-lab",
    configPath,
    gatewayUrl: "ws://127.0.0.1:23793",
    runner: async (_command, args) => {
      calls.push(args);
      return JSON.stringify({ started: [{ cardId: "card-1", sessionKey: "native-session", runId: "native-run" }], startFailures: [] });
    },
  });

  const dispatch = await adapter.dispatch(4, { cardIds: ["card-1", "card-1", "  "] });

  assert.deepEqual(dispatch.started.map((entry) => entry.cardId), ["card-1"]);
  assert.equal(calls[0][2], "workboard.cards.dispatchWithOptions");
  assert.deepEqual(JSON.parse(calls[0][calls[0].indexOf("--params") + 1]), {
    boardId: "nightshift-lab",
    cardIds: ["card-1"],
    maxStarts: 1,
  });
  const callCount = calls.length;
  await assert.rejects(
    () => adapter.dispatch(1),
    /requires an explicit non-empty card scope/,
  );
  assert.equal(calls.length, callCount);
});

test("reopens retry cards by releasing the stale claim in one native mutation", async () => {
  const calls = [];
  const adapter = new WorkboardGatewayAdapter();
  adapter.call = async (method, params) => {
    calls.push({ method, params });
    return { card: { id: params.id, status: params.status, metadata: {} } };
  };

  const card = await adapter.releaseCard("card-1", "ready");

  assert.equal(card.status, "ready");
  assert.deepEqual(calls, [{
    method: "workboard.cards.release",
    params: { id: "card-1", status: "ready" },
  }]);
});

test("resets a retried card's native failure budget through reassign", async () => {
  const calls = [];
  const adapter = new WorkboardGatewayAdapter();
  adapter.invoke = async (method, params) => {
    calls.push({ method, params });
    return { card: { id: params.id, status: "blocked", metadata: {} } };
  };

  const card = await adapter.resetCardFailures("card-1", "Night Shift retry by operator");

  assert.equal(card.id, "card-1");
  // No agentId or status: reassign keeps both and only zeroes failureCount.
  assert.deepEqual(calls, [{
    method: "workboard.cards.reassign",
    params: { id: "card-1", resetFailures: true, reason: "Night Shift retry by operator" },
  }]);

  adapter.invoke = async () => { throw new Error("gateway closed"); };
  adapter.needsFullSnapshot = false;
  await assert.rejects(() => adapter.resetCardFailures("card-1"), /gateway closed/);
  assert.equal(adapter.needsFullSnapshot, true, "a failed reassign is a mutation and must trigger recovery");
});

test("one scoped dispatch failure is not retried ambiguously", async () => {
  const adapter = new WorkboardGatewayAdapter({ startIntervalMs: 0 });
  const calls = [];
  adapter.call = async (method, params) => {
    calls.push({ method, params });
    throw new Error("reply lost");
  };
  await assert.rejects(() => adapter.dispatch(3, { cardIds: ["first", "second", "third", "fourth"] }), /reply lost/);
  assert.equal(calls.length, 1);
});

test("defers without sleeping after three starts in a fifteen-second window", async () => {
  let now = 1_000;
  const starts = [];
  const adapter = new WorkboardGatewayAdapter({
    now: () => now,
    startBurst: 3,
    startIntervalMs: 15_000,
  });
  adapter.call = async (_method, params) => {
    const selected = params.cardIds.slice(0, params.maxStarts);
    starts.push({ cardIds: selected, at: now });
    return { started: selected.map((id) => ({ cardId: id, sessionKey: `session:${id}`, runId: `run:${id}` })), startFailures: [] };
  };

  const firstProject = await adapter.dispatch(2, { cardIds: ["first", "second"] });
  const secondProject = await adapter.dispatch(3, { cardIds: ["third", "fourth", "fifth"] });
  const deferred = await adapter.dispatch(1, { cardIds: ["sixth"] });

  assert.equal(firstProject.started.length + secondProject.started.length, 3);
  assert.deepEqual(starts, [
    { cardIds: ["first", "second"], at: 1_000 },
    { cardIds: ["third"], at: 1_000 },
  ]);
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.retryAfterMs, 15_000);
  now += 15_000;
  const resumed = await adapter.dispatch(2, { cardIds: ["fourth", "fifth"] });
  assert.equal(resumed.started.length, 2);
});

test("measures admission latency without enumerating historical Sessions", async () => {
  let now = 1_000;
  const adapter = new WorkboardGatewayAdapter({ now: () => now });
  const calls = [];
  adapter.call = async (method, params) => {
    calls.push({ method, params });
    now += 75;
    return { maxActiveSessions: 45, pending: 0, workers: [{ activeCount: 2, queued: 0 }] };
  };
  assert.equal(await adapter.probeGatewayLatency(), 75);
  assert.deepEqual(calls, [{ method: "vlab.workers.status", params: {} }]);
});


test("9.1 JSON errors on stdout become actionable summaries without exposing the Gateway token", async () => {
  const { gatewayRpcFailureDetail } = await import("../src/workboard-gateway-adapter.mjs");
  assert.equal(gatewayRpcFailureDetail({ stdout: JSON.stringify({ ok: false, error: { message: 'unknown agent id "main"' } }), stderr: "" }), 'unknown agent id "main"');
  assert.equal(gatewayRpcFailureDetail({ stderr: "token secret-value rejected" }, "secret-value"), "token [redacted] rejected");
  assert.equal(gatewayRpcFailureDetail({ stdout: JSON.stringify({ ok: true, secret: "must not expose" }) }), "");
});


test("an ambiguous create reconciles the board before scoped planning resumes", async () => {
  const dir=await mkdtemp(join(tmpdir(), "nightshift-ambiguous-"));
  const configPath=join(dir,"config.json");await writeFile(configPath,JSON.stringify({gateway:{auth:{token:"fixture"}}}));
  const calls=[];
  const adapter=new WorkboardGatewayAdapter({configPath,entry:"/fixture/index.js",gatewayUrl:"ws://localhost:1",rpcClientFactory:()=>({
    onEvent(){return ()=>{};},
    async request(method,params){calls.push({method,params});if(method==='workboard.cards.create')throw Error('socket closed after commit');return {cards:[{id:'orphan-after-commit'}]};}
  })});
  await assert.rejects(adapter.call('workboard.cards.create',{}),/socket closed/);
  assert.deepEqual(await adapter.listCards({cardIds:[]}),[{id:'orphan-after-commit'}]);
  assert.equal(calls.at(-1).params.cardIds,undefined);
  await adapter.listCards({cardIds:['known']});
  assert.deepEqual(calls.at(-1).params.cardIds,['known']);
});


test("capacity probe includes foreground occupancy and fails closed on invalid telemetry", async () => {
  const adapter = new WorkboardGatewayAdapter();
  adapter.call = async method => {
    assert.equal(method, "vlab.workers.status", "capacity checks must not scan Session history");
    return { maxActiveSessions: 45, pending: 2, workers: [{ activeCount: 5, queued: 1 }, { activeCount: 3, queued: 0 }] };
  };
  assert.deepEqual((await adapter.probeGatewayCapacity()).workerPool, { capacity: 45, active: 8, queued: 3 });
  for (const bad of [null, {}, { maxActiveSessions: 45, pending: 0, workers: [{ activeCount: 2 }] }]) {
    adapter.call = async () => bad;
    await assert.rejects(adapter.probeGatewayCapacity());
  }
});

// On V at 03:00 on 2026-09-17 a cards.list timeout put the adapter into
// recovery, and the next read scanned all 2,386 cards on a Gateway that was
// already stalling. Recovery must widen to the projects the service can act
// on, not to the whole board.
test("recovery after a failed mutation re-reads visible projects, not the whole board", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nightshift-recovery-"));
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ gateway: { auth: { token: "test-token" } } }));
  const listParams = [];
  let failMove = true;
  const runner = async (_command, args) => {
    const method = args[2];
    const params = JSON.parse(args[args.indexOf("--params") + 1]);
    if (method === "workboard.cards.list") {
      listParams.push(params.cardIds ?? null);
      return JSON.stringify({ cards: [] });
    }
    if (method === "workboard.cards.move") {
      if (failMove) throw new Error("gateway request timeout for workboard.cards.move");
      return JSON.stringify({ card: { id: params.cardId } });
    }
    throw new Error(`unexpected ${method}`);
  };
  const options = { board: "nightshift-lab", configPath, gatewayUrl: "ws://127.0.0.1:23793", runner };

  const adapter = new WorkboardGatewayAdapter({ ...options, recoveryCardIds: () => ["visible-1", "visible-2"] });
  await adapter.listCards({ cardIds: ["scoped-1"] });
  assert.deepEqual(listParams.at(-1), ["scoped-1"], "an ordinary read stays scoped");
  await assert.rejects(adapter.moveCard("scoped-1", "blocked"), /timeout/);
  await adapter.listCards({ cardIds: ["scoped-1"] });
  assert.deepEqual(listParams.at(-1), ["scoped-1", "visible-1", "visible-2"], "recovery widens to visible projects");
  await adapter.listCards({ cardIds: ["scoped-1"] });
  assert.deepEqual(listParams.at(-1), ["scoped-1"], "recovery is consumed by one read");

  // Without a recovery scope the old whole-board behaviour is preserved.
  const bare = new WorkboardGatewayAdapter(options);
  await assert.rejects(bare.moveCard("scoped-1", "blocked"), /timeout/);
  await bare.listCards({ cardIds: ["scoped-1"] });
  assert.equal(listParams.at(-1), null, "no recovery scope still falls back to the whole board");
});
