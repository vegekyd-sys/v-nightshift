import assert from "node:assert/strict";
import test from "node:test";
import { tickWithFaultProjection } from "../src/scheduler-state.mjs";

test("projects expose dispatch failure immediately and clear it after a successful scoped retry", async () => {
  const controls = new Map([["A", { automaticDispatch: true, fault: null }], ["B", { automaticDispatch: true, fault: null }]]);
  const events = [];
  const store = {
    getInstanceControl: (id) => controls.get(id),
    setInstanceControl: (id, patch) => controls.set(id, { ...controls.get(id), ...patch }),
    appendEvent: (event) => events.push(event),
    listStageRuns: () => [{ stageId: "plan", status: "ready" }],
    listContentItemRuns: () => [],
  };
  const runtime = { tick: async () => { throw new Error("Gateway rejected maxStarts"); } };
  const input = { instanceId: "A", options: { dispatch: true }, runtime, store, workboard: { listCards: async () => [] } };
  await assert.rejects(tickWithFaultProjection(input), /Gateway rejected/);
  assert.deepEqual(controls.get("A").fault.stageIds, ["plan"]);
  assert.equal(controls.get("B").fault, null);
  assert.equal(events.length, 1);
  runtime.tick = async () => ({ dispatch: null });
  await tickWithFaultProjection(input);
  assert.ok(controls.get("A").fault, "No dispatch is not evidence of recovery");
  runtime.tick = async () => ({ dispatch: { started: [{ cardId: "plan" }] } });
  await tickWithFaultProjection(input);
  assert.equal(controls.get("A").fault, null);
});

test("a single project tick reads only that project's cards from the board", async () => {
  const calls = [];
  const store = {
    getInstanceControl: () => ({ automaticDispatch: true, fault: null }),
    setInstanceControl() {},
    appendEvent() {},
    listStageRuns: () => [{ stageId: "plan", status: "ready", cardId: "card-plan" }],
    listContentItemRuns: () => [{ status: "ready", cardId: "card-item" }],
  };
  const runtime = { tick: async (_id, options) => { calls.push({ tick: options.cards }); return { dispatch: null }; } };
  const workboard = { listCards: async (options) => { calls.push({ list: options }); return [{ id: "card-plan" }]; } };
  await tickWithFaultProjection({ instanceId: "A", options: {}, runtime, store, workboard });
  assert.deepEqual(calls[0], { list: { cardIds: ["card-plan", "card-item"] } });
  assert.deepEqual(calls[1].tick, [{ id: "card-plan" }]);
});
