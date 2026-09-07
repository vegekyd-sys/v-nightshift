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
      return { started: [{ card: { id: options.cardId }, sessionKey: "native-session", runId: "native-run" }], startFailures: [], promoted: [], reclaimed: [], blocked: [], orchestrated: [] };
    },
  };
  const createHandler = vm.runInNewContext(
    section(source, "function readId(params)", "function readPatch(params)") +
    section(source, "function createWorkboardDispatchHandler(params)", "//#endregion") + "\ncreateWorkboardDispatchHandler", sandbox);
  const handler = createHandler({ api: { runtime: { subagent: {}, worktrees: {} } }, store: {}, redactCard: (card) => card });
  const call = (method, params) => new Promise((resolve, reject) => {
    handler({ params, respond: (ok, value, error) => ok ? resolve(value) : reject(new Error(error.message)) },
      { supportsMaxStarts: method === "workboard.cards.dispatchWithOptions", directCard: method === "workboard.cards.start" });
  });
  await assert.rejects(call("workboard.cards.dispatch", { boardId: "test", maxStarts: 1 }), /requires workboard.cards.dispatchWithOptions/);
  assert.equal(dispatched.length, 0);
  const adapter = new WorkboardGatewayAdapter({ board: "test" });
  adapter.call = call;
  const result = await adapter.dispatch(3, { cardIds: ["only-this-card"] });
  assert.deepEqual(result.startFailures, []);
  assert.deepEqual(JSON.parse(JSON.stringify(dispatched)), [{ cardId: "only-this-card", maxStarts: 1 }]);
  assert.match(source, /registerGatewayMethod\("workboard\.cards\.start"[\s\S]*?directCard: true/);
});

test("deployed Gateway exact-card start bypasses board maintenance and selects only the requested card", { skip: !bundle }, async () => {
  const source = await readFile(bundle, "utf8");
  const body = section(source, "async function runWorkboardDispatch(params)", "//#endregion");
  const cards = [{ id: "selected", status: "ready" }, { id: "unrelated", status: "ready" }];
  const touched = [];
  const dispatch = vm.runInNewContext(body + "\nrunWorkboardDispatch", {
    DEFAULT_DISPATCH_MAX_STARTS: 3,
    resolveNonNegativeIntegerOption: (value, fallback) => value ?? fallback,
    selectStartableCards: (all, limit, candidates, owner, now, mode) => {
      assert.equal(mode, "exact");
      assert.equal(limit, 1);
      assert.deepEqual(candidates.map((card) => card.id).join(","), "selected");
      assert.equal(all.length, 2);
      return { cards: [] };
    },
  });
  const store = {
    prepareStart: async (id) => { touched.push(id); return cards.find((card) => card.id === id); },
    list: async () => cards,
    dispatch: async () => { throw new Error("Board maintenance must never run"); },
  };
  await dispatch({ store, options: { cardId: "selected", maxStarts: 1 } });
  assert.deepEqual(touched, ["selected"]);
  assert.equal(cards[1].status, "ready");
});
