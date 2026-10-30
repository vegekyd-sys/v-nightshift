import assert from "node:assert/strict";
import test from "node:test";
import { readCachedOverview, resetSavedAtForTest, saveOverview, takeEarlyCard, takeEarlyOverview } from "./first-paint.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

test("the last live overview comes back marked stale, and expires after a day", () => {
  resetSavedAtForTest();
  const storage = memoryStorage();
  saveOverview("delivered", { scope: "delivered" }, storage, 1_000);
  assert.equal(readCachedOverview(storage, 2_000), null, "only the live scope is kept");
  saveOverview("live", { scope: "live", instances: [1] }, storage, 1_000);
  assert.deepEqual(readCachedOverview(storage, 2_000), { scope: "live", instances: [1], stale: true });
  assert.equal(readCachedOverview(storage, 1_000 + 24 * 60 * 60 * 1000 + 1), null);
});

test("saving is throttled, and broken or full storage never throws", () => {
  resetSavedAtForTest();
  const storage = memoryStorage();
  saveOverview("live", { n: 1 }, storage, 10_000);
  saveOverview("live", { n: 2 }, storage, 20_000);
  assert.equal(readCachedOverview(storage, 30_000).n, 1, "a second save within a minute is skipped");
  assert.equal(readCachedOverview({ getItem: () => "{not json" }), null);
  resetSavedAtForTest();
  assert.doesNotThrow(() => saveOverview("live", { n: 3 }, { setItem: () => { throw new Error("QuotaExceededError"); } }, 90_000));
});

test("the requests index.html started are handed over once, and only for what they asked", async () => {
  globalThis.window = { __nightshiftEarly: { overview: Promise.resolve({ body: { ok: 1 } }), card: { id: "c1", request: Promise.resolve({ body: { card: { id: "c1" } } }) } } };
  try {
    assert.equal(takeEarlyOverview("delivered"), null);
    assert.deepEqual((await takeEarlyOverview("live")).body, { ok: 1 });
    assert.equal(takeEarlyOverview("live"), null);
    assert.equal(takeEarlyCard("other"), null);
    assert.deepEqual(await takeEarlyCard("c1"), { card: { id: "c1" } });
    assert.equal(takeEarlyCard("c1"), null);
  } finally {
    delete globalThis.window;
  }
});
