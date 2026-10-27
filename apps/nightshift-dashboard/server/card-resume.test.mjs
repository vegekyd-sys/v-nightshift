import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

// Exercise the actual HTTP branch without booting the production service.
const source = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
const route = source.slice(source.indexOf("  const resumeMatch ="), source.indexOf("  const retryMatch ="));
test("card resume uses the signed-in identity and card ID, and only queues guarded scheduling", async () => {
  const calls = [], queued = [], refreshes = [];
  let serializing = false;
  let response;
  await vm.runInNewContext(`(async () => {${route}})()`, {
    request: { method: "POST" }, response: {}, url: { pathname: "/api/cards/source-card/resume" },
    bodyJson: async () => ({ actor: "spoofed", instanceId: "another-project", stageId: "purchase", note: "继续原任务", allowNewOperation: true }),
    operatorIdentity: () => "authenticated:V",
    serializedOperation: async f => { serializing = true; try { return await f(); } finally { serializing = false; } },
    runtime: { resume: async input => {
      assert.equal(serializing, true);
      calls.push(input);
      return { how: "fresh", affectedCardIds: ["source-card"] };
    } },
    refreshCards: async scope => refreshes.push(scope.cardIds),
    changeScheduler: { enqueue: reason => queued.push(reason) },
    json: (_res, status, result) => { response = { status, result }; },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { cardId: "source-card", actor: "authenticated:V", note: "继续原任务", allowNewOperation: true });
  assert.deepEqual(queued, ["card.resumed"]);
  assert.equal(refreshes[0][0], "source-card");
  assert.equal(response.status, 200);
});

test("card resume returns a recovery conflict without scheduling work", async () => {
  let result;
  await vm.runInNewContext(`(async () => {${route}})()`, {
    request: { method: "POST" }, response: {}, url: { pathname: "/api/cards/source-card/resume" },
    bodyJson: async () => ({}), operatorIdentity: () => "local:V", serializedOperation: f => f(),
    runtime: { resume: async () => { throw Object.assign(new Error("supplier readback required"), { statusCode: 409 }); } },
    refreshCards: () => assert.fail("conflicts do not mutate the board cache"),
    changeScheduler: { enqueue: () => assert.fail("conflicts do not dispatch") },
    json: (_res, status, body) => { result = { status, body }; },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "supplier readback required");
});
