import { tickWithFaultProjection } from "./scheduler-state.mjs";
import { byQueueOrder, projectQueue } from "./project-queue.mjs";

export async function runSchedulerPass({
  dispatchMaxStarts = 36,
  dispatchEnabled = true,
  inspectSessions = true,
  // The repair pass reads every card the projects own; a routine pass reads only
  // what can still change.
  fullSweep = inspectSessions,
  maxWorkboardActive = 36,
  store,
  runtime,
  workboard,
  refreshCards,
  syncContentItemsManifest,
}) {
  // First come, first delivered (unless a project was given priority, which
  // jumps the queue): projects are ticked in the order they arrived,
  // over one start budget shared by every Workflow, so the earliest project
  // takes its share first and a late one waits until starts are left over. The
  // store lists by last update, which on V (2026-09-29) handed the few free
  // starts to whichever project had just moved, usually the newest: the batch
  // started at 11:49 sat queued behind ones that arrived four hours later.
  const instances = store.listInstances().filter((instance) => instance.status === "active")
    .sort((a, b) => Number(store.getInstanceControl(b.id).automaticDispatch) - Number(store.getInstanceControl(a.id).automaticDispatch) ||
      byQueueOrder(store)(a, b));
  const nowMs = Date.now();
  const wasRunning = (id) => [...store.listStageRuns(id), ...store.listContentItemRuns(id)]
    .some((run) => runIsLive(run, nowMs));
  let cards;
  const cardIds = schedulerCardIds(store, instances, { fullSweep, nowMs });
  try {
    cards = await refreshCards({ cardIds });
  } catch (error) {
    // A Gateway that is suspending or restarting is not a fault of any project:
    // the caller holds Night Shift until it is back.
    if (/unavailable during gateway (?:suspension|restart|startup)/i.test(error.message)) throw error;
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
  let dispatched = 0;
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
        dispatched += started.length;
        cards = mergeCards(cards, startedCards);
      }
      if (result.retryAfterMs > 0) retryAfterMs = Math.min(retryAfterMs ?? Infinity, result.retryAfterMs);
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
  if (changed) cards = await refreshCards({ cardIds: schedulerCardIds(store, null, { fullSweep, nowMs }) }) ?? cards;
  return {
    dispatchMaxStarts,
    dispatched,
    dispatchEnabled,
    warnings,
    instances: eligible.length,
    pausedInstances: instances.length - eligible.length,
    queue: projectQueue({ store, instances, cards, nowMs }),
    retryAfterMs,
  };
}

// A run that says "running" but has not moved for this long is a leftover from a
// crash, not work in flight. Without the bound, one such record kept a paused or
// archived project in every scheduler read forever: on V, nine of them
// contributed 168 of the 319 cards read every few seconds.
const STALE_RUNNING_MS = 30 * 60 * 1000;
const TERMINAL_RUN = new Set(["done", "blocked", "cancelled"]);

function runIsLive(run, nowMs) {
  if (run.status !== "running") return false;
  const at = Date.parse(run.updatedAt ?? "");
  return !Number.isFinite(at) || nowMs - at < STALE_RUNNING_MS;
}

/**
 * Card IDs the scheduler needs this pass.
 *
 * `fullSweep` reads everything the projects own, which is what the periodic
 * repair pass wants. A routine pass skips cards whose run already reached a
 * terminal state: three quarters of what was being read could not change, and
 * re-parsing them was the service's largest ongoing cost on the Gateway.
 */
export function schedulerCardIds(store, activeInstances = null, { fullSweep = true, nowMs = Date.now() } = {}) {
  const activeIds = new Set((activeInstances ?? store.listInstances().filter((instance) => instance.status === "active"))
    .map((instance) => instance.id));
  const ids = [];
  for (const instance of store.listInstances()) {
    const runs = [...store.listStageRuns(instance.id), ...store.listContentItemRuns(instance.id)];
    const runCardIds = new Set(runs.map(run => run.cardId));
    const ledger = store.listActionCardIds?.(instance.id) ?? [];
    const include = activeIds.has(instance.id) || runs.some((run) => runIsLive(run, nowMs));
    if (!include) continue;
    for (const run of runs) {
      if (typeof run.cardId !== "string" || !run.cardId) continue;
      // A blocked attempt with a scheduled automatic retry still needs its
      // native card when the retry becomes due, not only at the repair sweep.
      if (!fullSweep && TERMINAL_RUN.has(run.status) && !run.failure?.automaticRetry) continue;
      ids.push(run.cardId);
    }
    // An approval card is not a run, so no run record names it and the terminal
    // filter above can never reach it. The ledger is its only record, and this
    // set is what the idempotency scan gets to look at. Leaving it out is how
    // one project created 4,628 duplicate approval cards in 15 hours on V: each
    // pass failed to find the card it had created on the previous pass. The
    // Runtime also records ordinary run cards here. They were already selected
    // above: adding them again would undo the terminal filter and re-read every
    // completed card every pass (178 of 236 cards on V, 2026-10-16). Cards with
    // no run, including approvals, must remain in the idempotency snapshot.
    for (const cardId of ledger) {
      if (!fullSweep && runCardIds.has(cardId)) continue;
      if (typeof cardId === "string" && cardId) ids.push(cardId);
    }
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

// Card IDs recorded for one project's stage and content-item runs. Every card
// the service created for a project is linked to a run, so this set is the
// project's complete board footprint without listing the whole board.
export function instanceCardIds(store, instanceId) {
  const ids = new Set();
  for (const run of [...store.listStageRuns(instanceId), ...store.listContentItemRuns(instanceId)]) {
    if (typeof run.cardId === "string" && run.cardId) ids.add(run.cardId);
  }
  // Approval cards are not runs, so the ledger is the only record of them. Leave
  // them out and the idempotency scan cannot see them, which is how one project
  // accumulated 1,346 duplicate approval cards in a day.
  for (const cardId of store.listActionCardIds?.(instanceId) ?? []) ids.add(cardId);
  return [...ids];
}

// Card IDs of every project that is not archived. Archived projects keep
// their cards on the native board, but no view or scheduler reads them
// except an explicit governance listing.
export function visibleCardIds(store) {
  const ids = new Set();
  for (const instance of store.listInstances()) {
    if (instance.status === "archived") continue;
    for (const id of instanceCardIds(store, instance.id)) ids.add(id);
  }
  return [...ids];
}
