import assert from "node:assert/strict";
import test from "node:test";
import { WorkboardCliAdapter, idempotencyLabel } from "../src/index.mjs";

test("creates a native Workboard card with a stable idempotency label", async () => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    if (args[1] === "list") return JSON.stringify({ cards: [] });
    return JSON.stringify({ id: "card-1", labels: [] });
  };
  const adapter = new WorkboardCliAdapter({ board: "nightshift-lab", runner });
  const action = workAction();
  const result = await adapter.applyAction(action);
  assert.equal(result.status, "created");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [
    "workboard",
    "list",
    "--board",
    "nightshift-lab",
    "--include-archived",
    "--json",
  ]);
  assert.ok(calls[1].includes(idempotencyLabel(action.idempotencyKey)) === false);
  assert.match(calls[1][calls[1].indexOf("--labels") + 1], /nightshift-action:/);
  assert.equal(calls[1][calls[1].indexOf("--agent") + 1], "makaron");
});

test("reuses a card with the same action label", async () => {
  const action = workAction();
  const marker = idempotencyLabel(action.idempotencyKey);
  const runner = async (_command, args) => {
    assert.equal(args[1], "list");
    return JSON.stringify({ cards: [{ id: "existing", labels: [marker] }] });
  };
  const adapter = new WorkboardCliAdapter({ runner });
  const result = await adapter.applyAction(action);
  assert.equal(result.status, "reused");
  assert.equal(result.card.id, "existing");
});

test("maps an approval request to a review card", async () => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    return args[1] === "list" ? JSON.stringify([]) : JSON.stringify({ id: "review-1" });
  };
  const adapter = new WorkboardCliAdapter({ runner });
  const result = await adapter.applyAction({
    type: "request_approval",
    instanceId: "NS-LAB-001",
    stageId: "publish",
    approval: { effect: "external-publication", scope: "asset-and-account" },
    idempotencyKey: "approval-key",
  });
  assert.equal(result.status, "created");
  const createArgs = calls[1];
  assert.equal(createArgs[createArgs.indexOf("--status") + 1], "review");
  assert.equal(createArgs.includes("--agent"), false);
});

test("dry-run never sends metadata to the CLI", async () => {
  const runner = async (_command, args) =>
    args[1] === "list" ? JSON.stringify([]) : assert.fail("create should not run");
  const adapter = new WorkboardCliAdapter({ runner });
  const result = await adapter.applyAction(workAction(), { dryRun: true });
  assert.equal(result.status, "planned");
  assert.equal(result.args[result.args.indexOf("--notes") + 1], "<nightshift-metadata>");
});

function workAction() {
  return {
    type: "create_workboard_card",
    instanceId: "NS-LAB-001",
    stageId: "plan",
    idempotencyKey: "release:run:NS-LAB-001:plan:input",
    card: {
      title: "VLab 星擎试验｜需求与策划",
      status: "ready",
      priority: "normal",
      assignedAgent: "makaron",
      labels: ["workflow:xingqing", "instance:NS-LAB-001", "stage:plan"],
      automation: { workflowId: "xingqing", stageId: "plan" },
    },
  };
}
