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

// The pool hands a whole Worker to each Session before it packs a second one
// into any process, so N running cards hold N Workers, not N/sessionsPerWorker.
// Reserving interactive room in Session slots therefore protects a resource
// that is not the bottleneck: on V, 7 cards held 7 of 11 live Workers and left
// exactly one free, while this guard still computed 45 - 9 - 7 = 29 spare.
test("interactive headroom is counted in Workers, not Session slots", () => {
  const guard = new DispatchPressureGuard({ initialMaxActive: 30, maxActive: 30, reservedInteractiveWorkers: 3 });
  // A pool of 15 Workers with 11 alive and 10 owned: one Worker is free, but
  // the Session arithmetic says 45 - 9 - 7 = 29.
  guard.recordProbe({
    latencyMs: 80,
    running: 7,
    workerPool: { capacity: 45, active: 10, queued: 0, workerCapacity: 15, workersBusy: 10 },
  });
  const snapshot = guard.snapshot(7);
  // 15 Workers - 3 reserved - 10 busy = 2 left. The Session arithmetic would
  // have said 29, so assert the Worker number itself, not availableStarts,
  // which the start-credit budget clamps to a small value either way.
  assert.equal(snapshot.workerHeadroom, 2);
});

test("a pool with no free Workers admits nothing even when Session slots look free", () => {
  const guard = new DispatchPressureGuard({ initialMaxActive: 30, maxActive: 30, reservedInteractiveWorkers: 3 });
  guard.recordProbe({
    latencyMs: 80,
    running: 12,
    workerPool: { capacity: 45, active: 15, queued: 0, workerCapacity: 15, workersBusy: 15 },
  });
  assert.equal(guard.snapshot(12).availableStarts, 0);
});

test("a pool that does not report Worker occupancy keeps the Session arithmetic", () => {
  const guard = new DispatchPressureGuard({ initialMaxActive: 30, maxActive: 30 });
  guard.recordProbe({ latencyMs: 80, running: 3, workerPool: { capacity: 45, active: 3, queued: 0 } });
  assert.equal(guard.snapshot(3).workerHeadroom, null);
  assert.equal(guard.snapshot(3).availableStarts > 0, true);
});

// The Agent DB write lease saturated on V (2026-09-24 10:21) while Worker
// headroom and Gateway latency both read green; these cases are that morning.
const RED_LEASE = { level: "red", blocked: true, reason: "2 Agent DB lease timeout(s) in 120s", userHarm: false };
const HARMED = { ...RED_LEASE, userHarm: true, reason: "2 Agent DB lease timeout(s) in 120s, 2 in a person's conversation" };

test("a lease timeout halts starts even when latency and Workers look healthy", () => {
  const guard = new DispatchPressureGuard({ initialMaxActive: 8 });
  const pool = { capacity: 45, active: 8, queued: 0, workerCapacity: 15, workersBusy: 8 };
  const pressure = guard.recordProbe({ latencyMs: 40, running: 8, workerPool: pool, agentDbPressure: RED_LEASE });
  assert.equal(pressure.lastProbe.level, "red");
  assert.match(pressure.lastProbe.error, /lease timeout/);
  assert.equal(pressure.targetMaxActive, 4);
  assert.equal(pressure.dispatchAllowed, false);
  assert.equal(pressure.agentDbPressure, RED_LEASE);
});

test("slow lease admission stops new starts but keeps the running cards", () => {
  const guard = new DispatchPressureGuard({ initialMaxActive: 8 });
  const pressure = guard.recordProbe({
    latencyMs: 40, running: 5, agentDbPressure: { level: "yellow", reason: "4 slow Agent DB writer admissions in 120s" },
  });
  assert.equal(pressure.lastProbe.level, "yellow");
  assert.match(pressure.lastProbe.error, /slow Agent DB writer/);
  assert.equal(pressure.targetMaxActive, 5);
  assert.equal(pressure.availableStarts, 0);
});

test("a person's cut reply holds dispatch for the full harm cooldown", () => {
  let now = 0;
  const guard = new DispatchPressureGuard({ initialMaxActive: 12, now: () => now, userHarmCooldownMs: 900_000 });
  const pool = { capacity: 45, active: 12, queued: 0 };
  guard.recordProbe({ latencyMs: 40, running: 12, workerPool: pool, agentDbPressure: HARMED });
  // The same run of quiet probes that ends an ordinary red early (see above).
  for (now = 5_000; now <= 60_000; now += 5_000) {
    assert.equal(guard.recordProbe({ latencyMs: 80, running: 12, workerPool: pool }).availableStarts, 0, `at ${now}`);
  }
  now = 899_000;
  assert.equal(guard.recordProbe({ latencyMs: 80, running: 12, workerPool: pool }).availableStarts, 0);
  // The hold is over, but the twelve cards that cut the reply are still above
  // the remembered ceiling (12 × 0.7 = 8): nothing new starts until they drain.
  now = 905_000;
  guard.recordProbe({ latencyMs: 80, running: 12, workerPool: pool });
  now = 910_000;
  assert.equal(guard.recordProbe({ latencyMs: 80, running: 12, workerPool: pool }).availableStarts, 0);
  now = 915_000;
  guard.recordProbe({ latencyMs: 80, running: 7, workerPool: pool });
  now = 920_000;
  assert.equal(guard.recordProbe({ latencyMs: 80, running: 7, workerPool: pool }).availableStarts, 1);
});

test("a cut reply during a host sample warm-up is still red and holds for the harm cooldown", () => {
  let now = 0;
  const guard = new DispatchPressureGuard({ initialMaxActive: 12, now: () => now, userHarmCooldownMs: 900_000 });
  const pool = { capacity: 45, active: 12, queued: 0 };
  const warming = { enabled: true, blocked: true, warmingUp: true, reason: "host sample warming up" };
  const pressure = guard.recordProbe({ running: 12, workerPool: pool, hostPressure: warming, agentDbPressure: HARMED });
  assert.equal(pressure.lastProbe.level, "red");
  assert.equal(pressure.targetMaxActive, 6);
  assert.equal(pressure.recoveringPressure, true);
  now = 899_000;
  assert.equal(guard.recordProbe({ latencyMs: 80, running: 12, workerPool: pool }).availableStarts, 0);
});

// Replays V on 2026-09-28: ten cards cut a person's reply at 14:55, recovery
// at 15:10 went straight back to ten, and two more replies were cut at 15:22.
test("recovery after a cut reply stays below the concurrency that caused it and climbs one card per step", () => {
  let now = 0;
  const guard = new DispatchPressureGuard({ initialMaxActive: 12, now: () => now, userHarmCooldownMs: 900_000, harmCeilingStepMs: 300_000 });
  const pool = { capacity: 45, active: 10, queued: 0 };
  const harmed = { ...HARMED, interactiveRunIds: ["chat-1"] };
  assert.equal(guard.recordProbe({ latencyMs: 40, running: 10, workerPool: pool, agentDbPressure: harmed }).harmCeiling, 7);
  // During the hold the cards drain; the ceiling does not relax yet.
  let target = 0;
  for (now = 900_000; now < 1_200_000; now += 5_000) target = guard.recordProbe({ latencyMs: 80, running: 3, workerPool: pool }).targetMaxActive;
  assert.equal(target, 7, "capped at 70% of the ten cards, however many green probes arrive");
  now = 1_199_000;
  assert.equal(guard.snapshot(3).harmCeiling, 7);
  for (now = 1_200_000; now < 1_500_000; now += 5_000) target = guard.recordProbe({ latencyMs: 80, running: 3, workerPool: pool }).targetMaxActive;
  assert.equal(target, 8, "one more card after five quiet minutes");
  now = 900_000 + 300_000 * 29;
  guard.recordProbe({ latencyMs: 80, running: 3, workerPool: pool });
  assert.equal(guard.snapshot(3).harmCeiling, null, "the ceiling is gone once it climbs back to maxActive");
});

test("one cut reply lowers the ceiling once even while the probe keeps reporting it and cards drain", () => {
  let now = 0;
  const guard = new DispatchPressureGuard({ initialMaxActive: 12, now: () => now });
  const pool = { capacity: 45, active: 10, queued: 0 };
  const harmed = { ...HARMED, interactiveRunIds: ["chat-1"] };
  guard.recordProbe({ latencyMs: 40, running: 10, workerPool: pool, agentDbPressure: harmed });
  for (const running of [8, 6, 4, 2]) {
    now += 15_000;
    guard.recordProbe({ latencyMs: 40, running, workerPool: pool, agentDbPressure: harmed });
  }
  assert.equal(guard.snapshot(2).harmCeiling, 7);
  // A second, separate cut reply lowers it further.
  now += 15_000;
  guard.recordProbe({ latencyMs: 40, running: 6, workerPool: pool, agentDbPressure: { ...HARMED, interactiveRunIds: ["chat-1", "chat-2"] } });
  assert.equal(guard.snapshot(6).harmCeiling, 4);
});

test("without run ids a harm counts once per hold", () => {
  let now = 0;
  const guard = new DispatchPressureGuard({ initialMaxActive: 12, now: () => now });
  guard.recordProbe({ latencyMs: 40, running: 10, agentDbPressure: HARMED });
  now = 60_000;
  guard.recordProbe({ latencyMs: 40, running: 2, agentDbPressure: HARMED });
  assert.equal(guard.snapshot(2).harmCeiling, 7);
});

test("an ordinary lease timeout sets no ceiling", () => {
  const guard = new DispatchPressureGuard({ initialMaxActive: 12 });
  assert.equal(guard.recordProbe({ latencyMs: 40, running: 10, agentDbPressure: RED_LEASE }).harmCeiling, null);
});

test("an ordinary lease timeout keeps the ordinary red cooldown", () => {
  let now = 0;
  const guard = new DispatchPressureGuard({ initialMaxActive: 12, now: () => now, userHarmCooldownMs: 900_000 });
  const pool = { capacity: 45, active: 12, queued: 0 };
  guard.recordProbe({ latencyMs: 40, running: 12, workerPool: pool, agentDbPressure: RED_LEASE });
  for (now = 5_000; now <= 15_000; now += 5_000) guard.recordProbe({ latencyMs: 80, running: 12, workerPool: pool });
  assert.equal(guard.recordProbe({ latencyMs: 80, running: 12, workerPool: pool }).availableStarts, 1);
});

test("an unobserved lease never blocks dispatch by itself", () => {
  const guard = new DispatchPressureGuard({ initialMaxActive: 3 });
  const pressure = guard.recordProbe({
    latencyMs: 40, running: 0, agentDbPressure: { enabled: true, level: "unknown", blocked: false, reason: "probe failed" },
  });
  assert.equal(pressure.lastProbe.level, "green");
  assert.equal(pressure.dispatchAllowed, true);
});

// V, 2026-10-30 13:43: 30 s of pressure at 5 s probes took the target 18 -> 1.
test("reds inside one cooldown halve the target once and only extend the hold", () => {
  let now = 0;
  const guard = new DispatchPressureGuard({ now: () => now, initialMaxActive: 18 });
  const pool = { capacity: 45, active: 16, queued: 0 };
  let snapshot = guard.recordProbe({ latencyMs: 1_500, running: 16, workerPool: pool });
  assert.equal(snapshot.targetMaxActive, 9);
  const firstHold = Date.parse(snapshot.holdUntil);
  for (now = 5_000; now <= 30_000; now += 5_000) snapshot = guard.recordProbe({ latencyMs: 1_500, running: 16, workerPool: pool });
  assert.equal(snapshot.targetMaxActive, 9, "five more reds in the same cooldown");
  assert(Date.parse(snapshot.holdUntil) > firstHold, "each red still pushes the hold out");
  assert.equal(snapshot.availableStarts, 0);
  for (now = 35_000; now < 60_000; now += 5_000) snapshot = guard.recordProbe({ latencyMs: 1_500, running: 16, workerPool: pool });
  assert.equal(snapshot.targetMaxActive, 9);
  // Sustained reds keep pushing the hold out; they still halve once a minute.
  const targets = [];
  for (now = 60_000; now <= 180_000; now += 5_000) targets.push(guard.recordProbe({ latencyMs: 1_500, running: 16, workerPool: pool }).targetMaxActive);
  assert.deepEqual([targets[0], targets[12], targets[24]], [4, 2, 1], "18 -> 9 -> 4 -> 2 -> 1 over four minutes, not four probes");
  assert.equal(new Set(targets.slice(1, 12)).size, 1, "nothing in between");
});
