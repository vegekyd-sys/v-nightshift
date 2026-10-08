// Pre-merge candidate for 重做这一条 and the four-line stop report (2026-10-08).
//
// Runs a private Gateway from the candidate runtime and drives this branch's
// Night Shift runtime against its real Workboard:
//   1. a paid produce card stops with a reservation it never submitted (the
//      wsfood-es-28 case). 「重新执行」 is shown to meet the same operation
//      again; 「重做这一条」 must make a new card whose ledger key, read back
//      from the real board the way the dashboard's reserve endpoint reads it,
//      is a new operation, and the old card's request must not come back;
//   2. a real Agent run of a stage it cannot finish must open its final
//      message with 问题 / 原因 / 影响 / 建议, and describeStop must read them.
// It does not run Night Shift's HTTP service or any paid provider: the produce
// card is never dispatched.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const redact = (s) => String(s).replace(/(token|api.?key|authorization|secret|bearer)([=: ]+)[^\s"]+/giu, "$1$2[redacted]");
const secret = (name) => {
  if (!fs.existsSync(SECRETS)) return undefined;
  for (const line of fs.readFileSync(SECRETS, "utf8").split(/\r?\n/u)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/u);
    if (m?.[1] === name) return m[2].replace(/^["']|["']$/gu, "");
  }
  return undefined;
};

// Night Shift's workflow parser needs "yaml"; borrow the runtime's copy.
const yamlDir = [path.join(runtimeDir, "openclaw", "node_modules", "yaml"), path.join(runtimeDir, "node_modules", "yaml")]
  .find((dir) => fs.existsSync(dir));
assert(yamlDir, "yaml package not found in the candidate runtime");
fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
if (!fs.existsSync(path.join(repo, "node_modules", "yaml"))) fs.symlinkSync(yamlDir, path.join(repo, "node_modules", "yaml"));

// ---- private config: no channels, no cron ----
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const port = Number(config.gateway?.port);
assert(Number.isInteger(port) && port > 0, "candidate Gateway port is missing");
config.channels = {};
config.cron = { ...(config.cron ?? {}), enabled: false };
// The candidate runtime does not carry every configured external plugin (the
// Codex plugin from the vcodex-sol61 release); the Gateway refuses to report
// ready while one is missing. Night Shift does not need it.
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
let gateway;
function startGateway() {
  gateway = spawn(process.execPath, ["--max-old-space-size=4096", `${dist}/index.js`, "gateway", "--port", String(port)], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const s of [gateway.stdout, gateway.stderr]) {
    s.setEncoding("utf8");
    s.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/u).filter(Boolean)) lines.push({ at: Date.now(), line });
      if (lines.length > 20_000) lines.splice(0, lines.length - 20_000);
    });
  }
  return gateway;
}
const exited = (child, ms) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
  const timer = setTimeout(() => resolve(false), ms);
  child.once("exit", () => { clearTimeout(timer); resolve(true); });
});

// ---- this branch's Night Shift pieces ----
const { WorkboardGatewayAdapter } = await import(path.join(repo, "packages/nightshift-core/src/workboard-gateway-adapter.mjs"));
const { NightShiftStore } = await import(path.join(repo, "packages/nightshift-core/src/store.mjs"));
const { NightShiftRuntime } = await import(path.join(repo, "packages/nightshift-core/src/runtime.mjs"));
const { NeedsYouTracker, describeStop } = await import(path.join(repo, "packages/nightshift-core/src/needs-you.mjs"));
const { buildAgentBrief } = await import(path.join(repo, "packages/nightshift-core/src/orchestrator.mjs"));
const { resolveNightShiftOperationKeys, findNightShiftExternalOperation } = await import(path.join(repo, "packages/nightshift-core/src/card-context.mjs"));

const store = new NightShiftStore(path.join(scratch, "nightshift", "nightshift.sqlite"));
const board = "nightshift-redo-candidate";
const workboard = new WorkboardGatewayAdapter({
  board, configPath, entry: `${dist}/index.js`, gatewayUrl: `ws://127.0.0.1:${port}`, env,
});
const needsYou = new NeedsYouTracker({ store });
const runtime = new NightShiftRuntime({ board, store, workboard, needsYou });

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// The dashboard's reserve endpoint (apps/nightshift-dashboard/server/index.mjs),
// minus HTTP: which ledger operation a card's reserve call lands on.
function reserveFor(card, release, instanceId) {
  const instance = store.getInstance(instanceId);
  const contentItem = runtime.contentItemsWithRevisions(instanceId).find((entry) => entry.id === "video-1");
  const keys = resolveNightShiftOperationKeys({ card, release, instance, contentItem });
  const existing = findNightShiftExternalOperation({ card, candidateIdempotencyKeys: keys.candidateIdempotencyKeys, operations: store.listExternalOperations(instanceId) });
  const idempotencyKey = existing?.idempotencyKey ?? keys.preferredIdempotencyKey;
  return store.reserveExternalOperation({ idempotencyKey, instanceId, contentItemId: "video-1", stageId: "produce", ownerCardId: card.id, requestHash: "a".repeat(64) });
}

const result = { startedAt: new Date().toISOString(), checks: {} };
const agentId = Object.keys(config.agents?.entries ?? {}).includes("main") ? "main" : Object.keys(config.agents?.entries ?? {})[0] ?? "main";
try {
  startGateway();
  await waitFor(async () => {
    try { await workboard.connect(); return workboard.connected; } catch { return false; }
  }, 900_000, "the Gateway");
  result.readyMs = Date.now() - Date.parse(result.startedAt);

  // ---- 1. a stopped paid card, retried and redone on the real board ----
  const published = runtime.publish(fs.readFileSync(path.join(repo, "examples/workflows/xingqing-content-delivery.workflow.md"), "utf8"));
  const release = published.manifest;
  const instanceId = "NS-REDO-CANDIDATE";
  runtime.startInstance({ id: instanceId, workflowSha256: published.workflowSha256, agentBindings: { "content-operator": agentId }, inputs: { authorizationScope: { paidProduction: true } } });
  // Walk the item to produce: each planned card is marked done on the board.
  let produce = null;
  for (let pass = 0; pass < 8 && !produce; pass += 1) {
    if (pass === 1) runtime.setContentItems(instanceId, [{ id: "video-1", title: "Redo candidate", route: "AI_GENERATE" }]);
    await runtime.tick(instanceId, { dispatch: false, inspectSessions: false });
    const cards = await workboard.listCards({ cardIds: runtime.instanceCardIds(instanceId) });
    produce = cards.find((card) => (card.labels ?? []).includes("stage:produce") && card.status === "ready") ?? null;
    for (const card of cards) if (card.status === "ready" && card !== produce) await workboard.moveCard(card.id, "done");
  }
  assert.ok(produce, "the planner reached produce");
  const reserved = reserveFor(produce, release, instanceId);
  assert.equal(reserved.reused, false);
  await workboard.blockCard(produce.id, { reason: "candidate: reserved, never submitted" });

  // 「重新执行」: the same card, read back from the board, lands on the same operation.
  await runtime.retry({ actor: "candidate", cardId: produce.id, contentItemId: "video-1", instanceId, stageId: "produce" });
  const [retried] = await workboard.listCards({ cardIds: [produce.id] });
  const again = reserveFor(retried, release, instanceId);
  result.retry = { sameOperation: again.idempotencyKey === reserved.idempotencyKey, reused: again.reused, status: again.status };
  result.checks.retryMeetsSameReservation = again.reused === true && again.idempotencyKey === reserved.idempotencyKey && again.status === "reserved";
  await workboard.blockCard(produce.id, { reason: "candidate: reused+reserved without a task id" });
  const [stopped] = await workboard.listCards({ cardIds: [produce.id] });
  store.upsertContentItemRun({ instanceId, contentItemId: "video-1", stageId: "produce", attempt: 1, cardId: produce.id, status: "blocked" });

  const failure = { kind: "contract_error", retryable: false, automaticRetry: false, rawError: "External side effect has no succeeded Night Shift operation checkpoint" };
  const stage = release.spec.stages.find((entry) => entry.id === "produce");
  const request = needsYou.observe({ card: stopped, instance: store.getInstance(instanceId), stage, stageId: "produce", contentItemId: "video-1", status: "blocked", failure, operation: store.getExternalOperation(reserved.idempotencyKey) });
  result.request = { problem: request.problem, impact: request.impact, suggestion: request.suggestion, options: request.options.map((option) => option.label) };
  result.checks.requestOffersRedoNotRetry = request.options.map((option) => option.id).join(",") === "redo,skip,pause";

  const decided = await runtime.decide({ decisionId: request.id, optionId: "redo", note: "candidate redo note", actor: "candidate" });
  await runtime.tick(instanceId, { dispatch: false, inspectSessions: false });
  const cards = await workboard.listCards({ cardIds: runtime.instanceCardIds(instanceId) });
  const produceCards = cards.filter((card) => (card.labels ?? []).includes("stage:produce"));
  const fresh = produceCards.find((card) => card.id !== produce.id);
  assert.ok(fresh, "a new produce card on the real board");
  const freshOperation = reserveFor(fresh, release, instanceId);
  await runtime.reconcile(instanceId, null, { inspectSessions: false });
  const runs = store.listContentItemRuns(instanceId).filter((run) => run.stageId === "produce");
  result.redo = {
    decided: decided.redo,
    produceCards: produceCards.map((card) => ({ id: card.id.slice(0, 8), status: card.status })),
    briefSaysRedo: /Redo requested \(revision 1\): candidate chose 重做这一条/.test(fresh.notes ?? "") && /«candidate redo note»/.test(fresh.notes ?? ""),
    newOperation: { reused: freshOperation.reused, keyDiffers: freshOperation.idempotencyKey !== reserved.idempotencyKey },
    oldOperationStatus: store.getExternalOperation(reserved.idempotencyKey).status,
    runs: runs.map((run) => ({ attempt: run.attempt, card: run.cardId?.slice(0, 8) ?? null, status: run.status })),
    openRequests: store.listDecisionRequests({ instanceId, status: "open" }).length,
  };
  result.checks.redoMakesNewCard = produceCards.length === 2 && fresh.status === "ready" && result.redo.briefSaysRedo;
  result.checks.redoCardIsNewOperation = freshOperation.reused === false && result.redo.newOperation.keyDiffers && result.redo.oldOperationStatus === "reserved";
  result.checks.attemptsFollowCards = runs.some((run) => run.attempt === 1 && run.cardId === produce.id) && runs.some((run) => run.attempt === 2 && run.cardId === fresh.id);
  result.checks.oldStopNotReopened = result.redo.openRequests === 0;
  await workboard.moveCard(fresh.id, "cancelled").catch(() => {});

  // ---- 2. a real Agent that cannot finish writes the four lines ----
  const brief = buildAgentBrief(release, { id: "NS-STOP-REPORT-CANDIDATE", inputs: {} }, release.spec.stages.find((entry) => entry.id === "brief"),
    { id: "video-x", title: "西语短视频：番茄酱出口墨西哥", route: "AI_GENERATE", status: "planned" });
  const created = await workboard.call("workboard.cards.create", {
    boardId: board, title: "Stop report candidate｜brief", status: "ready", agentId,
    labels: ["instance:NS-STOP-REPORT-CANDIDATE", "stage:brief", "content-item:video-x"],
    maxRetries: 0, maxRuntimeSeconds: 900,
    notes: `${brief}\nCandidate note: this project has no materials, no inputs and no Workflow files on this host; do not search for them beyond one quick check.`,
  });
  const dispatched = await workboard.dispatch(1, { cardIds: [created.card.id] });
  assert.equal(dispatched.started.length, 1, `dispatch did not start: ${JSON.stringify(dispatched).slice(0, 300)}`);
  const { sessionKey, runId } = dispatched.started[0];
  const outcome = await waitFor(async () => {
    const value = await workboard.getRunOutcome({ sessionKey, runId }).catch(() => null);
    return value && !["queued", "running"].includes(String(value.status).toLowerCase()) ? value : null;
  }, 960_000, "the Agent run to end");
  const session = await workboard.getSession(sessionKey, { limit: 50 });
  const last = [...(session?.messages ?? [])].reverse().find((message) => message.role === "assistant" &&
    (typeof message.content === "string" ? message.content.trim() : (message.content ?? []).some((part) => part.type === "text" && part.text?.trim())));
  const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const [cardAfter] = await workboard.listCards({ cardIds: [created.card.id] });
  const described = describeStop({ failure: { kind: "contract_error", rawError: "Stage handoff is required: brief", agentReport: text } });
  result.agent = { agentId, run: outcome.status, card: cardAfter?.status, opening: text.split("\n").slice(0, 6).join("\n").slice(0, 900), described };
  result.checks.agentOpensWithFourLines = /^\s*(\*\*)?问题(\*\*)?[：:]/.test(text) && ["原因", "影响", "建议"].every((label) => new RegExp(`^\\s*(\\*\\*)?${label}(\\*\\*)?[：:]`, "m").test(text));
  result.checks.cardReadsAgentLines = Boolean(described.problem && described.cause && described.impact && described.suggestion) && !/agent 的说法/.test(described.cause);
  result.ok = Object.values(result.checks).every(Boolean);
} catch (error) {
  result.error = redact(error.stack ?? error.message);
  result.gatewayTail = redact(lines.slice(-30).map((l) => l.line).join("\n"));
} finally {
  await workboard.close().catch(() => {});
  if (gateway && gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    if (!(await exited(gateway, 60_000))) gateway.kill("SIGKILL");
  }
  store.close();
}
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
