const PURPOSES = new Set(["production", "test", "acceptance", "canary"]);

const DEFAULT_RETENTION_DAYS = Object.freeze({
  production: null,
  test: 7,
  acceptance: 14,
  canary: 3,
});

export function normalizeProjectGovernance(project = {}, now = new Date()) {
  const supplied = project.governance ?? project.inputs?.governance ?? {};
  const inferred = inferProjectPurpose(project);
  const explicitPurpose = typeof supplied.purpose === "string" ? supplied.purpose.toLowerCase() : null;
  const purpose = PURPOSES.has(explicitPurpose) ? explicitPurpose : inferred.purpose;
  const retentionDays = positiveDays(supplied.retentionDays) ?? DEFAULT_RETENTION_DAYS[purpose];
  const createdAt = validDate(project.createdAt) ?? now;
  const suppliedExpiry = validDate(supplied.expiresAt);
  return {
    purpose,
    retentionDays,
    expiresAt: suppliedExpiry?.toISOString() ?? (retentionDays ? new Date(createdAt.getTime() + retentionDays * 86_400_000).toISOString() : null),
    classificationSource: typeof supplied.classificationSource === "string" ? supplied.classificationSource : PURPOSES.has(explicitPurpose) ? "explicit" : inferred.source,
  };
}

export function auditNightShiftGovernance({ cards = [], instances = [], now = new Date() } = {}) {
  const nowMs = now.getTime();
  const byInstance = new Map(instances.map((instance) => [instance.id, []]));
  const orphanCards = [];
  for (const card of cards) {
    const instanceId = cardInstanceId(card);
    if (instanceId && byInstance.has(instanceId)) byInstance.get(instanceId).push(card);
    else orphanCards.push(cardSummary(card));
  }
  const projects = instances.map((instance) => {
    const projectCards = byInstance.get(instance.id) ?? [];
    const governance = normalizeProjectGovernance(instance, now);
    const running = projectCards.filter((card) => card.status === "running").length;
    const expired = Boolean(governance.expiresAt && Date.parse(governance.expiresAt) <= nowMs);
    return {
      id: instance.id,
      name: instance.name,
      status: instance.status,
      governance,
      cardCount: projectCards.length,
      running,
      archiveCandidate: expired && running === 0 && instance.status !== "active" && instance.status !== "archived",
    };
  });
  const archivedIds = new Set(instances.filter((instance) => instance.status === "archived").map((instance) => instance.id));
  const duplicateActionGroups = duplicateGroups(cards.filter((card) => !archivedIds.has(cardInstanceId(card))));
  return {
    generatedAt: now.toISOString(),
    summary: {
      projects: instances.length,
      cards: cards.length,
      archiveCandidates: projects.filter((project) => project.archiveCandidate).length,
      duplicateActionGroups: duplicateActionGroups.length,
      duplicateExcessCards: duplicateActionGroups.reduce((sum, group) => sum + group.excessCount, 0),
      orphanCards: orphanCards.length,
    },
    archiveCandidates: projects.filter((project) => project.archiveCandidate),
    duplicateActionGroups,
    orphanCards,
  };
}

export function validateGovernanceManifest(manifest, { cards = [], instances = [] } = {}) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.projects) || manifest.projects.length === 0) {
    throw new Error("Governance manifest must be version 1 with a non-empty projects array");
  }
  const ids = manifest.projects.map((entry) => entry?.id);
  if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error("Governance manifest project ids must be unique non-empty strings");
  }
  const instanceById = new Map(instances.map((instance) => [instance.id, instance]));
  return manifest.projects.map((expected) => {
    const instance = instanceById.get(expected.id);
    if (!instance) throw new Error(`Governance project not found: ${expected.id}`);
    const projectCards = cards.filter((card) => cardInstanceId(card) === expected.id);
    const running = projectCards.filter((card) => card.status === "running").length;
    if (running > 0) throw new Error(`Governance project ${expected.id} has ${running} running cards`);
    if (expected.expectedStatus && instance.status !== expected.expectedStatus && instance.status !== "archived") {
      throw new Error(`Governance project ${expected.id} status changed: expected ${expected.expectedStatus}, found ${instance.status}`);
    }
    if (Number.isSafeInteger(expected.expectedCardCount) && projectCards.length !== expected.expectedCardCount) {
      throw new Error(`Governance project ${expected.id} card count changed: expected ${expected.expectedCardCount}, found ${projectCards.length}`);
    }
    return {
      id: expected.id,
      name: instance.name,
      status: instance.status,
      cardCount: projectCards.length,
      alreadyArchived: instance.status === "archived",
    };
  });
}

function inferProjectPurpose(project) {
  const text = `${project.id ?? ""} ${project.name ?? ""}`.toLowerCase();
  if (/canary|金丝雀/.test(text)) return { purpose: "canary", source: "inferred" };
  if (/accept|验收|validation|regression|smoke|回归/.test(text)) return { purpose: "acceptance", source: "inferred" };
  if (/(^|[^a-z])test([^a-z]|$)|(^|[^a-z])lab([^a-z]|$)|测试|演练/.test(text)) return { purpose: "test", source: "inferred" };
  return { purpose: "production", source: "default" };
}

function duplicateGroups(cards) {
  const groups = new Map();
  for (const card of cards) {
    const action = (card.labels ?? []).find((label) => label.startsWith("nightshift-action:"));
    if (!action) continue;
    const group = groups.get(action) ?? [];
    group.push(card);
    groups.set(action, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([action, group]) => ({
      action,
      instanceId: cardInstanceId(group[0]),
      cardCount: group.length,
      excessCount: group.length - 1,
      cards: group.map(cardSummary),
    }))
    .sort((left, right) => right.excessCount - left.excessCount || left.action.localeCompare(right.action));
}

function cardInstanceId(card) {
  return card.metadata?.automation?.instanceId ??
    (card.labels ?? []).find((label) => label.startsWith("instance:"))?.slice("instance:".length) ??
    null;
}

function cardSummary(card) {
  return { id: card.id, status: card.status, title: card.title, instanceId: cardInstanceId(card) };
}

function positiveDays(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? "");
  return Number.isNaN(date.getTime()) ? null : date;
}
