import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalStringify, compileWorkflow, validateWorkflow } from "../src/workflow.mjs";
import { validateExternalOperationCompletion } from "../src/external-operation-completion.mjs";

const card = { id: "card-1" };
const operation = { ownerCardId: card.id, idempotencyKey: "original-key", requestHash: "a".repeat(64), externalTaskId: "provider-task", status: "failed", result: { terminal: true, evidence: "provider-readback.json", providerStatus: 4 } };
const stage = { id: "attempt", title: "Attempt", actor: "system", timeout: "1h", sideEffects: ["external-call"], retry: { maxAttempts: 1, idempotencyKey: "fixed" }, outputs: ["receipt"], completeWhen: ["output.receipt.exists"], outputContracts: { receipt: { type: "json" } }, operationCompletion: { mode: "terminal-attempt", output: "receipt" } };
const receipt = (op = operation) => ({ attempted: true, succeeded: op.status === "succeeded", operation: { idempotencyKey: op.idempotencyKey, requestHash: op.requestHash, externalTaskId: op.externalTaskId, status: op.status, resultSha256: createHash("sha256").update(canonicalStringify(op.result)).digest("hex") } });
const validate = (op = operation, facts = receipt(op), declared = stage) => validateExternalOperationCompletion({ card, operation: op, stage: declared, loadReceipt: async () => facts });
const workflow = (s = stage) => ({ apiVersion: "nightshift.versa.ai/v1alpha1", kind: "Workflow", metadata: { id: "settled-attempt", version: "1", name: "test" }, spec: { ownerAgentRole: "operator", completion: { mode: "strict-v1" }, handoff: { version: 1 }, stages: [s] } });

test("declared terminal attempts complete with an honestly failed immutable ledger", async () => {
  const before = structuredClone(operation);
  const evidence = await validate();
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.completion, "terminal-attempt");
  assert.deepEqual(operation, before);
  compileWorkflow(workflow());
});
test("legacy success requirement is not relaxed", async () => {
  const legacy = { ...stage }; delete legacy.operationCompletion;
  await assert.rejects(validate(operation, receipt(), legacy), /succeeded/);
  assert.equal((await validate({ ...operation, status: "succeeded" }, undefined, legacy)).status, "succeeded");
});
for (const status of ["reserved", "executing", "unknown", "cancelled"]) test(`terminal-attempt still rejects ${status}`, async () => {
  await assert.rejects(validate({ ...operation, status }), /terminal|settled|succeeded/);
});
test("terminal failure requires recorded evidence and exact receipt identity", async () => {
  for (const result of [null, {}, { terminal: false, evidence: "x" }, { terminal: true }, { terminal: true, evidence: "" }]) {
    await assert.rejects(validate({ ...operation, result }), /evidence|terminal/);
  }
  for (const field of ["idempotencyKey", "requestHash", "status", "externalTaskId", "resultSha256"]) {
    const facts = receipt(); facts.operation[field] = "wrong";
    await assert.rejects(validate(operation, facts), /receipt|match/);
  }
  await assert.rejects(validate(operation, { ...receipt(), succeeded: true }), /receipt|succeeded/);
  await assert.rejects(validate(operation, { ...receipt(), attempted: false }), /receipt|attempt/);
  await assert.rejects(validate({ ...operation, ownerCardId: "other" }), /owner|checkpoint/);
  await assert.rejects(validate(operation, null), /receipt/);
});
test("terminal-attempt declaration is strict, explicit and requires machine-verifiable JSON", () => {
  for (const change of [{ mode: "any", output: "receipt" }, { mode: "terminal-attempt" }, { mode: "terminal-attempt", output: "missing" }, { ...stage.operationCompletion, allowUnknown: true }]) {
    assert(validateWorkflow(workflow({ ...stage, operationCompletion: change })).some(issue => issue.code.startsWith("stage.operationCompletion")));
  }
  for (const mutate of [d => { delete d.spec.handoff; }, d => { delete d.spec.completion; }, d => { d.spec.stages[0].outputContracts.receipt.type = "text"; }, d => { d.spec.stages[0].completeWhen = []; }, d => { d.spec.stages[0].sideEffects = []; }]) {
    const d = workflow(structuredClone(stage)); mutate(d);
    assert(validateWorkflow(d).some(issue => issue.code.startsWith("stage.operationCompletion")));
  }
});
