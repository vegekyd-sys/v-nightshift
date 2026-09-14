import assert from "node:assert/strict";
import test from "node:test";
import { createSessionReader } from "./session-reader.mjs";

test("deduplicates concurrent and repeated running Session reads", async () => {
  let calls = 0;
  let timestamp = 1_000;
  const readSession = createSessionReader({
    getSession: async () => ({ calls: ++calls }),
    now: () => timestamp,
    runningTtlMs: 30_000,
  });
  const input = { cacheKey: "card:run", limit: 80, sessionKey: "session", terminal: false };

  const [first, concurrent] = await Promise.all([readSession(input), readSession(input)]);
  const cached = await readSession(input);
  timestamp += 30_001;
  const refreshed = await readSession(input);

  assert.equal(first.calls, 1);
  assert.equal(concurrent.calls, 1);
  assert.equal(cached.calls, 1);
  assert.equal(refreshed.calls, 2);
  assert.equal(calls, 2);
});

test("keeps terminal Session reads immutable in the bounded cache", async () => {
  let calls = 0;
  let timestamp = 1_000;
  const readSession = createSessionReader({
    getSession: async () => ({ calls: ++calls }),
    now: () => timestamp,
  });
  const input = { cacheKey: "card:terminal-run", limit: 80, sessionKey: "session", terminal: true };

  const first = await readSession(input);
  timestamp += 3_600_000;
  const cached = await readSession(input);

  assert.equal(first.calls, 1);
  assert.equal(cached.calls, 1);
  assert.equal(calls, 1);
});
