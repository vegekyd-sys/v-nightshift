import assert from "node:assert/strict";
import test from "node:test";

import { GatewayRestartHold, isGatewayRestartError } from "../src/gateway-restart-hold.mjs";
import { NightShiftStore } from "../src/store.mjs";

function setup({ settleMs = 60_000 } = {}) {
  const store = new NightShiftStore();
  let clock = Date.parse("2026-09-30T04:50:00Z");
  const hold = new GatewayRestartHold({ store, settleMs, now: () => clock });
  return { store, hold, advance: (ms) => { clock += ms; }, now: () => clock };
}

test("a Gateway shutdown holds Night Shift until the new Gateway has settled, then asks for a pickup", () => {
  const { hold, advance } = setup();
  hold.observe({ type: "connected", bootId: "boot-a" });
  assert.deepEqual(hold.gate({ connected: true, bootId: "boot-a" }), { hold: false });

  hold.observe({ type: "shutdown", reason: "gateway restarting", restartExpectedMs: 1500 });
  assert.equal(hold.gate({ connected: true, bootId: "boot-a" }).hold, true, "the old process may still answer while it drains");
  hold.observe({ type: "disconnected" });
  advance(40_000);
  assert.equal(hold.gate({ connected: false }).hold, true);

  hold.observe({ type: "connected", bootId: "boot-b" });
  assert.equal(hold.snapshot().status, "resuming");
  advance(30_000);
  assert.equal(hold.gate({ connected: true, bootId: "boot-b" }).hold, true, "the new process is still cold");
  advance(30_000);
  const { pickup } = hold.gate({ connected: true, bootId: "boot-b" });
  assert.equal(pickup.bootChanged, true);
  assert.equal(pickup.fromBootId, "boot-a");
  assert.equal(pickup.bootId, "boot-b");
  assert.equal(pickup.reason, "gateway restarting");
  assert.equal(pickup.from, "2026-09-30T04:50:00.000Z");
  assert.equal(pickup.to, "2026-09-30T04:50:40.000Z");

  hold.complete(pickup, { resumed: [{ cardId: "c1" }], handedOver: [] });
  assert.deepEqual(hold.gate({ connected: true, bootId: "boot-b" }), { hold: false });
  assert.equal(hold.snapshot().last.resumed.length, 1);
});

test("a crash with no shutdown broadcast is caught by the dropped connection", () => {
  const { hold, advance } = setup();
  hold.observe({ type: "connected", bootId: "boot-a" });
  hold.observe({ type: "disconnected" });
  assert.equal(hold.snapshot().hold.reason, "gateway connection lost");
  advance(5_000);
  hold.observe({ type: "connected", bootId: "boot-b" });
  advance(60_000);
  assert.equal(hold.gate({ connected: true, bootId: "boot-b" }).pickup.bootChanged, true);
});

test("a dropped connection to the same Gateway is not a restart: no run is presumed lost", () => {
  const { hold, advance } = setup();
  hold.observe({ type: "connected", bootId: "boot-a" });
  hold.observe({ type: "disconnected" });
  hold.observe({ type: "connected", bootId: "boot-a" });
  advance(60_000);
  assert.equal(hold.gate({ connected: true, bootId: "boot-a" }).pickup.bootChanged, false);
});

test("a restart Night Shift did not see (it was down too) is found by the new boot id", () => {
  const { store, hold, advance } = setup();
  hold.observe({ type: "connected", bootId: "boot-a" });
  advance(2 * 60_000);
  hold.gate({ connected: true, bootId: "boot-a" });
  // Night Shift restarts, then meets a different Gateway.
  const next = new GatewayRestartHold({ store, now: hold.now });
  next.observe({ type: "connected", bootId: "boot-b" });
  assert.equal(next.snapshot().status, "resuming");
  assert.equal(next.snapshot().hold.reason, "gateway boot changed");
  assert.equal(next.snapshot().hold.since, "2026-09-30T04:52:00.000Z", "the window starts when the old Gateway was last seen up");
});

test("the hold survives a Night Shift restart", () => {
  const { store, hold } = setup();
  hold.observe({ type: "connected", bootId: "boot-a" });
  hold.observe({ type: "shutdown", reason: "SIGTERM" });
  const next = new GatewayRestartHold({ store, now: hold.now });
  assert.equal(next.gate({ connected: false }).hold, true);
});

test("a shutdown whose process never went away releases after five minutes", () => {
  const { hold, advance } = setup();
  hold.observe({ type: "connected", bootId: "boot-a" });
  hold.observe({ type: "shutdown", reason: "gateway stopping" });
  advance(4 * 60_000);
  assert.equal(hold.gate({ connected: true, bootId: "boot-a" }).hold, true);
  advance(60_000);
  assert.equal(hold.gate({ connected: true, bootId: "boot-a" }).hold, true, "settles like any return");
  advance(60_000);
  assert.equal(hold.gate({ connected: true, bootId: "boot-a" }).pickup.bootChanged, false);
});

test("a second restart while settling keeps the first window", () => {
  const { hold, advance } = setup();
  hold.observe({ type: "connected", bootId: "boot-a" });
  hold.observe({ type: "shutdown", reason: "first" });
  hold.observe({ type: "connected", bootId: "boot-b" });
  advance(20_000);
  hold.observe({ type: "shutdown", reason: "second" });
  hold.observe({ type: "connected", bootId: "boot-c" });
  advance(60_000);
  const { pickup } = hold.gate({ connected: true, bootId: "boot-c" });
  assert.equal(pickup.reason, "first");
  assert.equal(pickup.fromBootId, "boot-a");
  assert.equal(pickup.bootId, "boot-c");
});

test("a suspension holds before the restart broadcast, and the window starts there", () => {
  // V, 2026-09-30 21:16: admission closed at 21:16:00, shutdown broadcast 21:16:24.
  const { hold, advance } = setup();
  hold.observe({ type: "connected", bootId: "boot-a" });
  hold.observe({ type: "suspended", phase: "suspending" });
  assert.equal(hold.snapshot().status, "holding");
  advance(24_000);
  hold.observe({ type: "shutdown", reason: "gateway restarting", restartExpectedMs: 1500 });
  hold.observe({ type: "disconnected" });
  hold.observe({ type: "connected", bootId: "boot-b" });
  advance(60_000);
  const { pickup } = hold.gate({ connected: true, bootId: "boot-b" });
  assert.equal(pickup.from, "2026-09-30T04:50:00.000Z");
  assert.equal(pickup.reason, "gateway suspended (suspending)");
  assert.equal(pickup.bootChanged, true);
});

test("a suspension that reopens on the same Gateway goes on at once: nothing restarted", () => {
  const { hold, advance } = setup();
  hold.observe({ type: "connected", bootId: "boot-a" });
  hold.observe({ type: "suspended", phase: "preparing" });
  assert.equal(hold.gate({ connected: true, bootId: "boot-a" }).hold, true);
  advance(3_000);
  hold.observe({ type: "accepting", bootId: "boot-a" });
  assert.deepEqual(hold.gate({ connected: true, bootId: "boot-a" }), { hold: false });
  assert.equal(hold.snapshot().lastSuspension.reason, "gateway suspended (preparing)");
});

test("a Gateway that closes admission for three seconds every thirty never holds Night Shift for good", () => {
  // V, 2026-10-02 13:25: with a 60 s settle after each reopen, the next
  // closure always came first and Night Shift stopped dispatching.
  const { hold, advance } = setup();
  hold.observe({ type: "connected", bootId: "boot-a" });
  let open = 0;
  for (let cycle = 0; cycle < 10; cycle += 1) {
    hold.observe({ type: "suspended", phase: "preparing" });
    advance(3_000);
    hold.observe({ type: "accepting", bootId: "boot-a" });
    advance(27_000);
    if (hold.gate({ connected: true, bootId: "boot-a" }).hold === false) open += 1;
  }
  assert.equal(open, 10);
});

test("a suspension that ends in a restart still waits for the new Gateway to settle", () => {
  const { hold, advance } = setup();
  hold.observe({ type: "connected", bootId: "boot-a" });
  hold.observe({ type: "suspended", phase: "preparing" });
  hold.observe({ type: "disconnected" });
  hold.observe({ type: "accepting", bootId: "boot-b" });
  assert.equal(hold.snapshot().status, "holding", "admission on a different Gateway is not this one reopening");
  hold.observe({ type: "connected", bootId: "boot-b" });
  advance(30_000);
  assert.equal(hold.gate({ connected: true, bootId: "boot-b" }).hold, true);
  advance(30_000);
  assert.equal(hold.gate({ connected: true, bootId: "boot-b" }).pickup.bootChanged, true);
});

test("refused RPCs name a Gateway suspension or restart", () => {
  assert.equal(isGatewayRestartError(new Error("workboard.cards.list unavailable during gateway suspension")), true);
  assert.equal(isGatewayRestartError("vlab.workers.status unavailable during gateway restart"), true);
  assert.equal(isGatewayRestartError(new Error("gateway timeout")), false);
});
