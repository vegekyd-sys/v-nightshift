import assert from "node:assert/strict";
import test from "node:test";
import { isGatewayPressureFailure, SchedulerCircuit } from "./scheduler-circuit.mjs";

test("recognizes Gateway and SQLite pressure failures", () => {
  assert.equal(isGatewayPressureFailure("OpenClaw Gateway RPC failed (exit 1): gateway timeout after 10000ms"), true);
  assert.equal(isGatewayPressureFailure("database is locked"), true);
  assert.equal(isGatewayPressureFailure("SQLITE_BUSY"), true);
  assert.equal(isGatewayPressureFailure("missing project input"), false);
});

test("opens for a cooldown and requires one dispatch-free recovery probe", () => {
  let now = 1_000;
  const circuit = new SchedulerCircuit({ cooldownMs: 300_000, now: () => now });
  assert.deepEqual(circuit.beforePass(), { dispatch: true, run: true });
  assert.equal(circuit.recordFailure("gateway timeout after 10000ms"), true);
  assert.deepEqual(circuit.beforePass(), { dispatch: false, retryAfterMs: 300_000, run: false });

  now += 300_000;
  assert.deepEqual(circuit.beforePass(), { dispatch: false, probe: true, run: true });
  circuit.recordPass([], { probe: true });
  assert.deepEqual(circuit.beforePass(), { dispatch: true, run: true });
});

test("a failed probe extends the circuit and ordinary warnings do not open it", () => {
  let now = 5_000;
  const circuit = new SchedulerCircuit({ cooldownMs: 60_000, now: () => now });
  circuit.recordPass(["missing project input"]);
  assert.equal(circuit.snapshot().open, false);

  circuit.recordFailure("database is locked");
  now += 60_000;
  const probe = circuit.beforePass();
  circuit.recordPass(["P1: Gateway RPC failed"], { probe: probe.probe });
  assert.equal(circuit.snapshot().open, true);
  assert.equal(circuit.beforePass().retryAfterMs, 60_000);
});
