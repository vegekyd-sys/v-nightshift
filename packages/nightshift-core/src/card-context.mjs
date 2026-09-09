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
