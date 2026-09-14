import assert from "node:assert/strict";
import test from "node:test";
import { WorkboardChangeScheduler } from "./workboard-change-scheduler.mjs";

test("coalesces Workboard changes into one immediate scheduler pass", async () => {
  const timeouts = [];
  const intervals = [];
  let listener;
  const runs = [];
  const timer = (fn) => {
    const handle = { fn, unref() {} };
    timeouts.push(handle);
    return handle;
  };
  const scheduler = new WorkboardChangeScheduler({
    run: async (input) => runs.push(input),
    setIntervalFn: (fn) => {
      const handle = { fn, unref() {} };
      intervals.push(handle);
      return handle;
    },
    setTimeoutFn: timer,
    clearIntervalFn() {},
    clearTimeoutFn() {},
    workboard: { onChange(fn) { listener = fn; return () => {}; } },
  });
  scheduler.start();
  listener({ revision: 1 });
  listener({ revision: 2 });
  timeouts.at(-1).fn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(runs, [{ trigger: "workboard.changed" }]);
  assert.equal(intervals.length, 1);
  scheduler.stop();
});

test("globally limits staggered heartbeat changes to one scheduler pass per five seconds", async () => {
  const timeouts = [];
  let listener;
  let now = 10_000;
  const runs = [];
  const scheduler = new WorkboardChangeScheduler({
    debounceMs: 100,
    minRunIntervalMs: 5_000,
    now: () => now,
    run: async () => runs.push(now),
    setIntervalFn: () => ({ unref() {} }),
    setTimeoutFn: (fn, delay) => {
      const handle = { delay, fn, unref() {} };
      timeouts.push(handle);
      return handle;
    },
    clearIntervalFn() {},
    clearTimeoutFn() {},
    workboard: { onChange(fn) { listener = fn; return () => {}; } },
  });
  scheduler.start();
  listener({ revision: 1 });
  timeouts.at(-1).fn();
  await new Promise((resolve) => setImmediate(resolve));
  now += 100;
  listener({ revision: 2 });

  assert.equal(timeouts.at(-1).delay, 4_900);
  now += 4_900;
  timeouts.at(-1).fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runs, [10_000, 15_000]);
  scheduler.stop();
});

test("keeps only the earliest delayed dispatch retry", () => {
  const timeouts = [];
  let now = 10_000;
  const cleared = [];
  const scheduler = new WorkboardChangeScheduler({
    now: () => now,
    run: async () => {},
    setIntervalFn: () => ({ unref() {} }),
    setTimeoutFn: (fn, delay) => {
      const handle = { delay, fn, unref() {} };
      timeouts.push(handle);
      return handle;
    },
    clearIntervalFn() {},
    clearTimeoutFn(handle) { cleared.push(handle); },
    workboard: { onChange() { return () => {}; } },
  });
  scheduler.start();
  scheduler.enqueueAfter("dispatch.window", 15_000);
  scheduler.enqueueAfter("dispatch.window", 20_000);
  scheduler.enqueueAfter("dispatch.window", 5_000);

  assert.equal(cleared.length, 1);
  assert.equal(timeouts.at(-1).delay, 5_000);
  scheduler.stop();
});
