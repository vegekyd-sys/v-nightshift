import assert from "node:assert/strict";
import test from "node:test";
import { DispatchHoldLedger, dispatchHoldReason } from "./dispatch-hold-ledger.mjs";
import { DispatchPressureGuard } from "./dispatch-pressure-guard.mjs";
import { warmupAdmission } from "./active-card-count.mjs";

const pool = (workersBusy, workerCapacity = 15) => ({ capacity: 45, active: workersBusy, queued: 0, workerCapacity, workersBusy });

function guardAt(now) {
  return new DispatchPressureGuard({ initialMaxActive: 12, maxActive: 36, now: () => now });
}

test("nothing waiting is not a hold", () => {
  assert.equal(dispatchHoldReason({ waiting: false, pressure: guardAt(0).snapshot(0) }), null);
});

test("each brake is named, in the order it gates a start", () => {
  const now = 100_000;
  const reason = (probe, { running = 4, warmup = { available: 1 }, ...rest } = {}) => {
    const guard = guardAt(now);
    if (probe) guard.recordProbe({ running, ...probe });
    return dispatchHoldReason({ waiting: true, pressure: guard.snapshot(running), warmup, ...rest });
  };
  assert.equal(reason(null), "no-probe");
  assert.equal(reason({ latencyMs: 50 }, { gatewayStatus: "holding" }), "gateway-restart");
  assert.equal(reason({ latencyMs: 50 }, { circuitOpen: true }), "scheduler-circuit");
  assert.equal(reason({ hostPressure: { blocked: true, reason: "insufficient memory headroom" } }), "host-memory-headroom");
  assert.equal(reason({ hostPressure: { blocked: true, reason: "memory reclaim stalls" } }), "host-memory-stall");
  assert.equal(reason({ latencyMs: 50, agentDbPressure: { level: "red", reason: "lease timeouts" } }), "agent-db-lease-timeout");
  assert.equal(reason({ latencyMs: 50, agentDbPressure: { level: "red", userHarm: true } }), "agent-db-harm");
  assert.equal(reason({ latencyMs: 5_000 }), "gateway-latency-red");
  assert.equal(reason({ error: "gateway timeout" }), "gateway-probe-error");
  assert.equal(reason({ latencyMs: 50, agentDbPressure: { level: "yellow" } }), "agent-db-slow-admission");
  assert.equal(reason({ latencyMs: 600 }), "gateway-latency-yellow");
  assert.equal(reason({ latencyMs: 50, workerPool: pool(12) }, { running: 4 }), "worker-capacity");
  assert.equal(reason({ latencyMs: 50, workerPool: pool(4) }, { running: 12 }), "target-max-active");
  assert.equal(reason({ latencyMs: 50, workerPool: pool(4) }, { warmup: { available: 0 } }), "warmup");
  assert.equal(reason({ latencyMs: 50, workerPool: pool(4) }), "starting");
});

test("a red probe followed by green ones reads as the red cooldown, then recovery", () => {
  let now = 0;
  const guard = new DispatchPressureGuard({ initialMaxActive: 12, now: () => now });
  guard.recordProbe({ latencyMs: 5_000, running: 6 });
  now += 5_000;
  guard.recordProbe({ latencyMs: 50, running: 6 });
  assert.equal(dispatchHoldReason({ waiting: true, pressure: guard.snapshot(6) }), "red-cooldown");
  now += 60_000;
  guard.recordProbe({ latencyMs: 50, running: 6 });
  assert.equal(dispatchHoldReason({ waiting: true, pressure: guard.snapshot(6) }), "recovering");
});

test("time goes to the brake that held, only while a card was waiting", () => {
  let now = 0;
  const lines = [];
  const ledger = new DispatchHoldLedger({ now: () => now, summaryIntervalMs: 60_000, log: (line) => lines.push(JSON.parse(line)) });
  ledger.observe("host-memory-headroom");
  now += 20_000; ledger.observe("host-memory-headroom");
  now += 10_000; ledger.observe(null);
  now += 25_000; ledger.observe("warmup");
  now += 5_000; ledger.observe("starting", { running: 9 });
  assert.deepEqual(ledger.snapshot().byReason, { "host-memory-headroom": 30_000, warmup: 5_000 });
  assert.equal(ledger.snapshot().waitingMs, 35_000);
  assert.equal(lines.length, 1, "one summary line per window");
  assert.equal(lines[0].event, "dispatch.holds");
  assert.equal(lines[0].running, 9);
  assert.deepEqual(lines[0].byReason, { "host-memory-headroom": 30_000, warmup: 5_000 });
  now += 30_000; ledger.observe("starting");
  assert.deepEqual(ledger.snapshot().current, { reason: "starting", since: new Date(60_000).toISOString() });
  assert.equal(ledger.snapshot().byReason.starting, 30_000);
});

test("an observation gap counts at most the cap, and a quiet window logs nothing", () => {
  let now = 0;
  const lines = [];
  const ledger = new DispatchHoldLedger({ now: () => now, maxGapMs: 10_000, summaryIntervalMs: 60_000, log: (line) => lines.push(line) });
  ledger.observe("worker-capacity");
  now += 300_000; ledger.observe(null);
  assert.equal(ledger.snapshot().byReason["worker-capacity"], 10_000);
  now += 120_000; ledger.observe(null);
  assert.equal(lines.length, 1, "the second window had nothing waiting");
});

test("the warm-up gate is reported once the other brakes pass", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  const warming = [1, 2, 3].map((index) => ({ status: "running", execution: { startedAt: now - index * 10_000 } }));
  const warmup = warmupAdmission(warming, { now, windowMs: 90_000, maxWarming: 3 });
  const guard = guardAt(now);
  guard.recordProbe({ latencyMs: 50, running: 3, workerPool: pool(3) });
  assert.equal(dispatchHoldReason({ waiting: true, pressure: guard.snapshot(3), warmup }), "warmup");
});
