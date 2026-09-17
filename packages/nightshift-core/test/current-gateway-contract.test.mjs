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

test("scoped adapter parameters pass the deployed Gateway handler; legacy maxStarts is rejected", { skip: !bundle }, async () => {
  const source = await readFile(bundle, "utf8");
  const dispatched = [];
  const sandbox = {
    parseStrictPositiveInteger: (value) => Number.isSafeInteger(value) && value > 0 ? value : undefined,
    gatewayDispatchOptions: ({ input }) => input,
    respondError: (respond, error) => respond(false, null, { message: error.message }),
    dispatchAndStartWorkboardCards: async ({ options }) => {
      dispatched.push(options);
      return { started: [{ cardId: options.cardIds?.[0], sessionKey: "native-session", runId: "native-run" }], startFailures: [], promoted: [], reclaimed: [], blocked: [], orchestrated: [] };
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
  assert.deepEqual(JSON.parse(JSON.stringify(dispatched)), [{ boardId: "test", cardIds: ["only-this-card"], maxStarts: 1 }]);
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

// Night Shift hands a timed release to the board instead of holding the card
// back itself. That only works if the deployed Gateway really does three
// things, so assert them against its own code rather than against a reading
// of it: hold on create, refuse an early start, release on scoped dispatch.
test("deployed Gateway holds a card until its scheduledAt and releases it on the next scoped dispatch", { skip: !bundle }, async () => {
  const source = await readFile(bundle, "utf8");

  // 1. Creating a card whose release is in the future overrides the requested
  //    status with "scheduled".
  assert.match(
    source,
    /const heldBySchedule = Boolean\(automation\?\.scheduledAt && automation\.scheduledAt > now\)[\s\S]{0,120}?heldBySchedule \? "scheduled"/,
    "Current Gateway must put a future-dated card into scheduled on create",
  );

  // 2. Moving a held card anywhere but done is refused.
  assert.match(
    source,
    /const scheduledAt = next\.metadata\?\.automation\?\.scheduledAt;\s*if \(scheduledAt && scheduledAt > now[\s\S]{0,120}?throw new Error\("card is scheduled for later\."\)/,
    "Current Gateway must refuse to start a card before its release",
  );
  assert.match(
    source,
    /if \(guarded\.status === "scheduled"\) throw new Error\("card is scheduled for later\."\)/,
    "Current Gateway dispatch must refuse a card still held",
  );

  // 3. The promotion rule itself, executed. This is the step Night Shift
  //    depends on for the release actually happening: the scoped dispatch RPC
  //    runs it over the cards Night Shift passes, so no extra timer is needed.
  const body = section(source, "async dependencyTargetStatus(card, now) {", "async dependsOn(cardId, targetParentId)");
  const promote = vm.runInNewContext(
    `(function () { return ${body.replace("async dependencyTargetStatus(card, now) {", "async function dependencyTargetStatus(card, now) {")} })()`,
    {
      cardParentIds: (card) => card.parents ?? [],
      isDependencyPromotableStatus: (status) =>
        ["backlog", "triage", "todo", "scheduled", "ready"].includes(status),
    },
  );
  const at = Date.parse("2026-09-18T01:00:00Z");
  const held = { status: "scheduled", metadata: { automation: { scheduledAt: at } } };
  assert.equal(await promote.call({}, held, at - 60_000), "scheduled");
  assert.equal(await promote.call({}, held, at), "ready");
  assert.equal(await promote.call({}, held, at + 60_000), "ready");
  // A card with no release time is untouched by this rule.
  assert.equal(await promote.call({}, { status: "ready", metadata: {} }, at), "ready");

  // 4. The scoped dispatch runs that promotion before it selects what to start,
  //    so a card whose moment arrived starts in the same call.
  const dispatch = section(source, "async function runWorkboardDispatch(params)", "//#endregion");
  assert.ok(
    dispatch.indexOf("params.store.dispatch({") < dispatch.indexOf("selectStartableCards("),
    "Current Gateway must promote scheduled cards before selecting startable ones",
  );
});
