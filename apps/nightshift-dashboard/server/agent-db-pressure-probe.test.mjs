import assert from "node:assert/strict";
import test from "node:test";
import { agentDbPressureLevel, classifyAgentDbLines, createAgentDbPressureProbe } from "./agent-db-pressure-probe.mjs";

// Journal lines exactly as `journalctl -o cat` printed them on V.
// 2026-09-24 10:21: two people's replies cut by the lease.
const PERSON_A = "[vlab-worker:2] [agent/embedded] embedded run agent end: runId=5b52fc6d-0c0b-4f1d-873b-3710d36a1f8a isError=true model=grok-4.6 provider=xai error=⚠️ xai/grok-4.6 request failed. rawError=Agent DB process coordinator wait exceeded 5000ms";
const PERSON_B = "[vlab-worker:13] [feishu] embedded run agent end: runId=eaa1f36e-cb26-4ceb-b855-2c63cf766a33 isError=true model=deepseek-flash provider=deepseek error=⚠️ deepseek/deepseek-flash request failed. rawError=Agent DB process coordinator wait exceeded 5000ms";
// The Gateway logs the same failure again without the worker prefix.
const PERSON_B_AGAIN = "[feishu] embedded run agent end: runId=eaa1f36e-cb26-4ceb-b855-2c63cf766a33 isError=true model=deepseek-flash provider=deepseek error=⚠️ deepseek/deepseek-flash request failed. rawError=Agent DB process coordinator wait exceeded 5000ms";
// 2026-09-23 12:59: a card's own run killed by the lease.
const CARD = "[vlab-worker:3] [agent/embedded] embedded run agent end: runId=workboard:0a3ba2fb-4492-4abb-a563-41c229177ba8:1790139481814 isError=true model=deepseek-flash provider=deepseek error=⚠️ deepseek/deepseek-flash request failed. rawError=Agent DB process coordinator wait exceeded 5000ms";
const SLOW = "[vlab-worker:2] [state/agent-db] slow direct Agent DB process writer admission";
// An Agent quoting the error in its card notes (2026-09-23 13:09). Not a timeout.
const PROSE = "（注：本卡此前一次 attempt 因 `Dispatcher could not start worker: Agent DB process coordinator wait exceeded 5000ms` 被 block，属调度侧问题，本次运行未再出现。）";

test("counts each lease timeout once and tells a person's reply from a card", () => {
  const counts = classifyAgentDbLines([PERSON_A, PERSON_B, PERSON_B_AGAIN, CARD, SLOW, SLOW, PROSE]);
  assert.equal(counts.coordinatorTimeouts, 3);
  assert.equal(counts.interactiveTimeouts, 2);
  assert.deepEqual(counts.interactiveRunIds, [
    "5b52fc6d-0c0b-4f1d-873b-3710d36a1f8a",
    "eaa1f36e-cb26-4ceb-b855-2c63cf766a33",
  ]);
  assert.equal(counts.slowAdmissions, 2);
});

test("an Agent quoting the error is not a timeout", () => {
  assert.equal(classifyAgentDbLines([PROSE]).coordinatorTimeouts, 0);
});

test("any timeout is red; enough slow admissions are yellow", () => {
  const options = { slowAdmissionYellow: 3 };
  assert.equal(agentDbPressureLevel(classifyAgentDbLines([CARD]), options), "red");
  assert.equal(agentDbPressureLevel(classifyAgentDbLines([SLOW, SLOW, SLOW]), options), "yellow");
  assert.equal(agentDbPressureLevel(classifyAgentDbLines([SLOW, SLOW]), options), "green");
  assert.equal(agentDbPressureLevel(classifyAgentDbLines([]), options), "green");
});

function journal(lines, { unitVisible = true } = {}) {
  const calls = [];
  const readJournal = async (args) => {
    calls.push(args);
    if (args.includes("-n")) return unitVisible ? "some gateway line\n" : "";
    return lines.join("\n") + (lines.length ? "\n" : "");
  };
  return { calls, readJournal };
}

const LOCAL = { gatewayUrl: "ws://127.0.0.1:22793", platform: "linux" };

test("reads the Gateway unit's recent window with a server-side filter", async () => {
  const { calls, readJournal } = journal([PERSON_B, SLOW]);
  const probe = createAgentDbPressureProbe({ ...LOCAL, readJournal, unit: "openclaw-gateway", windowSeconds: 120 });
  const result = await probe();
  assert.equal(result.level, "red");
  assert.equal(result.blocked, true);
  assert.equal(result.userHarm, true);
  assert.match(result.reason, /1 in a person's conversation/);
  const read = calls.find((args) => args.includes("--grep"));
  assert.deepEqual(read.slice(0, 5), ["-q", "-u", "openclaw-gateway", "--since", "-120s"]);
  assert.match(read.at(-1), /embedded run agent end/);
});

test("a card-only timeout is red without user harm", async () => {
  const probe = createAgentDbPressureProbe({ ...LOCAL, ...journal([CARD]) });
  const result = await probe();
  assert.equal(result.level, "red");
  assert.equal(result.userHarm, false);
});

test("silence from an unreadable unit is reported as unobserved, not green", async () => {
  const probe = createAgentDbPressureProbe({ ...LOCAL, ...journal([], { unitVisible: false }), unit: "openclaw-gateway-typo" });
  const result = await probe();
  assert.equal(result.level, "unknown");
  assert.equal(result.blocked, false);
  assert.match(result.reason, /No journal entries readable for openclaw-gateway-typo/);
});

test("a journal failure observes nothing and blocks nothing", async () => {
  const probe = createAgentDbPressureProbe({ ...LOCAL, readJournal: async () => { throw new Error("spawn journalctl ENOENT"); } });
  const result = await probe();
  assert.equal(result.level, "unknown");
  assert.equal(result.blocked, false);
  assert.match(result.reason, /ENOENT/);
});

test("reuses one reading within the minimum interval", async () => {
  let now = 1_000_000;
  const { calls, readJournal } = journal([SLOW]);
  const probe = createAgentDbPressureProbe({ ...LOCAL, readJournal, now: () => now, minIntervalMs: 15_000 });
  await probe();
  const reads = calls.length;
  now += 5_000;
  await probe();
  assert.equal(calls.length, reads);
  now += 15_000;
  await probe();
  assert.ok(calls.length > reads);
});

test("stays off away from the Gateway host or when disabled", async () => {
  const { calls, readJournal } = journal([CARD]);
  for (const options of [
    { gatewayUrl: "ws://gateway.internal:22793", platform: "linux" },
    { gatewayUrl: "ws://127.0.0.1:22793", platform: "darwin" },
    { ...LOCAL, enabled: false },
  ]) {
    const result = await createAgentDbPressureProbe({ ...options, readJournal })();
    assert.equal(result.enabled, false);
    assert.equal(result.blocked, false);
  }
  assert.equal(calls.length, 0);
});
