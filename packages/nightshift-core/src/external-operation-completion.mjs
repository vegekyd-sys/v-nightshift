import { createHash } from "node:crypto";
import { canonicalStringify } from "./workflow.mjs";

export function operationResultHash(result) {
  return createHash("sha256").update(canonicalStringify(result)).digest("hex");
}

export function isKnownTerminalAttempt(stage, operation) {
  return stage?.operationCompletion?.mode === "terminal-attempt" &&
    ["succeeded", "failed"].includes(operation?.status) &&
    operation.result?.terminal === true && typeof operation.result?.evidence === "string" && Boolean(operation.result.evidence.trim());
}

// Completion of an explicitly declared *attempt* is not success of its effect.
// Never rewrite the operation or accept unknown results. The server still
// validates execution provenance, the handoff and every declared output rule.
export async function validateExternalOperationCompletion({ card, operation, stage, loadReceipt }) {
  if (!operation || operation.ownerCardId !== card.id) {
    throw new Error("External side effect has no succeeded Night Shift operation checkpoint");
  }
  const evidence = {
    externalTaskId: operation.externalTaskId,
    idempotencyKey: operation.idempotencyKey,
    requestHash: operation.requestHash,
    status: operation.status,
  };
  if (stage?.operationCompletion === undefined) {
    if (operation.status !== "succeeded") throw new Error("External side effect has no succeeded Night Shift operation checkpoint");
    return evidence;
  }
  if (stage.operationCompletion.mode !== "terminal-attempt" || !["succeeded", "failed"].includes(operation.status)) {
    throw new Error("External attempt requires a known terminal checkpoint; supplier readback required");
  }
  if (!isKnownTerminalAttempt(stage, operation)) {
    throw new Error("External attempt requires recorded terminal readback evidence in operation.result");
  }
  const receipt = await loadReceipt(stage.operationCompletion.output);
  if (!receipt || receipt.attempted !== true || receipt.succeeded !== (operation.status === "succeeded")) {
    throw new Error("Attempt receipt must report attempted=true and succeeded matching the actual operation");
  }
  const expected = { ...evidence, externalTaskId: operation.externalTaskId ?? null, resultSha256: operationResultHash(operation.result) };
  for (const [name, value] of Object.entries(expected)) {
    if (receipt.operation?.[name] !== value) throw new Error(`Attempt receipt operation.${name} does not match the recorded checkpoint`);
  }
  return { ...evidence, completion: "terminal-attempt", resultSha256: expected.resultSha256 };
}
