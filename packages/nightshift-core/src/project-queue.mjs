// First come, first delivered.
//
// Every project draws on the same machine, whatever its Workflow, so the free
// starts of a scheduler pass go to projects in the order they arrived: the
// earliest takes what its Workflow lets one project run at once, the next takes
// what is left, and a project that arrives when nothing is left waits. How many
// projects move together follows from how much the pressure guard allows, not
// from a fixed count.
//
// This only reports each project's place, for the board. The order itself is
// the scheduler pass ticking projects by arrival over a shared start budget.
import { cardConsumesDispatchSlot, cardIsStartable } from "./runtime.mjs";

export const RUNNING = "running";
export const QUEUED = "queued";
// Nothing to start: waiting on a person, a release time, or paused dispatch.
export const WAITING = "waiting";

export function byArrival(a, b) {
  return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || String(a.id).localeCompare(String(b.id));
}

// A project can jump the queue. Its priority (instance_controls.priority, set by
// an operator or an Agent through nightshiftctl projects priority|order) comes
// first, higher ahead; projects of equal priority, including every project
// nobody set, keep first come, first delivered.
export const PRIORITY_MIN = -1000;
export const PRIORITY_MAX = 1000;

export function projectPriority(store, instanceId) {
  const priority = store.getInstanceControl(instanceId)?.priority;
  return Number.isSafeInteger(priority) ? priority : 0;
}

export function byQueueOrder(store) {
  return (a, b) => projectPriority(store, b.id) - projectPriority(store, a.id) || byArrival(a, b);
}

export function projectQueue({ store, instances, cards = [], nowMs = Date.now() }) {
  const cardsByInstance = new Map();
  for (const card of cards) {
    const id = (card.labels ?? []).find((label) => label.startsWith("instance:"))?.slice("instance:".length);
    if (!id) continue;
    if (!cardsByInstance.has(id)) cardsByInstance.set(id, []);
    cardsByInstance.get(id).push(card);
  }
  const queue = new Map();
  let position = 0;
  for (const instance of [...instances].filter((entry) => entry.status === "active").sort(byQueueOrder(store))) {
    const own = cardsByInstance.get(instance.id) ?? [];
    const priority = projectPriority(store, instance.id);
    const place = priority ? { priority } : {};
    if (own.some(cardConsumesDispatchSlot)) {
      queue.set(instance.id, { state: RUNNING, ...place });
    } else if (store.getInstanceControl(instance.id).automaticDispatch &&
      own.some((card) => cardIsStartable(card, nowMs) && !(card.labels ?? []).includes("nightshift:approval"))) {
      position += 1;
      queue.set(instance.id, { state: QUEUED, position, ...place });
    } else {
      queue.set(instance.id, { state: WAITING, ...place });
    }
  }
  return queue;
}
