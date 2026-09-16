import { createHash } from "node:crypto";

const SECRET_KEY = /(authorization|cookie|credential|password|secret|signature|token)/i;
const PRIVATE_STRING = /(?:https?:\/\/|wss?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\/(?:home|Users|root|opt|var)\/)/i;
const SAFE_ENUM = /^[A-Za-z0-9_.:@/-]{1,64}$/;

export function createReplaySnapshot({ bootstrap, instances, cards, capturedAt = new Date().toISOString(), sourceRelease = null }) {
  const allInstances = Array.isArray(instances?.instances) ? instances.instances : [];
  const allCards = Array.isArray(cards?.cards) ? cards.cards : [];
  const workflows = Array.isArray(bootstrap?.workflows) ? bootstrap.workflows : [];
  const visibleInstanceDetails = new Map((bootstrap?.instances ?? []).map((instance) => [instance.id, instance]));
  return {
    schema: "nightshift.replay.v1",
    capturedAt,
    source: {
      cards: allCards.length,
      instances: allInstances.length,
      visibleCards: Array.isArray(bootstrap?.cards) ? bootstrap.cards.length : 0,
      visibleInstances: Array.isArray(bootstrap?.instances) ? bootstrap.instances.length : 0,
      workflows: workflows.length,
      releaseCommit: sourceRelease,
    },
    workflows: workflows.map(replayWorkflow),
    instances: allInstances.map((instance) => replayInstance({ ...instance, ...visibleInstanceDetails.get(instance.id) })),
    cards: allCards.map(replayCard),
  };
}

export function replaySnapshotMetrics(snapshot) {
  return {
    cards: snapshot.cards.length,
    instances: snapshot.instances.length,
    workflows: snapshot.workflows.length,
    cardStatuses: counts(snapshot.cards.map((card) => card.status)),
    instanceStatuses: counts(snapshot.instances.map((instance) => instance.status)),
    sessionAttempts: snapshot.cards.reduce((total, card) => total + card.attempts.length, 0),
  };
}

function replayWorkflow(workflow) {
  const manifest = workflow.manifest ?? {};
  return {
    workflowSha256: workflow.workflowSha256,
    workflowId: manifest.metadata?.id ?? workflow.workflowId,
    version: manifest.metadata?.version ?? workflow.version,
    publishedAt: workflow.publishedAt,
    structure: redact({
      apiVersion: manifest.apiVersion,
      kind: manifest.kind,
      metadata: manifest.metadata,
      spec: manifest.spec,
    }),
  };
}

function replayInstance(instance) {
  return {
    id: alias("instance", instance.id),
    workflowSha256: instance.workflowSha256,
    status: instance.status,
    control: redact(instance.control),
    inputs: redact(instance.inputs),
    agentBindings: redact(instance.agentBindings),
    approvals: (instance.approvals ?? []).map((approval) => redact({
      ...approval,
      id: alias("approval", approval.id),
      instanceId: alias("instance", approval.instanceId),
      cardId: alias("card", approval.cardId),
    })),
    contentItems: (instance.contentItems ?? []).map((item) => redact({
      ...item,
      id: alias("item", item.id),
      instanceId: alias("instance", item.instanceId ?? instance.id),
      title: item.title ? `[title:${digest(item.title)}]` : null,
    })),
    contentItemRuns: (instance.contentItemRuns ?? []).map(replayRun),
    stageRuns: (instance.stageRuns ?? []).map(replayRun),
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

function replayRun(run) {
  return redact({
    ...run,
    instanceId: alias("instance", run.instanceId),
    contentItemId: alias("item", run.contentItemId),
    cardId: alias("card", run.cardId),
    summary: run.summary ? `[summary:${digest(run.summary)}]` : null,
  });
}

function replayCard(card) {
  const attempts = Array.isArray(card.metadata?.attempts) ? card.metadata.attempts : [];
  const currentAttempt = card.sessionKey || card.runId
    ? [{ sessionKey: card.sessionKey, runId: card.runId, status: card.execution?.status }]
    : [];
  return {
    id: alias("card", card.id),
    status: card.status,
    priority: card.priority,
    agentId: card.agentId,
    parents: (card.parents ?? []).map((id) => alias("card", id)),
    labels: (card.labels ?? []).map(replayLabel),
    automation: redact(card.metadata?.automation ?? {}),
    execution: redact({
      ...card.execution,
      id: alias("execution", card.execution?.id),
      runId: alias("run", card.execution?.runId),
      sessionKey: alias("session", card.execution?.sessionKey),
    }),
    attempts: [...attempts, ...currentAttempt].map((attempt) => ({
      runId: alias("run", attempt.runId),
      sessionKey: alias("session", attempt.sessionKey),
      status: attempt.status ?? attempt.stopReason ?? null,
      startedAt: attempt.startedAt ?? null,
      endedAt: attempt.endedAt ?? null,
      error: attempt.error || attempt.errorMessage ? `[error:${digest(attempt.error ?? attempt.errorMessage)}]` : null,
    })),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function replayLabel(label) {
  const [kind, ...parts] = String(label).split(":");
  const value = parts.join(":");
  if (["instance", "content-item"].includes(kind)) return `${kind}:${alias(kind === "instance" ? "instance" : "item", value)}`;
  return redact(label);
}

function redact(value, key = "") {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value ?? null;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, key));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      SECRET_KEY.test(childKey) ? "[redacted]" : redact(child, childKey),
    ]));
  }
  const text = String(value);
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (PRIVATE_STRING.test(text) || text.length > 96 || !SAFE_ENUM.test(text)) return `[value:${digest(text)}]`;
  return text;
}

function alias(kind, value) {
  return value ? `${kind}-${digest(String(value))}` : null;
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function counts(values) {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((entry) => entry === value).length]));
}
