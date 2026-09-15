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
  assert.equal(guard.recordProbe({ latencyMs: 100, running: 3 }).dispatchAllowed, false);
  now += 5_000;
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


test("an old green probe cannot authorize a start after Gateway conditions change", () => {
  let now = 1_000;
  const guard = new DispatchPressureGuard({now: () => now, probeMaxAgeMs: 5_000});
  guard.recordProbe({latencyMs: 80});
  now += 5_001;
  assert.equal(guard.snapshot().availableStarts, 0);
  assert.equal(guard.snapshot().dispatchAllowed, false);
});


test("reserves ordinary Session capacity using the shared Worker occupancy", () => {
  const guard=new DispatchPressureGuard({initialMaxActive:36});
  const pool={capacity:45,active:44,queued:0};
  assert.equal(guard.recordProbe({latencyMs:20,running:30,workerPool:pool}).availableStarts,1);
  assert.equal(guard.recordProbe({latencyMs:20,running:30,workerPool:{...pool,active:45}}).availableStarts,0);
  assert.equal(guard.recordProbe({latencyMs:20,running:36,workerPool:{...pool,active:36}}).availableStarts,0);
  assert.equal(guard.recordProbe({latencyMs:20,running:10,workerPool:{...pool,active:15,queued:1}}).availableStarts,0);
});

test("foreground load cannot be learned as an idle latency baseline", () => {
  const guard=new DispatchPressureGuard();
  const probe=guard.recordProbe({latencyMs:600,running:0,workerPool:{capacity:45,active:4,queued:0}});
  assert.equal(probe.baselineLatencyMs,null);
  assert.equal(probe.dispatchAllowed,false);
});


test("periodic yellow maintenance does not starve an idle pool after two green probes", () => {
  let now=1_000;
  const guard=new DispatchPressureGuard({now:()=>now});
  guard.recordProbe({latencyMs:20});
  for(let cycle=0;cycle<4;cycle++){
    now+=30_000;
    assert.equal(guard.recordProbe({latencyMs:600,running:1}).dispatchAllowed,false);
    assert.equal(guard.snapshot(0).holdUntil,null);
    now+=5_000;
    assert.equal(guard.recordProbe({latencyMs:20,running:1}).dispatchAllowed,false);
    now+=5_000;
    assert.equal(guard.recordProbe({latencyMs:20,running:1}).availableStarts,1);
    guard.consumeStarts(1);
    assert.equal(guard.snapshot(1).availableStarts,0);
  }
});

test("yellow during red recovery preserves the full red deadline without extending it", () => {
  let now=1_000;
  const guard=new DispatchPressureGuard({now:()=>now});
  const red=guard.recordProbe({latencyMs:1500,running:1});
  now+=50_000;
  assert.equal(guard.recordProbe({latencyMs:600,running:1}).holdUntil,red.holdUntil);
  now+=5_000;
  assert.equal(guard.recordProbe({latencyMs:20,running:1}).availableStarts,0);
  now+=5_000;
  assert.equal(guard.recordProbe({latencyMs:20,running:1}).availableStarts,0);
  now+=5_000;
  assert.equal(guard.recordProbe({latencyMs:20,running:1}).availableStarts,1);
});


test("healthy recovery admits one new job beyond jobs that kept running during red cooldown", () => {
  let now=1000;const guard=new DispatchPressureGuard({now:()=>now,initialMaxActive:20});
  assert.equal(guard.recordProbe({latencyMs:1500,running:20}).targetMaxActive,10);
  now+=60000;assert.equal(guard.recordProbe({latencyMs:20,running:20}).availableStarts,0);
  now+=5000;const recovered=guard.recordProbe({latencyMs:20,running:20});
  assert.equal(recovered.targetMaxActive,21);assert.equal(recovered.availableStarts,1);
  guard.consumeStarts(1);assert.equal(guard.snapshot(21).availableStarts,0);
  guard.recordProbe({latencyMs:1500,running:36});now+=60000;guard.recordProbe({latencyMs:20,running:36});now+=5000;
  assert.equal(guard.recordProbe({latencyMs:20,running:36}).availableStarts,0);
  assert.equal(guard.snapshot(36).targetMaxActive,36);
});

test("sustained healthy headroom recovers one start before a periodic red cooldown expires", () => {
  let now = 0;
  const guard = new DispatchPressureGuard({ initialMaxActive: 12, now: () => now });
  const pool = { capacity: 45, active: 12, queued: 0 };
  guard.recordProbe({ latencyMs: 1_500, running: 12, workerPool: pool });
  for (now = 5_000; now <= 15_000; now += 5_000) {
    assert.equal(guard.recordProbe({ latencyMs: 80, running: 12, workerPool: pool }).availableStarts, 0);
  }
  const recovered = guard.recordProbe({ latencyMs: 80, running: 12, workerPool: pool });
  assert.equal(recovered.targetMaxActive, 13);
  assert.equal(recovered.availableStarts, 1);
  assert.equal(recovered.holdUntil, null);
  guard.consumeStarts(1);
  assert.equal(guard.snapshot(13).availableStarts, 0);
});

test("rapid probes and interrupted healthy observations cannot shorten red cooldown", () => {
  for (const interruption of ["rapid", "yellow", "red", "stale", "queued", "reserve"]) {
    let now = 0;
    const guard = new DispatchPressureGuard({ now: () => now });
    const pool = { capacity: 45, active: 10, queued: 0 };
    guard.recordProbe({ latencyMs: 1_500, running: 10, workerPool: pool });
    for (let i = 1; i <= 3; i++) {
      now = i * (interruption === "rapid" ? 1_000 : 5_000);
      guard.recordProbe({ latencyMs: 80, running: 10, workerPool: pool });
    }
    now += interruption === "stale" ? 10_001 : 1_000;
    const latencyMs = interruption === "yellow" ? 500 : interruption === "red" ? 1_500 : 80;
    const workerPool = interruption === "queued" ? { ...pool, queued: 1 }
      : interruption === "reserve" ? { ...pool, active: 36 } : pool;
    assert.equal(guard.recordProbe({ latencyMs, running: 10, workerPool }).availableStarts, 0, interruption);
    now += 1_000;
    assert.equal(guard.recordProbe({ latencyMs: 80, running: 10, workerPool: pool }).availableStarts, 0, interruption);
  }
});

test("periodic red pauses permit bounded progress with healthy intervals while sustained red never starts", () => {
  let now = 0, running = 3;
  const guard = new DispatchPressureGuard({ now: () => now });
  for (let cycle = 0; cycle < 40; cycle++) {
    now = cycle * 60_000;
    const pool = { capacity: 45, active: running, queued: 0 };
    assert.equal(guard.recordProbe({ latencyMs: 1_500, running, workerPool: pool }).availableStarts, 0);
    for (let sample = 0; sample < 4; sample++) {
      now += 5_000;
      const result = guard.recordProbe({ latencyMs: 80, running, workerPool: pool });
      if (result.availableStarts) { running++; guard.consumeStarts(1); }
      assert(running <= 36);
    }
  }
  assert.equal(running, 36);
  for (let sample = 0; sample < 20; sample++) {
    now += 5_000;
    assert.equal(guard.recordProbe({ latencyMs: 1_500, running: 0, workerPool: { capacity: 45, active: 0, queued: 0 } }).availableStarts, 0);
  }
});
