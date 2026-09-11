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

test("one scheduler pass shares a single Session start budget across active projects", async () => {
  const f = fixture();
  f.controls.get("P0").automaticDispatch = true;
  f.runtime.tick = async (id, options) => {
    f.seen.push({ id, cards: options.cards, dispatchMaxStarts: options.dispatchMaxStarts });
    return options.dispatchMaxStarts > 0
      ? { applied: [], dispatch: { started: [{ card: { id: `${id}-card`, labels: [`instance:${id}`], status: "running" } }] } }
      : { applied: [], dispatch: null };
  };

  const result = await runSchedulerPass({ ...f, dispatchMaxStarts: 1 });

  assert.deepEqual(f.seen.map(({ dispatchMaxStarts }) => dispatchMaxStarts), [1, 0]);
  assert.equal(result.dispatched, 1);
  assert.equal(result.dispatchMaxStarts, 1);
});
