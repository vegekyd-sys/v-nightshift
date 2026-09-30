// Pre-merge candidate for the Night Shift Gateway restart hold (#125).
//
// Runs a private Gateway from the candidate runtime and connects this branch's
// Night Shift adapter to it, then restarts that Gateway three ways:
//   1. SIGUSR1, the in-process restart V's release scripts use, while a real
//      Workboard card's Agent run is in flight; afterwards the runtime pickup
//      must find that run and put the card back to ready;
//   2. SIGTERM (systemctl stop/restart);
//   3. SIGKILL (a crash: no shutdown broadcast is possible).
// For each it records the lifecycle events Night Shift saw and the hold state.
// It proves the signals and the pickup against the real Gateway and task
// registry; it does not run the Night Shift scheduler itself.

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

const { WorkboardGatewayAdapter } = await import(path.join(repo, "packages/nightshift-core/src/workboard-gateway-adapter.mjs"));
const { GatewayRestartHold } = await import(path.join(repo, "packages/nightshift-core/src/gateway-restart-hold.mjs"));
const { NightShiftStore } = await import(path.join(repo, "packages/nightshift-core/src/store.mjs"));
const { NightShiftRuntime } = await import(path.join(repo, "packages/nightshift-core/src/runtime.mjs"));

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
const store = new NightShiftStore(path.join(scratch, "nightshift", "nightshift.sqlite"));
let clock = () => Date.now();
const hold = new GatewayRestartHold({ store, settleMs: 15_000, now: () => clock() });
const board = "nightshift-restart-candidate";
const workboard = new WorkboardGatewayAdapter({
  board, configPath, entry: `${dist}/index.js`, gatewayUrl: `ws://127.0.0.1:${port}`, env,
});
const runtime = new NightShiftRuntime({ board, store, workboard, needsYou: null });
const events = [];
workboard.onGatewayLifecycle((event) => {
  const status = hold.observe(event).status;
  events.push({ at: Date.now(), ...event, hold: status });
});

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Like systemd (Restart=always): a Gateway that exited is started again. A
// SIGUSR1 restart under a supervisor exits and leaves the start to it.
const exits = [];
let superviseStarts = 0;
function supervise() {
  if (gateway.exitCode === null && gateway.signalCode === null) return;
  exits.push({ at: Date.now(), code: gateway.exitCode, signal: gateway.signalCode });
  superviseStarts += 1;
  if (superviseStarts > 6) throw new Error(`Gateway keeps exiting\n${redact(lines.slice(-40).map((l) => l.line).join("\n"))}`);
  startGateway();
}

async function connected(label, ms = 900_000) {
  return waitFor(async () => {
    supervise();
    try {
      await workboard.connect();
      return workboard.connected && workboard.bootId ? workboard.bootId : null;
    } catch {
      return null;
    }
  }, ms, label);
}

const result = { scenarios: {}, startedAt: new Date().toISOString() };
const since = () => events.length;
function scenarioEvents(from) {
  return events.slice(from).map((event) => ({ type: event.type, reason: event.reason ?? undefined, restartExpectedMs: event.restartExpectedMs ?? undefined, bootId: event.bootId ? event.bootId.slice(0, 8) : undefined, hold: event.hold }));
}

try {
  startGateway();
  const bootA = await connected("first Gateway");
  result.firstBoot = bootA.slice(0, 8);
  result.firstReadyMs = Date.now() - Date.parse(result.startedAt);

  // ---- a real card whose Agent run is in flight ----
  const release = runtime.publish(fs.readFileSync(path.join(repo, "examples/workflows/xingqing-content-delivery.workflow.md"), "utf8"));
  const instanceId = "NS-RESTART-CANDIDATE";
  runtime.startInstance({ id: instanceId, workflowSha256: release.workflowSha256, agentBindings: { "content-operator": "makaron" } });
  const created = await workboard.call("workboard.cards.create", {
    boardId: board,
    title: "Gateway restart candidate｜plan",
    status: "ready",
    agentId: "makaron",
    labels: [`instance:${instanceId}`, "stage:plan"],
    maxRetries: 2,
    maxRuntimeSeconds: 1800,
    notes: "Automated Gateway restart test. Call the exec tool exactly once with the command `sleep 900` and wait for it to finish. Do not do anything else, do not complete or block this card.",
  });
  const cardId = created.card.id;
  store.upsertStageRun({ instanceId, stageId: "plan", attempt: 1, cardId, status: "running" });
  const dispatched = await workboard.dispatch(1, { cardIds: [cardId] });
  assert.equal(dispatched.started.length, 1, `dispatch did not start the card: ${JSON.stringify(dispatched).slice(0, 400)}`);
  const { sessionKey, runId } = dispatched.started[0];
  const running = await waitFor(async () => {
    const outcome = await workboard.getRunOutcome({ sessionKey, runId }).catch(() => null);
    const cards = await workboard.listCards({ cardIds: [cardId] }).catch(() => []);
    const session = await workboard.getSession(sessionKey, { limit: 50 }).catch(() => null);
    const toolCalled = JSON.stringify(session?.messages ?? []).includes("sleep 900");
    return outcome?.status === "running" && cards[0]?.status === "running" && toolCalled ? outcome : null;
  }, 300_000, "the Agent to start sleep 900");
  result.inFlight = { cardId: cardId.slice(0, 8), runStatus: running.status };

  // ---- 1. SIGUSR1: the in-process restart ----
  let mark = since();
  const usr1At = Date.now();
  gateway.kill("SIGUSR1");
  const usr1Child = gateway;
  const bootB = await waitFor(async () => {
    const boot = await connected("Gateway after SIGUSR1").catch(() => null);
    return boot && boot !== bootA ? boot : null;
  }, 900_000, "a new Gateway boot after SIGUSR1");
  const backAt = Date.now();
  const settled = await waitFor(() => {
    const gate = hold.gate({ connected: workboard.connected, bootId: workboard.bootId });
    return gate.pickup ?? null;
  }, 120_000, "the hold to settle");
  const outcomeAfter = await workboard.getRunOutcome({ sessionKey, runId });
  const pickup = await runtime.resumeAfterGatewayRestart(settled);
  const [cardAfter] = await workboard.listCards({ cardIds: [cardId] });
  hold.complete(settled, pickup);
  result.scenarios.sigusr1 = {
    processExited: usr1Child.exitCode !== null || usr1Child.signalCode !== null,
    exits: exits.map((e) => ({ afterMs: e.at - usr1At, code: e.code, signal: e.signal })),
    newBoot: bootB.slice(0, 8),
    downMs: backAt - usr1At,
    events: scenarioEvents(mark),
    window: { bootChanged: settled.bootChanged, reason: settled.reason },
    runAfterRestart: { status: outcomeAfter?.status ?? null, error: outcomeAfter?.error ?? null },
    pickup: { resumed: pickup.resumed.map((e) => ({ card: e.cardId.slice(0, 8), cause: e.cause })), handedOver: pickup.handedOver.length, skipped: pickup.skipped },
    cardAfter: cardAfter?.status,
    resumedEvent: store.listEvents(instanceId).some((event) => event.type === "stage.gateway-restart.resumed"),
    failuresRecorded: store.listEvents(instanceId).filter((event) => event.type === "stage.attempt.failed").length,
  };
  await workboard.call("workboard.cards.update", { id: cardId, patch: { status: "cancelled" } }).catch(() => {});

  // ---- 2. SIGTERM: an orderly stop ----
  mark = since();
  gateway.kill("SIGTERM");
  const termExited = await exited(gateway, 120_000);
  await sleep(3_000);
  const heldWhileDown = hold.gate({ connected: workboard.connected, bootId: workboard.bootId }).hold === true;
  if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill("SIGKILL");
  await exited(gateway, 30_000);
  superviseStarts = 0;
  const bootC = await waitFor(async () => {
    const boot = await connected("Gateway after SIGTERM").catch(() => null);
    return boot && boot !== bootB ? boot : null;
  }, 900_000, "a new Gateway boot after SIGTERM");
  const termPickup = await waitFor(() => hold.gate({ connected: workboard.connected, bootId: workboard.bootId }).pickup ?? null, 120_000, "settle after SIGTERM");
  hold.complete(termPickup, {});
  result.scenarios.sigterm = { processExited: termExited, heldWhileDown, newBoot: bootC.slice(0, 8), bootChanged: termPickup.bootChanged, events: scenarioEvents(mark) };

  // ---- 3. SIGKILL: a crash ----
  mark = since();
  gateway.kill("SIGKILL");
  await exited(gateway, 30_000);
  await sleep(3_000);
  const heldAfterKill = hold.gate({ connected: workboard.connected, bootId: workboard.bootId }).hold === true;
  superviseStarts = 0;
  const bootD = await waitFor(async () => {
    const boot = await connected("Gateway after SIGKILL").catch(() => null);
    return boot && boot !== bootC ? boot : null;
  }, 900_000, "a new Gateway boot after SIGKILL");
  const killPickup = await waitFor(() => hold.gate({ connected: workboard.connected, bootId: workboard.bootId }).pickup ?? null, 120_000, "settle after SIGKILL");
  hold.complete(killPickup, {});
  result.scenarios.sigkill = { heldAfterKill, newBoot: bootD.slice(0, 8), bootChanged: killPickup.bootChanged, events: scenarioEvents(mark) };

  // ---- verdicts ----
  const u = result.scenarios.sigusr1;
  result.checks = {
    sigusr1ShutdownBroadcastSeen: u.events.some((e) => e.type === "shutdown"),
    sigusr1HeldAndResumed: u.events.some((e) => e.hold === "holding") && u.window.bootChanged === true,
    sigusr1InFlightCardResumed: u.pickup.resumed.length === 1 && u.cardAfter === "ready" && u.resumedEvent && u.failuresRecorded === 0,
    sigtermHeld: result.scenarios.sigterm.heldWhileDown && result.scenarios.sigterm.bootChanged,
    sigkillHeldByDisconnect: result.scenarios.sigkill.heldAfterKill && result.scenarios.sigkill.events.some((e) => e.type === "disconnected") && result.scenarios.sigkill.bootChanged,
  };
  // Observed, not required: a SIGTERM stop closes the socket before its
  // broadcast reaches clients (2026-09-30), and the dropped connection holds.
  result.observed = { sigtermShutdownBroadcastSeen: result.scenarios.sigterm.events.some((e) => e.type === "shutdown") };
  result.ok = Object.values(result.checks).every(Boolean);
} catch (error) {
  result.error = redact(error.stack ?? error.message);
  result.gatewayTail = redact(lines.slice(-30).map((l) => l.line).join("\n"));
  result.partialEvents = scenarioEvents(0);
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
