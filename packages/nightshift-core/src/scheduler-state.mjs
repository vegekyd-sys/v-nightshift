export async function tickWithFaultProjection({ instanceId, options, runtime, store, workboard }) {
  let operation = "snapshot";
  try {
    const cards = options.cards ?? await workboard.listCards();
    operation = "tick";
    const result = await runtime.tick(instanceId, { ...options, cards });
    const runs = [...store.listStageRuns(instanceId), ...store.listContentItemRuns(instanceId)];
    const control = store.getInstanceControl(instanceId);
    const snapshotRecovered = control.fault?.operation === "snapshot";
    if (snapshotRecovered || (options.dispatch && control.automaticDispatch &&
        (result.dispatch || !runs.some((run) => ["ready", "blocked"].includes(run.status))))) {
      store.setInstanceControl(instanceId, { fault: null });
    }
    return result;
  } catch (error) {
    const runs = [...store.listStageRuns(instanceId), ...store.listContentItemRuns(instanceId)];
    const fault = {
      operation,
      stageIds: [...new Set(runs.filter((run) => ["ready", "blocked"].includes(run.status)).map((run) => run.stageId))],
      message: error.message,
      at: new Date().toISOString(),
    };
    store.setInstanceControl(instanceId, { fault });
    store.appendEvent({ instanceId, type: "scheduler.instance.failed", payload: fault });
    throw error;
  }
}
