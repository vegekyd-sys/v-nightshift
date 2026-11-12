// Pre-merge candidate for Night Shift's own Agent model (agent-model.mjs).
//
// Runs a private Gateway from the candidate runtime with VLab's configuration
// and this branch's Night Shift engine, then:
//   1. control: a card dispatched with no Night Shift model runs on the
//      Gateway's default model;
//   2. the scheduler path: with Night Shift's model set, runtime.tick plans a
//      real plan card and dispatches it; the card's run must be on that model
//      (the board's attempt record and the session transcript);
//   3. a later turn of the same session that names no model (as a wake-up,
//      retry or restart recovery does) still runs on Night Shift's model;
//   4. a retry (release to ready, dispatch again) runs on it again;
//   5. the Gateway configuration file is untouched: pinning a session did not
//      move the default model.
// The cards are told to answer one word and use no tools, so nothing is
// produced and nothing is published.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDir = process.env.VLAB_CANDIDATE_RUNTIME;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(runtimeDir && configPath && stateDir, "candidate runtime environment is required");
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const dist = path.join(runtimeDir, "openclaw", "dist");
const SECRETS = "/srv/vlab-production-mirror/labs/instances/db91-parity/secrets.env";
const PINNED = process.env.NIGHTSHIFT_CANDIDATE_MODEL ?? "deepseek/deepseek-v4-flash";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const redact = (s) => String(s).replace(/(token|api.?key|authorization|secret|bearer)([=: ]+)[^\s"]+/giu, "$1$2[redacted]");
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const secret = (name) => {
  if (!fs.existsSync(SECRETS)) return undefined;
  for (const line of fs.readFileSync(SECRETS, "utf8").split(/\r?\n/u)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/u);
    if (m?.[1] === name) return m[2].replace(/^["']|["']$/gu, "");
  }
  return undefined;
};

const yamlDir = [path.join(runtimeDir, "openclaw", "node_modules", "yaml"), path.join(runtimeDir, "node_modules", "yaml")]
  .find((dir) => fs.existsSync(dir));
assert(yamlDir, "yaml package not found in the candidate runtime");
fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
if (!fs.existsSync(path.join(repo, "node_modules", "yaml"))) fs.symlinkSync(yamlDir, path.join(repo, "node_modules", "yaml"));

const { WorkboardGatewayAdapter } = await import(path.join(repo, "packages/nightshift-core/src/workboard-gateway-adapter.mjs"));
const { NightShiftStore } = await import(path.join(repo, "packages/nightshift-core/src/store.mjs"));
const { NightShiftRuntime } = await import(path.join(repo, "packages/nightshift-core/src/runtime.mjs"));
const { AGENT_MODEL_STATE_KEY, workboardSessionKeyForCard } = await import(path.join(repo, "packages/nightshift-core/src/agent-model.mjs"));

// ---- private config: VLab's, minus channels, cron and the absent Codex plugin ----
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const port = Number(config.gateway?.port);
assert(Number.isInteger(port) && port > 0, "candidate Gateway port is missing");
config.channels = {};
config.cron = { ...(config.cron ?? {}), enabled: false };
if (config.plugins?.entries?.codex) delete config.plugins.entries.codex;
if (Array.isArray(config.plugins?.allow)) config.plugins.allow = config.plugins.allow.filter((entry) => entry !== "codex");
for (const agent of [config.agents?.defaults, ...Object.values(config.agents?.entries ?? {})]) {
  for (const model of Object.values(agent?.models ?? {})) if (model?.agentRuntime?.id === "codex") delete model.agentRuntime;
}
if (config.agents?.entries?.["v-codex"]) delete config.agents.entries["v-codex"];
for (const agent of Object.values(config.agents?.entries ?? {})) {
  if (Array.isArray(agent?.subagents?.allowAgents)) agent.subagents.allowAgents = agent.subagents.allowAgents.filter((id) => id !== "v-codex");
}
if (Array.isArray(config.tools?.agentToAgent?.allow)) config.tools.agentToAgent.allow = config.tools.agentToAgent.allow.filter((id) => id !== "v-codex");
if (Array.isArray(config.bindings)) config.bindings = config.bindings.filter((binding) => binding?.agentId !== "v-codex");
const workerPlugin = config.plugins?.entries?.["vlab-agent-worker-isolation"]?.config;
if (workerPlugin) {
  Object.assign(workerPlugin, { minWorkers: 1, maxWorkers: 2, warmSpareWorkers: 0 });
  const workerRel = path.relative(stateDir, workerPlugin.workerConfigPath);
  assert(!workerRel.startsWith(".."), "candidate Worker config escaped state");
  const workerConfig = fs
    .readFileSync(path.join(process.env.VLAB_SHARED_STATE_DIR, workerRel), "utf8")
    .replaceAll(process.env.VLAB_SHARED_STATE_DIR, stateDir)
    .replaceAll("/srv/vlab-production-mirror/labs/instances/db91-parity/runtime", runtimeDir);
  fs.mkdirSync(path.dirname(workerPlugin.workerConfigPath), { recursive: true });
  fs.writeFileSync(workerPlugin.workerConfigPath, workerConfig, { mode: 0o600 });
  workerPlugin.gatewayConfigPath = configPath;
}
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
// Night Shift's projects bind their operator role to makaron on V (608 of 896
// projects on 2026-11-12, the rest unbound or also makaron).
const AGENT = "makaron";
const agentModelOf = (cfg) => {
  const own = cfg.agents?.entries?.[AGENT]?.model ?? cfg.agents?.defaults?.model ?? null;
  return own?.primary ?? own;
};
const defaultModel = agentModelOf(config);

const scratch = process.env.VLAB_CANDIDATE_DATA ?? stateDir;
for (const dir of ["tmp", "cache", "nightshift"]) fs.mkdirSync(path.join(scratch, dir), { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  OPENCLAW_GATEWAY_PORT: String(port),
  TMPDIR: path.join(scratch, "tmp"),
  XDG_CACHE_HOME: path.join(scratch, "cache"),
  npm_config_cache: path.join(scratch, "cache", "npm"),
};
for (const name of ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
  const value = secret(name);
  if (value) env[name] = value;
}

const lines = [];
const gateway = spawn(process.execPath, ["--max-old-space-size=4096", `${dist}/index.js`, "gateway", "--port", String(port)], {
  env, stdio: ["ignore", "pipe", "pipe"],
});
for (const s of [gateway.stdout, gateway.stderr]) {
  s.setEncoding("utf8");
  s.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/u).filter(Boolean)) lines.push(line);
    if (lines.length > 20_000) lines.splice(0, lines.length - 20_000);
  });
}

const store = new NightShiftStore(path.join(scratch, "nightshift", "nightshift.sqlite"));
const board = "nightshift-model-candidate";
const workboard = new WorkboardGatewayAdapter({
  board, configPath, entry: `${dist}/index.js`, gatewayUrl: `ws://127.0.0.1:${port}`, env,
});
const runtime = new NightShiftRuntime({ board, store, workboard, needsYou: null });

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const ONE_WORD = "Automated model test. Do not call any tool. Reply with the single word: ok. Do not complete or block this card.";

// The model the run used, from every place that records it.
async function runEvidence(cardId, sessionKey, runId) {
  const outcome = await waitFor(async () => {
    const result = await workboard.getRunOutcome({ sessionKey, runId }).catch(() => null);
    return result && result.status !== "running" && result.status !== "queued" ? result : null;
  }, 600_000, `run ${runId} to end`);
  const [card] = await workboard.listCards({ cardIds: [cardId] });
  const session = await workboard.getSession(sessionKey, { limit: 50 });
  const assistant = (session.messages ?? []).filter((message) => message.role === "assistant");
  const last = assistant.at(-1) ?? {};
  return {
    run: { status: outcome.status, error: outcome.error ? redact(outcome.error).slice(0, 300) : null },
    executionModel: card?.execution?.model ?? null,
    attemptModels: (card?.metadata?.attempts ?? []).map((attempt) => attempt.model ?? null),
    transcript: { provider: last.provider ?? null, model: last.model ?? null, assistantMessages: assistant.length },
    sessionKey,
  };
}

const result = { startedAt: new Date().toISOString(), pinnedModel: PINNED, gatewayDefaultModel: defaultModel,
  modelSelectionScope: config.agents?.defaults?.modelSelectionScope ?? null };
let configHashBefore = null;
try {
  assert.notEqual(PINNED, defaultModel, "the pinned model must differ from the Gateway default to prove anything");
  await waitFor(async () => {
    try {
      await workboard.connect();
      return workboard.connected;
    } catch {
      return false;
    }
  }, 900_000, "the Gateway");
  result.gatewayReadyMs = Date.now() - Date.parse(result.startedAt);
  configHashBefore = sha(configPath);

  // ---- 1. control: no Night Shift model ----
  const control = await workboard.call("workboard.cards.create", {
    boardId: board, title: "Model candidate｜control", status: "ready", agentId: AGENT,
    labels: ["nightshift-model-candidate:control"], maxRetries: 1, maxRuntimeSeconds: 900, notes: ONE_WORD,
    metadata: { automation: { boardId: board } },
  });
  const controlStart = await workboard.dispatch(1, { cardIds: [control.card.id] });
  assert.equal(controlStart.started.length, 1, `control did not start: ${JSON.stringify(controlStart).slice(0, 400)}`);
  result.control = await runEvidence(control.card.id, controlStart.started[0].sessionKey, controlStart.started[0].runId);

  // ---- 2. the scheduler path with Night Shift's model ----
  store.setServiceState(AGENT_MODEL_STATE_KEY, { model: PINNED, actor: "candidate" });
  const release = runtime.publish(fs.readFileSync(path.join(repo, "examples/workflows/xingqing-content-delivery.workflow.md"), "utf8"));
  const instanceId = "NS-MODEL-CANDIDATE";
  runtime.startInstance({ id: instanceId, workflowSha256: release.workflowSha256, agentBindings: { "content-operator": AGENT },
    inputs: { customerId: "candidate", briefUrl: "https://example.invalid/brief", authorizationScope: {} } });
  await runtime.tick(instanceId, { dispatch: false, inspectSessions: false });
  const [planCard] = await workboard.listCards({ cardIds: runtime.instanceCardIds(instanceId) });
  assert(planCard, "the scheduler planned no card");
  await workboard.updateCard(planCard.id, { notes: ONE_WORD });
  workboard.startWindowAt = null;
  const ticked = await runtime.tick(instanceId, { dispatch: true, inspectSessions: false });
  const started = ticked.dispatch?.started?.[0];
  assert(started, `the scheduler did not start the plan card: ${JSON.stringify(ticked.dispatch).slice(0, 400)}`);
  const [startedCard] = await workboard.listCards({ cardIds: [started.cardId] });
  result.nightshift = await runEvidence(started.cardId, started.sessionKey, started.runId);
  result.nightshift.computedSessionKeyMatches = workboardSessionKeyForCard(startedCard) === started.sessionKey;

  // ---- 3. a later turn that names no model ----
  const followRun = await workboard.call("agent", {
    message: "Automated model test, second turn. Do not call any tool. Reply with the single word: ok.",
    sessionKey: started.sessionKey, deliver: false, idempotencyKey: `nightshift-model-candidate-${Date.now()}`,
  });
  assert(followRun?.runId, `the follow-up turn did not start: ${JSON.stringify(followRun).slice(0, 300)}`);
  await workboard.call("agent.wait", { runId: followRun.runId, timeoutMs: 300_000 });
  const followSession = await workboard.getSession(started.sessionKey, { limit: 50 });
  const followAssistant = (followSession.messages ?? []).filter((message) => message.role === "assistant");
  result.followUp = {
    assistantMessages: followAssistant.length,
    provider: followAssistant.at(-1)?.provider ?? null,
    model: followAssistant.at(-1)?.model ?? null,
  };

  // ---- 4. a retry: the card goes back to ready and is dispatched again ----
  // The session is already pinned in this process, so no sessions.patch is
  // sent; the second attempt must still run on Night Shift's model.
  await workboard.resetCardFailures(started.cardId, "model candidate retry").catch(() => null);
  await workboard.releaseCard(started.cardId, "ready");
  workboard.startWindowAt = null;
  const [retryCard] = await workboard.listCards({ cardIds: [started.cardId] });
  const retried = await workboard.dispatch(1, { cardIds: [started.cardId], cards: [retryCard], model: PINNED });
  assert.equal(retried.started.length, 1, `the retry did not start: ${JSON.stringify(retried).slice(0, 400)}`);
  const retryEvidence = await runEvidence(started.cardId, retried.started[0].sessionKey, retried.started[0].runId);
  result.retry = { ...retryEvidence, sameSession: retried.started[0].sessionKey === started.sessionKey };

  // ---- 5. the Gateway's own default is untouched ----
  await sleep(3_000);
  const after = JSON.parse(fs.readFileSync(configPath, "utf8"));
  result.config = {
    fileUnchanged: sha(configPath) === configHashBefore,
    defaultModelAfter: agentModelOf(after),
  };

  const modelId = PINNED.split("/").slice(1).join("/");
  const onPinned = (evidence) => evidence.executionModel === PINNED && evidence.transcript.model === modelId;
  result.checks = {
    controlRanOnGatewayDefault: result.control.executionModel !== PINNED && result.control.transcript.model !== modelId,
    nightshiftCardRanOnItsModel: onPinned(result.nightshift) && result.nightshift.run.status !== "failed",
    sessionKeyFormulaMatchesBoard: result.nightshift.computedSessionKeyMatches,
    laterTurnKeepsItsModel: result.followUp.model === modelId && result.followUp.assistantMessages > result.nightshift.transcript.assistantMessages,
    retryKeepsItsModel: result.retry.attemptModels.length >= 2 && result.retry.attemptModels.every((model) => model === PINNED)
      && result.retry.transcript.model === modelId && result.retry.run.status !== "failed",
    gatewayDefaultUntouched: result.config.fileUnchanged && result.config.defaultModelAfter === defaultModel,
  };
  result.ok = Object.values(result.checks).every(Boolean);
} catch (error) {
  result.error = redact(error.stack ?? error.message);
  result.gatewayTail = redact(lines.slice(-40).join("\n"));
} finally {
  await workboard.close().catch(() => {});
  if (gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => { gateway.kill("SIGKILL"); resolve(); }, 60_000);
      gateway.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  store.close();
}
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
