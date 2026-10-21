import assert from "node:assert/strict";
import test from "node:test";
import { runSchedulerPass, schedulerCardIds } from "../src/scheduler-pass.mjs";

function fixture() {
  const instances = Array.from({ length: 48 }, (_, i) => ({ id: `P${i}`, status: "active" }));
  const controls = new Map(instances.map(({ id }) => [id, { automaticDispatch: id === "P47", fault: null }]));
  const cards = instances.map(({ id }) => ({ id: `${id}-card`, status: "ready", labels: [`instance:${id}`] }));
  const seen = [];
  let reads = 0;
  return {
    cards, controls, seen, reads: () => reads,
    store: {
      listInstances: () => instances,
      getInstanceControl: (id) => controls.get(id),
      setInstanceControl: (id, patch) => controls.set(id, { ...controls.get(id), ...patch }),
      listStageRuns: () => [{ stageId: "plan", status: "ready" }], listContentItemRuns: () => [], appendEvent() {},
    },
    workboard: { listCards() { throw new Error("Unexpected per-project board scan"); } },
    refreshCards: async () => { reads++; return cards; },
    syncContentItemsManifest: async () => {},
    runtime: { tick: async (id, options) => { seen.push({ id, cards: options.cards }); return { applied: [], dispatch: null }; } },
  };
}

test("48 projects share one board read; paused history does not block the enabled project", async () => {
  const f = fixture();
  const result = await runSchedulerPass(f);
  assert.equal(f.reads(), 1);
  assert.equal(f.seen.length, 1);
  assert.equal(result.pausedInstances, 47);
  assert.equal(f.seen[0].id, "P47");
  assert.ok(f.seen.every(({ cards }) => cards === f.cards));
  assert.deepEqual(result.warnings, []);
});

test("one snapshot timeout faults eligible projects once and a successful read clears read faults", async () => {
  const f = fixture();
  let attempts = 0;
  await assert.rejects(runSchedulerPass({ ...f, refreshCards: async () => { attempts++; throw new Error("gateway timeout"); } }), /gateway timeout/);
  assert.equal(attempts, 1);
  assert.equal(f.seen.length, 0);
  assert.equal(f.controls.get("P47").fault.operation, "snapshot");
  assert.equal(f.controls.get("P0").fault, null);
  await runSchedulerPass(f);
  assert.ok([...f.controls.values()].every((c) => c.fault === null));
});

test("a project dispatch failure does not block others or get cleared by a later snapshot-only success", async () => {
  const f = fixture();
  f.controls.get("P0").automaticDispatch = true;
  const normal = f.runtime.tick;
  f.runtime.tick = async (id, options) => { if (id === "P47") throw new Error("Agent dispatch failed"); return normal(id, options); };
  const result = await runSchedulerPass(f);
  assert.equal(f.seen.length, 1);
  assert.equal(result.warnings.length, 1);
  f.runtime.tick = normal;
  await runSchedulerPass(f);
  assert.equal(f.controls.get("P47").fault.message, "Agent dispatch failed");
  assert.equal(f.controls.get("P0").fault, null);
});


test("pausing a project still reconciles an already running native attempt without dispatching new cards", async () => {
  const f = fixture();
  f.cards[0].sessionKey = "native:P0";
  f.cards[0].execution = { status: "running" };
  f.cards[0].status = "running";
  await runSchedulerPass(f);
  assert.deepEqual(f.seen.map(({ id }) => id), ["P47", "P0"]);
  assert.equal(f.controls.get("P0").automaticDispatch, false);
});

test("one scheduler pass shares a two-Session start budget across active projects", async () => {
  const f = fixture();
  f.controls.get("P0").automaticDispatch = true;
  f.runtime.tick = async (id, options) => {
    f.seen.push({ id, cards: options.cards, dispatchMaxStarts: options.dispatchMaxStarts });
    return options.dispatchMaxStarts > 0
      ? { applied: [], dispatch: { started: [{ card: { id: `${id}-card`, labels: [`instance:${id}`], status: "running" } }] } }
      : { applied: [], dispatch: null };
  };

  const result = await runSchedulerPass({ ...f, dispatchMaxStarts: 2 });

  assert.deepEqual(f.seen.map(({ dispatchMaxStarts }) => dispatchMaxStarts), [2, 1]);
  assert.equal(result.dispatched, 2);
  assert.equal(result.dispatchMaxStarts, 2);
});

test("the default scheduler budget preserves high steady concurrency across many projects", async () => {
  const f = fixture();
  for (let index = 0; index < 9; index++) f.controls.get(`P${index}`).automaticDispatch = true;
  f.runtime.tick = async (id, options) => {
    f.seen.push({ id, dispatchMaxStarts: options.dispatchMaxStarts });
    return options.dispatchMaxStarts > 0
      ? { applied: [], dispatch: { started: [{ card: { id: `${id}-card`, labels: [`instance:${id}`], status: "running" } }] } }
      : { applied: [], dispatch: null };
  };

  const result = await runSchedulerPass(f);

  assert.equal(result.dispatchMaxStarts, 36);
  assert.equal(result.dispatched, 10);
  assert.equal(f.seen.filter(({ dispatchMaxStarts }) => dispatchMaxStarts > 0).length, 10);
});

test("a recovery probe reconciles projects without dispatching new Sessions", async () => {
  const f = fixture();
  f.runtime.tick = async (id, options) => {
    f.seen.push({ id, dispatch: options.dispatch, dispatchMaxStarts: options.dispatchMaxStarts });
    return { applied: [], dispatch: null };
  };

  const result = await runSchedulerPass({ ...f, dispatchEnabled: false });

  assert.deepEqual(f.seen, [{ id: "P47", dispatch: false, dispatchMaxStarts: 0 }]);
  assert.equal(result.dispatchEnabled, false);
  assert.equal(result.dispatched, 0);
});

test("dynamic Gateway capacity subtracts already running cards before dispatch", async () => {
  const f = fixture();
  f.cards[0].status = "running";
  f.cards[1].execution = { status: "running" };
  f.runtime.tick = async (id, options) => {
    f.seen.push({ id, dispatchMaxStarts: options.dispatchMaxStarts });
    return { applied: [], dispatch: null };
  };

  await runSchedulerPass({ ...f, dispatchMaxStarts: 10, maxWorkboardActive: 3 });

  assert.deepEqual(f.seen, [{ id: "P47", dispatchMaxStarts: 1 }]);
});

test("returns the earliest non-blocking dispatch-window retry", async () => {
  const f = fixture();
  f.controls.get("P0").automaticDispatch = true;
  f.runtime.tick = async (id) => ({
    applied: [],
    dispatch: { retryAfterMs: id === "P0" ? 8_000 : 12_000, started: [] },
  });

  const result = await runSchedulerPass(f);

  assert.equal(result.retryAfterMs, 8_000);
});


test("refreshes newly materialized downstream IDs in the same pass", async () => {
  const f = fixture();
  let created = false;
  const scopes = [];
  f.store.listStageRuns = id => [{ cardId: `${id}-card`, status: "ready" }, ...(id === "P47" && created ? [{ cardId: "new-child", status: "ready" }] : [])];
  f.refreshCards = async options => { scopes.push(options.cardIds); return f.cards; };
  f.runtime.tick = async () => { created = true; return { applied: [{card: {id: "new-child"}}], dispatch: null }; };
  await runSchedulerPass(f);
  assert.ok(scopes.at(-1).includes("new-child"));
});

test("occupied slots are not reported as starts when no task launched", async () => {
  const f = fixture();
  f.cards[0].status = "running";
  const result = await runSchedulerPass({...f, dispatchMaxStarts: 3, maxWorkboardActive: 1});
  assert.equal(result.dispatched, 0);
});

import { instanceCardIds, visibleCardIds } from "../src/scheduler-pass.mjs";

test("project and visible card ids come from recorded runs, never from a board scan", () => {
  const runs = {
    A: [{ cardId: "a1" }, { cardId: "a2" }, { cardId: "a1" }, { cardId: null }],
    B: [{ cardId: "b1" }],
    C: [{ cardId: "c1" }],
  };
  const store = {
    listInstances: () => [{ id: "A", status: "active" }, { id: "B", status: "paused" }, { id: "C", status: "archived" }],
    listStageRuns: (id) => runs[id].slice(0, 1),
    listContentItemRuns: (id) => runs[id].slice(1),
  };
  assert.deepEqual(instanceCardIds(store, "A"), ["a1", "a2"]);
  assert.deepEqual(instanceCardIds(store, "C"), ["c1"]);
  // Archived projects stay on the native board but are never read by default.
  assert.deepEqual(visibleCardIds(store).sort(), ["a1", "a2", "b1"]);
});

// On V the scheduler read 319 cards every few seconds. 168 of them belonged to
// nine paused or archived projects held in by a single stale "running" record,
// and 240 had already reached a terminal state.
test("a routine pass reads only what can change; the repair pass still reads everything", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  const fresh = new Date(now - 60_000).toISOString();
  const ancient = new Date(now - 6 * 3600_000).toISOString();
  const runs = {
    LIVE: [
      { status: "running", cardId: "live-running", updatedAt: fresh },
      { status: "done", cardId: "live-done", updatedAt: ancient },
      { status: "ready", cardId: "live-ready", updatedAt: ancient },
      { status: "blocked", cardId: "live-blocked", updatedAt: ancient },
    ],
    STALE: [
      { status: "running", cardId: "stale-running", updatedAt: ancient },
      { status: "done", cardId: "stale-done", updatedAt: ancient },
    ],
    DRAINING: [{ status: "running", cardId: "draining", updatedAt: fresh }],
  };
  const store = {
    listInstances: () => [
      { id: "LIVE", status: "active" },
      { id: "STALE", status: "archived" },
      { id: "DRAINING", status: "paused" },
    ],
    listStageRuns: (id) => runs[id] ?? [],
    listContentItemRuns: () => [],
  };
  const routine = schedulerCardIds(store, null, { fullSweep: false, nowMs: now });
  assert.deepEqual(routine.sort(), ["draining", "live-blocked", "live-ready", "live-running"],
    "settled cards and the stale project are left out, but recovery and work still draining are not");
  const repair = schedulerCardIds(store, null, { fullSweep: true, nowMs: now });
  assert.deepEqual(repair.sort(), ["draining", "live-blocked", "live-done", "live-ready", "live-running"],
    "the repair sweep still sees every card of a project it schedules");
  assert.ok(!repair.includes("stale-running"), "a run that has not moved for hours is not work in flight");
});

// An approval card is not a run, so the run records never mention it. The
// ledger is its only record, and the scheduler's card scope is what the
// idempotency scan gets to look at. Leave the ledger out and every pass fails
// to find the card it created last pass and asks the board for another one: on
// V this produced 4,628 duplicate approval cards for one project in 15 hours.
test("the scheduler reads the approval cards its projects own, not only their runs", () => {
  const store = {
    listInstances: () => [{ id: "NS-VIG", status: "active" }],
    listStageRuns: () => [{ stageId: "produce", status: "done", cardId: "run-card" }],
    listContentItemRuns: () => [],
    listActionCardIds: (instanceId) => instanceId === "NS-VIG" ? ["approval-card"] : [],
  };
  assert.deepEqual(schedulerCardIds(store, null, { fullSweep: true }).sort(), ["approval-card", "run-card"]);
  // A routine pass drops terminal runs but must still carry the approval card,
  // which is exactly the card that keeps being duplicated.
  assert.deepEqual(schedulerCardIds(store, null, { fullSweep: false }), ["approval-card"]);
});

test("a project with only an approval card outstanding is still in the scheduler scope", () => {
  const store = {
    listInstances: () => [{ id: "NS-VIG", status: "active" }],
    listStageRuns: () => [],
    listContentItemRuns: () => [],
    listActionCardIds: () => ["approval-card"],
  };
  assert.deepEqual(schedulerCardIds(store, null, { fullSweep: false }), ["approval-card"]);
});

test("the action ledger does not put terminal run cards back into every routine read", () => {
  const runs = [
    { status: "done", cardId: "done" },
    { status: "blocked", cardId: "blocked" },
    { status: "cancelled", cardId: "cancelled" },
    { status: "running", cardId: "running" },
    { status: "ready", cardId: "ready" },
  ];
  const store = {
    listInstances: () => [{ id: "NS-live", status: "active" }],
    listStageRuns: () => runs,
    listContentItemRuns: () => [],
    // Runtime records every created card, not just approval cards.
    listActionCardIds: () => [...runs.map(run => run.cardId), "approval-without-run"],
  };
  assert.deepEqual(schedulerCardIds(store, null, { fullSweep: false }).sort(), ["approval-without-run", "blocked", "ready", "running"]);
  assert.equal(schedulerCardIds(store, null, { fullSweep: true }).length, 6, "repair must still see terminal cards");
});

test("a blocked card's automatic retry stays in the routine scope", () => {
  const store = {
    listInstances: () => [{ id: "NS-live", status: "active" }],
    listStageRuns: () => [{ status: "blocked", cardId: "retry", failure: { automaticRetry: true, nextRetryAt: new Date().toISOString() } }],
    listContentItemRuns: () => [{ status: "done", cardId: "done" }],
    listActionCardIds: () => ["retry", "done", "approval"],
  };
  assert.deepEqual(schedulerCardIds(store, null, { fullSweep: false }).sort(), ["approval", "retry"]);
});

test("a store without the ledger still works", () => {
  const store = {
    listInstances: () => [{ id: "NS-VIG", status: "active" }],
    listStageRuns: () => [{ stageId: "produce", status: "ready", cardId: "run-card" }],
    listContentItemRuns: () => [],
  };
  assert.deepEqual(schedulerCardIds(store, null, { fullSweep: false }), ["run-card"]);
});

// The seam that actually failed on V: the scheduler hands one shared card list
// to every project tick, and that list is what the idempotency scan sees. If
// the approval card is missing from it, the tick cannot find the card it made
// last pass, so it makes another one.
test("the shared card list handed to each project tick contains its approval card", async () => {
  const requested = [];
  const cards = [{ id: "approval-card", status: "review", labels: ["instance:NS-VIG", "nightshift:approval"] }];
  const seen = [];
  await runSchedulerPass({
    store: {
      listInstances: () => [{ id: "NS-VIG", status: "active" }],
      getInstanceControl: () => ({ automaticDispatch: true, fault: null }),
      setInstanceControl() {},
      listStageRuns: () => [],
      listContentItemRuns: () => [],
      listActionCardIds: () => ["approval-card"],
      appendEvent() {},
    },
    workboard: { listCards() { throw new Error("Unexpected whole-board scan"); } },
    refreshCards: async ({ cardIds }) => { requested.push(...cardIds); return cards; },
    syncContentItemsManifest: async () => {},
    runtime: { tick: async (id, options) => { seen.push(options.cards); return { applied: [], dispatch: null }; } },
  });
  assert.ok(requested.includes("approval-card"), "the pass must read the approval card");
  assert.deepEqual(seen[0].map((card) => card.id), ["approval-card"]);
});

// On V (2026-09-29) seven projects shared a handful of starts, and the store
// lists projects by last update: the newest batches took the starts while the
// one started at 11:49 sat queued. Starts go by arrival instead.
function arrivalFixture({ budget }) {
  // Listed newest first, the way the store orders by updated_at.
  const instances = [
    { id: "LATE", status: "active", createdAt: "2026-09-29T07:55:00.000Z" },
    { id: "MIDDLE", status: "active", createdAt: "2026-09-29T07:10:00.000Z" },
    { id: "EARLY", status: "active", createdAt: "2026-09-29T03:49:00.000Z" },
  ];
  const controls = new Map(instances.map(({ id }) => [id, { automaticDispatch: true, fault: null }]));
  let cards = instances.flatMap(({ id }) => [1, 2].map((n) => ({ id: `${id}-${n}`, status: "ready", labels: [`instance:${id}`] })));
  const starts = [];
  return {
    starts,
    dispatchMaxStarts: budget,
    maxWorkboardActive: budget,
    store: {
      listInstances: () => instances,
      getInstanceControl: (id) => controls.get(id),
      setInstanceControl: (id, patch) => controls.set(id, { ...controls.get(id), ...patch }),
      listStageRuns: () => [{ stageId: "plan", status: "ready" }], listContentItemRuns: () => [], appendEvent() {},
    },
    workboard: { listCards() { throw new Error("Unexpected per-project board scan"); } },
    refreshCards: async () => cards,
    syncContentItemsManifest: async () => {},
    runtime: {
      // A project runs at most two cards at once, as its Workflow allows.
      tick: async (id, options) => {
        const ready = cards.filter((card) => card.labels.includes(`instance:${id}`) && card.status === "ready")
          .slice(0, Math.min(2, options.dispatchMaxStarts));
        for (const card of ready) { card.status = "running"; starts.push(id); }
        cards = cards.map((card) => ({ ...card }));
        return { applied: [], dispatch: ready.length ? { started: ready.map((card) => ({ card })) } : null };
      },
    },
  };
}

test("starts go to projects in the order they arrived, not the order they last moved", async () => {
  const f = arrivalFixture({ budget: 3 });
  await runSchedulerPass(f);
  assert.deepEqual(f.starts, ["EARLY", "EARLY", "MIDDLE"]);
});

test("a project that arrives when no start is left waits, and the board is told its place", async () => {
  const f = arrivalFixture({ budget: 2 });
  const result = await runSchedulerPass(f);
  assert.deepEqual(f.starts, ["EARLY", "EARLY"]);
  assert.deepEqual(result.queue.get("EARLY"), { state: "running" });
  assert.deepEqual(result.queue.get("MIDDLE"), { state: "queued", position: 1 });
  assert.deepEqual(result.queue.get("LATE"), { state: "queued", position: 2 });
});

test("a project waiting on a person does not hold its place in the queue", async () => {
  const f = arrivalFixture({ budget: 2 });
  const cards = await f.refreshCards();
  for (const card of cards.filter((entry) => entry.labels.includes("instance:EARLY"))) card.status = "blocked";
  const result = await runSchedulerPass(f);
  assert.deepEqual(f.starts, ["MIDDLE", "MIDDLE"]);
  assert.deepEqual(result.queue.get("EARLY"), { state: "waiting" });
  assert.deepEqual(result.queue.get("LATE"), { state: "queued", position: 1 });
});

// An operator or an Agent can put a project ahead of the queue (priority);
// projects nobody set keep first come, first delivered.
test("a project given priority jumps the queue; the rest keep their arrival order", async () => {
  const f = arrivalFixture({ budget: 3 });
  f.store.setInstanceControl("LATE", { priority: 1 });
  const result = await runSchedulerPass(f);
  assert.deepEqual(f.starts, ["LATE", "LATE", "EARLY"]);
  assert.deepEqual(result.queue.get("LATE"), { state: "running", priority: 1 });
  assert.deepEqual(result.queue.get("MIDDLE"), { state: "queued", position: 1 });
});

test("a project put last lets every other project go first", async () => {
  const f = arrivalFixture({ budget: 2 });
  f.store.setInstanceControl("EARLY", { priority: -1 });
  const result = await runSchedulerPass(f);
  assert.deepEqual(f.starts, ["MIDDLE", "MIDDLE"]);
  assert.deepEqual(result.queue.get("LATE"), { state: "queued", position: 1 });
  assert.deepEqual(result.queue.get("EARLY"), { state: "queued", position: 2, priority: -1 });
});

test("an explicit order puts projects ahead in that order; clearing it restores arrival", async () => {
  const f = arrivalFixture({ budget: 2 });
  f.store.setInstanceControl("MIDDLE", { priority: 2 });
  f.store.setInstanceControl("LATE", { priority: 1 });
  let result = await runSchedulerPass(f);
  assert.deepEqual(f.starts, ["MIDDLE", "MIDDLE"]);
  assert.deepEqual(result.queue.get("LATE"), { state: "queued", position: 1, priority: 1 });
  const g = arrivalFixture({ budget: 2 });
  g.store.setInstanceControl("MIDDLE", { priority: null });
  result = await runSchedulerPass(g);
  assert.deepEqual(g.starts, ["EARLY", "EARLY"]);
});

test("a Gateway suspending or restarting is no project's fault", async () => {
  // V, 2026-09-30 21:16: a release suspended the Gateway 24 s before its
  // shutdown broadcast; the refused reads were recorded against projects.
  const f = fixture();
  await assert.rejects(
    runSchedulerPass({ ...f, refreshCards: async () => { throw new Error("workboard.cards.list unavailable during gateway suspension"); } }),
    /during gateway suspension/,
  );
  assert.ok([...f.controls.values()].every((c) => c.fault === null));
});

// Lending an idle board: P0 runs its Workflow's four cards with nothing ready;
// P1 is the project that may or may not be waiting.
function idleFixture({ p1Cards = [], p0Extra = [] } = {}) {
  const instances = [{ id: "P0", status: "active", createdAt: "1" }, { id: "P1", status: "active", createdAt: "2" }];
  const controls = new Map(instances.map(({ id }) => [id, { automaticDispatch: true, fault: null }]));
  const cards = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `P0-run-${i}`, status: "running", labels: ["instance:P0"] })),
    ...p0Extra, ...p1Cards,
  ];
  const seen = [];
  return {
    seen,
    store: {
      listInstances: () => instances,
      getInstanceControl: (id) => controls.get(id),
      setInstanceControl: (id, patch) => controls.set(id, { ...controls.get(id), ...patch }),
      listStageRuns: () => [], listContentItemRuns: () => [], appendEvent() {},
    },
    workboard: {},
    refreshCards: async () => cards,
    syncContentItemsManifest: async () => {},
    runtime: {
      projectConcurrency: () => 4,
      tick: async (id, options) => { seen.push({ id, idleConcurrency: options.idleConcurrency ?? 0 }); return { applied: [], dispatch: null }; },
    },
  };
}

test("spare starts with no project waiting lend each project the idle limit", async () => {
  const f = idleFixture();
  const result = await runSchedulerPass({ ...f, dispatchMaxStarts: 3, idleProjectConcurrency: 8 });
  assert.deepEqual(f.seen, [{ id: "P0", idleConcurrency: 8 }, { id: "P1", idleConcurrency: 8 }]);
  assert.equal(result.idleConcurrency, 8);
});

test("a project waiting within its own limit ends the lending for everyone", async () => {
  const f = idleFixture({ p1Cards: [{ id: "P1-plan", status: "ready", labels: ["instance:P1"] }] });
  const result = await runSchedulerPass({ ...f, dispatchMaxStarts: 3, idleProjectConcurrency: 8 });
  assert.deepEqual(f.seen.map(({ idleConcurrency }) => idleConcurrency), [0, 0]);
  assert.equal(result.idleConcurrency, 0);
});

test("a lent card still waiting does not count as a project owed a start", async () => {
  // P0 already runs its four and holds a fifth, created while the board was idle.
  const f = idleFixture({ p0Extra: [{ id: "P0-lent", status: "ready", labels: ["instance:P0"] }] });
  await runSchedulerPass({ ...f, dispatchMaxStarts: 3, idleProjectConcurrency: 8 });
  assert.deepEqual(f.seen.map(({ idleConcurrency }) => idleConcurrency), [8, 8]);
});

test("no lending without spare starts, with dispatch held, or when it is turned off", async () => {
  for (const options of [{ dispatchMaxStarts: 3, maxWorkboardActive: 4 }, { dispatchEnabled: false }, { idleProjectConcurrency: 0 }]) {
    const f = idleFixture();
    await runSchedulerPass({ ...f, dispatchMaxStarts: 3, idleProjectConcurrency: 8, ...options });
    assert.ok(f.seen.every(({ idleConcurrency }) => idleConcurrency === 0), JSON.stringify(options));
  }
});
