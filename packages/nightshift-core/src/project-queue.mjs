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
  for (const instance of [...instances].filter((entry) => entry.status === "active").sort(byArrival)) {
    const own = cardsByInstance.get(instance.id) ?? [];
    if (own.some(cardConsumesDispatchSlot)) {
      queue.set(instance.id, { state: RUNNING });
    } else if (store.getInstanceControl(instance.id).automaticDispatch &&
      own.some((card) => cardIsStartable(card, nowMs) && !(card.labels ?? []).includes("nightshift:approval"))) {
      position += 1;
      queue.set(instance.id, { state: QUEUED, position });
    } else {
      queue.set(instance.id, { state: WAITING });
    }
  }
  return queue;
}
