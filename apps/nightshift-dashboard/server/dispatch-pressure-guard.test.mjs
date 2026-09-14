import assert from "node:assert/strict";
import test from "node:test";
import { DispatchPressureGuard } from "./dispatch-pressure-guard.mjs";

test("grows capacity slowly after consecutive green Gateway probes", () => {
  let now = 1_000;
  const guard = new DispatchPressureGuard({ initialMaxActive: 3, maxActive: 30, now: () => now });
  assert.equal(guard.snapshot(0).availableStarts, 3);
  guard.recordProbe({ latencyMs: 80, running: 3 });
  assert.equal(guard.snapshot(3).targetMaxActive, 3);
  now += 30_000;
  guard.recordProbe({ latencyMs: 90, running: 3 });
  assert.equal(guard.snapshot(3).targetMaxActive, 4);
  assert.equal(guard.snapshot(3).availableStarts, 1);
});

test("yellow pressure stops new starts without killing running workers", () => {
  let now = 1_000;
  const guard = new DispatchPressureGuard({ initialMaxActive: 6, now: () => now, redCooldownMs: 60_000 });
  const pressure = guard.recordProbe({ latencyMs: 500, running: 5 });
  assert.equal(pressure.targetMaxActive, 5);
  assert.equal(pressure.dispatchAllowed, false);
  assert.equal(pressure.availableStarts, 0);
  now += 60_000;
  assert.equal(guard.snapshot(3).dispatchAllowed, true);
  assert.equal(guard.snapshot(3).availableStarts, 2);
});

test("red pressure halves the target and opens a cooldown", () => {
  let now = 1_000;
  const guard = new DispatchPressureGuard({ initialMaxActive: 10, now: () => now, redCooldownMs: 60_000 });
  const pressure = guard.recordProbe({ latencyMs: 5_100, running: 10 });
  assert.equal(pressure.targetMaxActive, 5);
  assert.equal(pressure.dispatchAllowed, false);
  assert.equal(pressure.availableStarts, 0);
  now += 60_000;
  assert.equal(guard.snapshot(2).availableStarts, 3);
});
