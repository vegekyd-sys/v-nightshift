import { tickWithFaultProjection } from "./scheduler-state.mjs";

export async function runSchedulerPass({
  dispatchMaxStarts = 8,
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
  try {
    cards = await refreshCards();
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
    store.getInstanceControl(instance.id).automaticDispatch || cards.some((card) =>
      (card.labels ?? []).includes(`instance:${instance.id}`) && card.sessionKey &&
      (card.status === "running" || card.execution?.status === "running")));
  const warnings = [];
  let changed = false;
  let remainingStarts = dispatchMaxStarts;
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
        options: { dispatch: true, dispatchMaxStarts: remainingStarts, cards },
        runtime,
        store,
        workboard,
      });
      const startedCards = (result.dispatch?.started ?? []).map((entry) => entry.card).filter(Boolean);
      if (startedCards.length > 0) {
        remainingStarts = Math.max(0, remainingStarts - startedCards.length);
        cards = mergeCards(cards, startedCards);
      }
      if (result.applied.length || result.dispatch) changed = true;
    } catch (error) {
      warnings.push(`${instance.id}: ${error.message}`);
    }
  }
  if (changed) await refreshCards();
  return {
    dispatchMaxStarts,
    dispatched: dispatchMaxStarts - remainingStarts,
    warnings,
    instances: eligible.length,
    pausedInstances: instances.length - eligible.length,
  };
}

function mergeCards(cards, updates) {
  const merged = new Map(cards.map((card) => [card.id, card]));
  for (const card of updates) merged.set(card.id, card);
  return [...merged.values()];
}
