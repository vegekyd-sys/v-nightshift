import { actionKey, nativeActionKey } from "./orchestrator.mjs";
import { gatewayIdempotencyLabel } from "./workboard-gateway-adapter.mjs";

const COORDINATE_LABELS = {
  contentItemId: "content-item:",
  instanceId: "instance:",
  stageId: "stage:",
};

export function resolveNightShiftCardContext({ card, release = null }) {
  if (!card || typeof card !== "object") throw new Error("A Workboard card is required");
  const automation = card.metadata?.automation ?? {};
  const coordinates = Object.fromEntries(
    Object.entries(COORDINATE_LABELS).map(([field, prefix]) => [
      field,
      consistentCoordinate({ automation, card, field, prefix }),
    ]),
  );
  const stage = release?.spec?.stages?.find((entry) => entry.id === coordinates.stageId) ?? null;
  if (release && !stage) throw new Error(`Card references an unknown Workflow stage: ${coordinates.stageId ?? "missing"}`);
  const sideEffects = stage
    ? [...new Set(stage.sideEffects ?? [])]
    : [...new Set(Array.isArray(automation.sideEffects) ? automation.sideEffects : [])];
  return {
    ...coordinates,
    idempotencyKey: automation.idempotencyKey ?? automation.nightshiftActionKey ?? null,
    sideEffects,
    stage,
  };
}

export function resolveNightShiftOperationKeys({ card, release, instance, contentItem = null, projectRun = null }) {
  const context = resolveNightShiftCardContext({ card, release });
  if (!instance || instance.id !== context.instanceId) {
    throw new Error("Card is not linked to the supplied Night Shift project");
  }
  if (context.contentItemId && contentItem?.id !== context.contentItemId) {
    throw new Error(`Card references an unknown content item: ${context.contentItemId}`);
  }
  if (projectRun && (context.contentItemId || projectRun.cardId !== card.id || projectRun.stageId !== context.stageId || projectRun.instanceId !== instance.id)) {
    throw new Error("Project stage run does not match this card");
  }
  const logicalIdempotencyKey = actionKey(release, instance, context.stage, "run", contentItem, projectRun?.attempt);
  const boundedNativeIdempotencyKey = nativeActionKey(logicalIdempotencyKey);
  return {
    context,
    logicalIdempotencyKey,
    boundedNativeIdempotencyKey,
    preferredIdempotencyKey: context.idempotencyKey && context.idempotencyKey !== logicalIdempotencyKey
      ? context.idempotencyKey
      : boundedNativeIdempotencyKey,
    candidateIdempotencyKeys: [...new Set([
      logicalIdempotencyKey,
      context.idempotencyKey,
      boundedNativeIdempotencyKey,
    ].filter(Boolean))],
  };
}

export function findNightShiftExternalOperation({ card, candidateIdempotencyKeys = [], operations = [] }) {
  const actionLabel = (card.labels ?? []).find((label) =>
    typeof label === "string" && label.startsWith("nightshift-action:"));
  const labeledOperation = actionLabel
    ? operations.find((operation) => gatewayIdempotencyLabel(operation.idempotencyKey) === actionLabel)
    : null;
  if (labeledOperation) return labeledOperation;
  const candidates = new Set(candidateIdempotencyKeys);
  return operations.find((operation) => candidates.has(operation.idempotencyKey)) ?? null;
}

function consistentCoordinate({ automation, card, field, prefix }) {
  const metadataPresent = Object.hasOwn(automation, field) && automation[field] !== null;
  const metadataValue = metadataPresent ? String(automation[field]) : null;
  const labelValue = (card.labels ?? [])
    .find((label) => typeof label === "string" && label.startsWith(prefix))
    ?.slice(prefix.length) ?? null;
  if (metadataValue && labelValue && metadataValue !== labelValue) {
    throw new Error(`Card ${field} metadata does not match its label`);
  }
  return metadataValue ?? labelValue;
}
