import { tickWithFaultProjection } from "./scheduler-state.mjs";

export async function runSchedulerPass({ store, runtime, workboard, refreshCards, syncContentItemsManifest }) {
  const instances = store.listInstances().filter((instance) => instance.status === "active")
    .sort((a, b) => Number(store.getInstanceControl(b.id).automaticDispatch) - Number(store.getInstanceControl(a.id).automaticDispatch));
  let cards;
  try {
    cards = await refreshCards();
  } catch (error) {
    // A failed shared read affects every project immediately, without repeating
    // the same expensive failing RPC once per historical project.
    for (const instance of instances) {
      store.setInstanceControl(instance.id, { fault: {
        operation: "snapshot", stageIds: [], message: error.message, at: new Date().toISOString(),
      } });
    }
    throw error;
  }
  const warnings = [];
  let changed = false;
  for (const instance of instances) {
    try {
      await syncContentItemsManifest(instance);
    } catch (error) {
      warnings.push(`${instance.id}: ${error.message}`);
      store.appendEvent({ instanceId: instance.id, type: "content-items.import.failed", payload: { error: error.message } });
    }
    try {
      const result = await tickWithFaultProjection({ instanceId: instance.id, options: { dispatch: true, cards }, runtime, store, workboard });
      if (result.applied.length || result.dispatch) changed = true;
    } catch (error) {
      warnings.push(`${instance.id}: ${error.message}`);
    }
  }
  if (changed) await refreshCards();
  return { warnings, instances: instances.length };
}
