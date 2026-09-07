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

test("dispatches only an explicit card scope through the options RPC", async () => {
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
      return JSON.stringify({ started: ["card-1"] });
    },
  });

  const dispatch = await adapter.dispatch(4, { cardIds: ["card-1", "card-1", "  "] });

  assert.deepEqual(dispatch.started, ["card-1"]);
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
