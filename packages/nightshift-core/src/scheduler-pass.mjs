import { tickWithFaultProjection } from "./scheduler-state.mjs";

export async function runSchedulerPass({
  dispatchMaxStarts = 36,
  dispatchEnabled = true,
  inspectSessions = true,
  maxWorkboardActive = 36,
  store,
  runtime,
  workboard,
  refreshCards,
  syncContentItemsManifest,
}) {
  const instances = store.listInstances().filter((instance) => instance.status === "active")
    .sort((a, b) => Number(store.getInstanceControl(b.id).automaticDispatch) - Number(store.getInstanceControl(a.id).automaticDispatch));
  const wasRunning = (id) => [...store.listStageRuns(id), ...store.listContentItemRuns(id)]
    .some((run) => run.status === "running");
  let cards;
  const cardIds = schedulerCardIds(store, instances);
  try {
    cards = await refreshCards({ cardIds });
  } catch (error) {
    // A failed shared read affects every project immediately, without repeating
    // the same expensive failing RPC once per historical project.
    for (const instance of instances.filter((entry) => store.getInstanceControl(entry.id).automaticDispatch || wasRunning(entry.id))) {
      store.setInstanceControl(instance.id, { fault: {
        operation: "snapshot", stageIds: [], message: error.message, at: new Date().toISOString(),
      } });
    }
    throw error;
  }
  // Pausing automatic execution also stops background revalidation and planning
  // of historical cards. Explicit manual operations still validate synchronously.
  // Already running native attempts remain eligible so their completion can land.
  const eligible = instances.filter((instance) =>
    store.getInstanceControl(instance.id).automaticDispatch || wasRunning(instance.id) || cards.some((card) =>
      (card.labels ?? []).includes(`instance:${instance.id}`) && card.sessionKey &&
      (card.status === "running" || card.execution?.status === "running")));
  const warnings = [];
  let changed = false;
  const activeAtStart = cards.filter(cardConsumesDispatchSlot).length;
  let remainingStarts = Math.min(dispatchMaxStarts, Math.max(0, maxWorkboardActive - activeAtStart));
  let retryAfterMs = null;
  for (const instance of eligible) {
    try {
      await syncContentItemsManifest(instance);
    } catch (error) {
      warnings.push(`${instance.id}: ${error.message}`);
      store.appendEvent({ instanceId: instance.id, type: "content-items.import.failed", payload: { error: error.message } });
    }
    try {
      const result = await tickWithFaultProjection({
        instanceId: instance.id,
        options: { dispatch: dispatchEnabled, dispatchMaxStarts: dispatchEnabled ? remainingStarts : 0, cards, inspectSessions },
        runtime,
        store,
        workboard,
      });
      const started = result.dispatch?.started ?? [];
      const startedCards = started.map((entry) => entry.card).filter(Boolean);
      if (dispatchEnabled && started.length > 0) {
        remainingStarts = Math.max(0, remainingStarts - started.length);
        cards = mergeCards(cards, startedCards);
      }
      if (result.dispatch?.retryAfterMs > 0) {
        retryAfterMs = retryAfterMs === null
          ? result.dispatch.retryAfterMs
          : Math.min(retryAfterMs, result.dispatch.retryAfterMs);
      }
      if (result.applied.length || result.dispatch) changed = true;
    } catch (error) {
      warnings.push(`${instance.id}: ${error.message}`);
    }
  }
  if (changed) await refreshCards({ cardIds });
  return {
    dispatchMaxStarts,
    dispatched: dispatchEnabled ? dispatchMaxStarts - remainingStarts : 0,
    dispatchEnabled,
    warnings,
    instances: eligible.length,
    pausedInstances: instances.length - eligible.length,
    retryAfterMs,
  };
}

export function schedulerCardIds(store, activeInstances = null) {
  const activeIds = new Set((activeInstances ?? store.listInstances().filter((instance) => instance.status === "active"))
    .map((instance) => instance.id));
  const ids = [];
  for (const instance of store.listInstances()) {
    const runs = [...store.listStageRuns(instance.id), ...store.listContentItemRuns(instance.id)];
    const include = activeIds.has(instance.id) || runs.some((run) => run.status === "running");
    if (!include) continue;
    for (const run of runs) if (typeof run.cardId === "string" && run.cardId) ids.push(run.cardId);
  }
  return [...new Set(ids)];
}

function mergeCards(cards, updates) {
  const merged = new Map(cards.map((card) => [card.id, card]));
  for (const card of updates) merged.set(card.id, card);
  return [...merged.values()];
}

function cardConsumesDispatchSlot(card) {
  return card.status === "running"
    || card.execution?.status === "running"
    || claimExpiryMs(card.metadata?.claim?.expiresAt) > Date.now();
}

function claimExpiryMs(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
