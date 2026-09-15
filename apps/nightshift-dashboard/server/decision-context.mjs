export function resolveCardDecisionContext({ body = {}, card, instance = null, release = null }) {
  const automation = card?.metadata?.automation ?? {};
  const instanceId = body.instanceId ?? automation.instanceId ?? label(card, "instance");
  const contentItemId = body.contentItemId ?? automation.contentItemId ?? label(card, "content-item") ?? null;
  const stageId = body.stageId ?? automation.stageId ?? label(card, "stage");
  const stage = release?.spec?.stages?.find((entry) => entry.id === stageId);
  const requiredApproval = stage?.approval?.before
    ? { effect: stage.approval.before, scope: stage.approval.scope ?? "stage" }
    : null;
  return {
    ...body,
    cardId: card?.id,
    contentItemId,
    instanceId: instance?.id ?? instanceId,
    stageId,
    ...(requiredApproval ?? {}),
  };
}

function label(card, prefix) {
  return card?.labels?.find((entry) => entry.startsWith(`${prefix}:`))?.slice(prefix.length + 1) ?? null;
}
