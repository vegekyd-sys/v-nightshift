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

test("48 projects share one board read and the enabled project runs first", async () => {
  const f = fixture();
  const result = await runSchedulerPass(f);
  assert.equal(f.reads(), 1);
  assert.equal(f.seen.length, 48);
  assert.equal(f.seen[0].id, "P47");
  assert.ok(f.seen.every(({ cards }) => cards === f.cards));
  assert.deepEqual(result.warnings, []);
});

test("one snapshot timeout faults all projects once and a successful read clears read faults even when dispatch is paused", async () => {
  const f = fixture();
  let attempts = 0;
  await assert.rejects(runSchedulerPass({ ...f, refreshCards: async () => { attempts++; throw new Error("gateway timeout"); } }), /gateway timeout/);
  assert.equal(attempts, 1);
  assert.equal(f.seen.length, 0);
  assert.ok([...f.controls.values()].every((c) => c.fault.operation === "snapshot"));
  await runSchedulerPass(f);
  assert.ok([...f.controls.values()].every((c) => c.fault === null));
});

test("a project dispatch failure does not block others or get cleared by a later snapshot-only success", async () => {
  const f = fixture();
  const normal = f.runtime.tick;
  f.runtime.tick = async (id, options) => { if (id === "P47") throw new Error("Agent dispatch failed"); return normal(id, options); };
  const result = await runSchedulerPass(f);
  assert.equal(f.seen.length, 47);
  assert.equal(result.warnings.length, 1);
  f.runtime.tick = normal;
  await runSchedulerPass(f);
  assert.equal(f.controls.get("P47").fault.message, "Agent dispatch failed");
  assert.equal(f.controls.get("P0").fault, null);
});
