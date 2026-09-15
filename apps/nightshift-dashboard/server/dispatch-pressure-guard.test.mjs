import assert from "node:assert/strict";
import test from "node:test";
import { DispatchPressureGuard } from "./dispatch-pressure-guard.mjs";

test("grows capacity slowly after consecutive green Gateway probes", () => {
  let now = 1_000;
  const guard = new DispatchPressureGuard({ initialMaxActive: 3, maxActive: 30, now: () => now });
  assert.equal(guard.snapshot(0).availableStarts, 0);
  assert.equal(guard.snapshot(0).dispatchAllowed, false);
  guard.recordProbe({ latencyMs: 80, running: 3 });
  assert.equal(guard.snapshot(3).targetMaxActive, 3);
  now += 30_000;
  guard.recordProbe({ latencyMs: 90, running: 3 });
  assert.equal(guard.snapshot(3).targetMaxActive, 4);
  assert.equal(guard.snapshot(3).availableStarts, 1);
});

test("learns an idle Gateway baseline without learning from running-worker pressure", () => {
  const guard = new DispatchPressureGuard({ initialMaxActive: 3 });
  const idle = guard.recordProbe({ latencyMs: 600, running: 0 });
  assert.equal(idle.baselineLatencyMs, 600);
  assert.equal(idle.greenLatencyMs, 750);
  assert.equal(idle.redLatencyMs, 1_200);
  assert.equal(idle.dispatchAllowed, true);
  assert.equal(idle.availableStarts, 1);

  const loaded = guard.recordProbe({ latencyMs: 1_300, running: 3 });
  assert.equal(loaded.lastProbe.level, "red");
  assert.equal(loaded.baselineLatencyMs, 600);
  assert.equal(loaded.targetMaxActive, 1);
  assert.equal(loaded.dispatchAllowed, false);
});

test("does not accept an already-red idle probe as the learned baseline", () => {
  const guard = new DispatchPressureGuard({ initialMaxActive: 3 });
  const pressure = guard.recordProbe({ latencyMs: 1_500, running: 0 });
  assert.equal(pressure.baselineLatencyMs, null);
  assert.equal(pressure.lastProbe.level, "red");
  assert.equal(pressure.dispatchAllowed, false);
});

test("yellow pressure stops new starts without killing running workers", () => {
  let now = 1_000;
  const guard = new DispatchPressureGuard({ initialMaxActive: 6, now: () => now, redCooldownMs: 60_000 });
  const pressure = guard.recordProbe({ latencyMs: 500, running: 5 });
  assert.equal(pressure.targetMaxActive, 5);
  assert.equal(pressure.dispatchAllowed, false);
  assert.equal(pressure.availableStarts, 0);
  now += 60_000;
  assert.equal(guard.snapshot(3).dispatchAllowed, false);
  assert.equal(guard.snapshot(3).availableStarts, 0);
  const recovered = guard.recordProbe({ latencyMs: 100, running: 3 });
  assert.equal(recovered.dispatchAllowed, true);
  assert.equal(recovered.availableStarts, 1);
});

test("red pressure halves the target and opens a cooldown", () => {
  let now = 1_000;
  const guard = new DispatchPressureGuard({ initialMaxActive: 10, now: () => now, redCooldownMs: 60_000 });
  const pressure = guard.recordProbe({ latencyMs: 5_100, running: 10 });
  assert.equal(pressure.targetMaxActive, 5);
  assert.equal(pressure.dispatchAllowed, false);
  assert.equal(pressure.availableStarts, 0);
  now += 60_000;
  assert.equal(guard.snapshot(2).availableStarts, 0);
});

test("one green probe authorizes only one cold start", () => {
  const guard = new DispatchPressureGuard({ initialMaxActive: 6 });
  const pressure = guard.recordProbe({ latencyMs: 80, running: 0 });
  assert.equal(pressure.availableStarts, 1);
  guard.consumeStarts(1);
  assert.equal(guard.snapshot(1).availableStarts, 0);
  assert.equal(guard.snapshot(1).dispatchAllowed, false);
});
