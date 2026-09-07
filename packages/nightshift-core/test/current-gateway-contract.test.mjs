import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { WorkboardGatewayAdapter } from "../src/workboard-gateway-adapter.mjs";

// Point at the currently deployed runtime bundle, never a copied schema fixture.
const bundle = process.env.NIGHTSHIFT_GATEWAY_CONTRACT_SOURCE;
function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Current Gateway must expose ${start}`);
  return source.slice(first, last);
}

test("adapter parameters pass the deployed Gateway handler; legacy maxStarts is rejected", { skip: !bundle }, async () => {
  const source = await readFile(bundle, "utf8");
  const dispatched = [];
  const sandbox = {
    parseStrictPositiveInteger: (value) => Number.isSafeInteger(value) && value > 0 ? value : undefined,
    gatewayDispatchOptions: ({ input }) => input,
    respondError: (respond, error) => respond(false, null, { message: error.message }),
    dispatchAndStartWorkboardCards: async ({ options }) => {
      dispatched.push(options);
      return { started: [], startFailures: [], promoted: [], reclaimed: [], blocked: [], orchestrated: [] };
    },
  };
  const createHandler = vm.runInNewContext(
    section(source, "function readId(params)", "function readPatch(params)") +
    section(source, "function createWorkboardDispatchHandler(params)", "//#endregion") + "\ncreateWorkboardDispatchHandler", sandbox);
  const handler = createHandler({ api: { runtime: { subagent: {}, worktrees: {} } }, store: {}, redactCard: (card) => card });
  const call = (method, params) => new Promise((resolve, reject) => {
    handler({ params, respond: (ok, value, error) => ok ? resolve(value) : reject(new Error(error.message)) },
      { supportsMaxStarts: method === "workboard.cards.dispatchWithOptions" });
  });
  await assert.rejects(call("workboard.cards.dispatch", { boardId: "test", maxStarts: 1 }), /requires workboard.cards.dispatchWithOptions/);
  assert.equal(dispatched.length, 0);
  const adapter = new WorkboardGatewayAdapter({ board: "test" });
  adapter.call = call;
  await adapter.dispatch(3, { cardIds: ["only-this-card"] });
  assert.deepEqual(JSON.parse(JSON.stringify(dispatched)), [{ boardId: "test", cardIds: ["only-this-card"], maxStarts: 1 }]);
  assert.match(source, /registerGatewayMethod\("workboard\.cards\.dispatchWithOptions"[\s\S]*?supportsMaxStarts: true/);
});

test("deployed Gateway maintenance dispatcher mutates only scoped cards, including empty scope", { skip: !bundle }, async () => {
  const source = await readFile(bundle, "utf8");
  const method = section(source, "\tasync dispatch(input = Date.now())", "\tasync bulkUpdate(input)");
  const dispatch = vm.runInNewContext(`({${method}}).dispatch`, {
    normalizeTimestamp: (value, fallback) => value ?? fallback,
    normalizeBoardId: (value) => value,
    latestRunningAttempt: () => null,
    isWorkboardClaimReclaimable: () => false,
    retryBudgetExhausted: () => false,
  });
  const cards = [{ id: "selected", status: "ready" }, { id: "unrelated", status: "ready" }];
  const touched = [];
  const store = {
    enqueueMutation: (operation) => operation(),
    list: async ({ cardIds }) => cards.filter((card) => cardIds.includes(card.id)),
    promoteDependencyReady: async (id) => { touched.push(id); return cards.find((card) => card.id === id); },
    recordDispatch: async (card) => { touched.push(card.id); return card; },
    shouldAutoOrchestrate: async () => false,
  };
  await dispatch.call(store, { boardId: "test", cardIds: ["selected"] });
  assert.deepEqual(touched, ["selected", "selected"]);
  touched.length = 0;
  await dispatch.call(store, { boardId: "test", cardIds: [] });
  assert.deepEqual(touched, []);
  assert.match(source, /const candidates = directCard \? \[directCard\] : await params\.store\.list\(\{ boardId, cardIds \}\)/);
});
