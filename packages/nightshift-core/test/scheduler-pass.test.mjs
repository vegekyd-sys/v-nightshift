import assert from "node:assert/strict";
import test from "node:test";
import { runSchedulerPass } from "../src/scheduler-pass.mjs";

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
