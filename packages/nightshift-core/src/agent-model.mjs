// Which model Night Shift's Agent sessions run on.
//
// Unset, a card's session runs on the Gateway's default model, like any other
// session on V. On V that default moved to /vds (Codex + DeepSeek) in 2026-11,
// and batch video cards followed it. Night Shift can now name its own model,
// for every project (service setting) or for one project (project setting);
// the project setting wins.
//
// The model is pinned with the Gateway's own sessions.patch on the card's
// session before the board starts it, the same per-session selection /model
// makes. A pinned session keeps the model for every later turn of the card:
// wake-ups, retries and Gateway restart recovery start runs without naming a
// model, and a per-run model would drop back to the default there.

export const AGENT_MODEL_STATE_KEY = "agentModel";
const MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const MODEL_REF_MAX = 160;

// A provider/model reference, or null for "not set". The Gateway decides
// whether it knows the model when the card's session is pinned.
export function normalizeAgentModel(value) {
  if (value === null || value === undefined || value === "default") return null;
  if (typeof value !== "string") throw new Error("model must be a provider/model string, or null / \"default\"");
  const model = value.trim();
  if (!model || model === "default") return null;
  if (model.length > MODEL_REF_MAX || !MODEL_REF.test(model)) {
    throw new Error(`model must be a provider/model reference such as deepseek/deepseek-v4-flash (got ${JSON.stringify(value.slice(0, 80))})`);
  }
  return model;
}

export function serviceAgentModel(store) {
  const state = store.getServiceState(AGENT_MODEL_STATE_KEY);
  return typeof state?.model === "string" && state.model ? state.model : null;
}

// The model a project's cards run on and where it came from.
export function resolveAgentModel(store, instanceId) {
  const project = instanceId ? store.getInstanceControl(instanceId).agentModel ?? null : null;
  const nightshift = serviceAgentModel(store);
  const effective = project ?? nightshift;
  return {
    effective,
    source: project ? "project" : nightshift ? "nightshift" : "gateway-default",
    project,
    nightshift,
  };
}

// The Workboard's session key for a card (extensions/workboard/src/session-link.ts,
// workboardSessionKeyForCard). The board starts the card's run on exactly this
// key, so a model pinned here is the one its first turn uses.
export function workboardSessionKeyForCard(card) {
  const boardId = sessionSegment(card.metadata?.automation?.boardId, "default");
  const cardId = sessionSegment(card.id, "card");
  const suffix = `subagent:workboard-${boardId}-${cardId}`;
  return card.agentId ? `agent:${sessionSegment(card.agentId, "agent")}:${suffix}` : suffix;
}

function sessionSegment(value, fallback) {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (sanitized || fallback).slice(0, 96);
}

// The order the board picks ready cards in (extensions/workboard/src/dispatcher.ts,
// sortReadyCards).
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
export function workboardStartOrder(a, b) {
  return (PRIORITY_RANK[a.priority] ?? PRIORITY_RANK.normal) - (PRIORITY_RANK[b.priority] ?? PRIORITY_RANK.normal)
    || (a.position ?? 0) - (b.position ?? 0)
    || (a.createdAt ?? 0) - (b.createdAt ?? 0);
}
