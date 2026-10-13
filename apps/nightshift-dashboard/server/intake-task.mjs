const INITIALIZED = "delivery.confirmation.initialized";

export function createIntakeTaskInitializer({ store, runtime, prepare, writeSnapshot }) {
  const finish = async task => {
    if (store.listEvents(task.id).some(event => event.type === INITIALIZED)) return store.getInstance(task.id);
    // Only the winning immutable database input is written. An interrupted
    // initialization remains paused, so no card can run against half a file.
    await writeSnapshot(task);
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.appendEvent({ instanceId: task.id, type: INITIALIZED, payload: {} });
      const active = store.updateInstanceStatus(task.id, "active");
      store.db.exec("COMMIT");
      return active;
    } catch (error) { store.db.exec("ROLLBACK"); throw error; }
  };
  return {
    create: async project => finish(runtime.startInstance({ ...prepare(project), status: "paused" })),
    resume: async task => {
      if (task.status !== "paused") return task;
      return finish(task);
    },
  };
}
