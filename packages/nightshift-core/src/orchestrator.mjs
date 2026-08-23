import { createHash } from "node:crypto";
import { handoffManifestExample, stageHandoffContract, stageHandoffPath } from "./handoff.mjs";
import { interpolate, stageSkills } from "./workflow.mjs";

const ACTIVE_STATUSES = new Set(["ready", "running"]);
export const WORKBOARD_NOTES_LIMIT = 12000;
const PRESENT_STATUSES = new Set([
  "ready",
  "running",
  "review",
  "blocked",
  "done",
  "skipped",
  "cancelled",
]);

export function planNextActions({
  release,
  instance,
  runs = [],
  contentItems = [],
  contentItemRuns = [],
  now = new Date(),
}) {
  assertInstance(release, instance);
  if (instance.status !== "active") return [];

  const stages = release.spec.stages;
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const latestRuns = latestRunByStage(runs);
  const latestItemRuns = latestRunByContentItemStage(contentItemRuns);
  const activeCount = [...latestRuns.values(), ...latestItemRuns.values()].filter((run) =>
    ACTIVE_STATUSES.has(run.status),
  ).length;
  const limit = release.spec.concurrency?.perInstance ?? 1;
  if (activeCount >= limit) return [];
  const itemById = new Map(contentItems.map((item) => [item.id, item]));
  const reservedResources = activeResourceLocks({ instance, itemById, latestItemRuns, latestRuns, stageById });

  const actions = [];
  for (const stage of stages) {
    if (actions.length + activeCount >= limit) break;
    if ((stage.scope ?? "project") === "content-item") {
      for (const contentItem of contentItems) {
        if (actions.length + activeCount >= limit) break;
        const key = contentItemRunKey(contentItem.id, stage.id);
        const existing = latestItemRuns.get(key);
        if (existing && PRESENT_STATUSES.has(existing.status)) {
          const missingApproval = existing.status === "blocked"
            ? requiredApproval(stage, instance, now, contentItem.id)
            : null;
          if (missingApproval) {
            actions.push({
              type: "request_approval",
              instanceId: instance.id,
              contentItemId: contentItem.id,
              stageId: stage.id,
              approval: missingApproval,
              idempotencyKey: actionKey(release, instance, stage, "approval", contentItem),
            });
          }
          continue;
        }
        if (stage.requiresRoute !== false && !contentItem.route) continue;
        if (!dependenciesDoneForContentItem(stage, stageById, latestRuns, latestItemRuns, contentItem.id)) continue;

        const missingApproval = requiredApproval(stage, instance, now, contentItem.id);
        if (missingApproval) {
          actions.push({
            type: "request_approval",
            instanceId: instance.id,
            contentItemId: contentItem.id,
            stageId: stage.id,
            approval: missingApproval,
            idempotencyKey: actionKey(release, instance, stage, "approval", contentItem),
          });
          continue;
        }
        const type = stage.actor === "human" ? "create_review_card" : "create_workboard_card";
        if (!["agent", "system", "human"].includes(stage.actor)) continue;
        const resourceKey = stage.actor === "human" ? null : stageResourceLock(stage, instance, contentItem);
        if (resourceKey && reservedResources.has(resourceKey)) continue;
        actions.push({
          type,
          instanceId: instance.id,
          contentItemId: contentItem.id,
          stageId: stage.id,
          idempotencyKey: actionKey(release, instance, stage, stage.actor === "human" ? "review" : "run", contentItem),
          card: cardPayload(release, instance, stage, stage.actor === "human" ? "review" : "ready", contentItem, resourceKey),
        });
        if (resourceKey) reservedResources.add(resourceKey);
      }
      continue;
    }
    const existing = latestRuns.get(stage.id);
    if (existing && PRESENT_STATUSES.has(existing.status)) {
      const missingApproval = existing.status === "blocked"
        ? requiredApproval(stage, instance, now)
        : null;
      if (missingApproval) {
        actions.push({
          type: "request_approval",
          instanceId: instance.id,
          stageId: stage.id,
          approval: missingApproval,
          idempotencyKey: actionKey(release, instance, stage, "approval"),
        });
      }
      continue;
    }
    if (!dependenciesDone(stage, latestRuns)) continue;

    if (stage.waitUntil && !timerReady(stage.waitUntil, instance, now)) {
      actions.push({
        type: "schedule_timer",
        instanceId: instance.id,
        stageId: stage.id,
        waitUntil: resolveExpression(stage.waitUntil, instance),
      });
      continue;
    }

    const missingApproval = requiredApproval(stage, instance, now);
    if (missingApproval) {
      actions.push({
        type: "request_approval",
        instanceId: instance.id,
        stageId: stage.id,
        approval: missingApproval,
        idempotencyKey: actionKey(release, instance, stage, "approval"),
      });
      continue;
    }

    if (stage.actor === "human") {
      actions.push({
        type: "create_review_card",
        instanceId: instance.id,
        stageId: stage.id,
        idempotencyKey: actionKey(release, instance, stage, "review"),
        card: cardPayload(release, instance, stage, "review"),
      });
      continue;
    }

    if (stage.actor === "agent" || stage.actor === "system") {
      const resourceKey = stageResourceLock(stage, instance);
      if (resourceKey && reservedResources.has(resourceKey)) continue;
      actions.push({
        type: "create_workboard_card",
        instanceId: instance.id,
        stageId: stage.id,
        idempotencyKey: actionKey(release, instance, stage, "run"),
        card: cardPayload(release, instance, stage, "ready", null, resourceKey),
      });
      if (resourceKey) reservedResources.add(resourceKey);
    }
  }

  return actions;
}

function cardPayload(release, instance, stage, status, contentItem = null, resourceKey = null) {
  const inputHash = instance.inputHash ?? hashJson(instance.inputs ?? {});
  const agentRole = stage.agentRole ?? release.spec.ownerAgentRole;
  const assignedAgent = stage.actor === "agent" ? instance.agentBindings?.[agentRole] : null;
  if (stage.actor === "agent" && !assignedAgent) {
    throw new Error(`Missing agent binding for role ${agentRole}`);
  }
  return {
    title: contentItem
      ? `${instance.name ?? instance.id}｜${contentItem.title}｜${stage.title}`
      : `${instance.name ?? instance.id}｜${stage.title}`,
    status,
    assignedAgent,
    notes: buildAgentBrief(release, instance, stage, contentItem),
    labels: [
      `workflow:${release.metadata.id}`,
      `release:${release.metadata.workflowSha256.slice(0, 12)}`,
      `instance:${instance.id}`,
      `stage:${stage.id}`,
      ...(contentItem ? [`content-item:${contentItem.id}`, `route:${contentItem.route ?? "UNROUTED"}`] : []),
    ],
    automation: {
      workflowId: release.metadata.id,
      workflowVersion: release.metadata.version,
      workflowSha256: release.metadata.workflowSha256,
      agentRole,
      instanceId: instance.id,
      stageId: stage.id,
      contentItemId: contentItem?.id ?? null,
      contentRoute: contentItem?.route ?? null,
      inputHash,
      skills: stageSkills(stage, contentItem?.route),
      maxRuntime: stage.timeout,
      maxRuntimeSeconds: stageTimeoutSeconds(stage.timeout),
      maxAttempts: stage.retry?.maxAttempts ?? 1,
      resourceKey,
    },
  };
}

function activeResourceLocks({ instance, itemById, latestItemRuns, latestRuns, stageById }) {
  const locks = new Set();
  for (const run of latestRuns.values()) {
    if (!ACTIVE_STATUSES.has(run.status)) continue;
    const key = stageResourceLock(stageById.get(run.stageId), instance);
    if (key) locks.add(key);
  }
  for (const run of latestItemRuns.values()) {
    if (!ACTIVE_STATUSES.has(run.status)) continue;
    const key = stageResourceLock(stageById.get(run.stageId), instance, itemById.get(run.contentItemId));
    if (key) locks.add(key);
  }
  return locks;
}

function stageResourceLock(stage, instance, contentItem = null) {
  if (!stage?.resourceLock) return null;
  return interpolate(stage.resourceLock, {
    contentItem: contentItem ?? {},
    input: instance.inputs ?? {},
    instance,
    stage,
  });
}

export function stageTimeoutSeconds(value) {
  const match = /^\s*(\d+)\s*([smhd])\s*$/i.exec(String(value ?? ""));
  if (!match) throw new Error(`Unsupported stage timeout ${value}`);
  const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(match[1]) * unitSeconds[match[2].toLowerCase()];
}

export function buildAgentBrief(release, instance, stage, contentItem = null) {
  const safeInputs = redactSensitiveInputs(instance.inputs ?? {});
  const projectInputsPath = instance.inputs?.nightshift?.projectInputsPath;
  const inlineInputs = projectInputsPath ? summarizeInputs(safeInputs) : safeInputs;
  const strategy = contentItem?.route ? stage.routeStrategies?.[contentItem.route] : null;
  const instanceDir = instance.inputs?.nightshift?.instanceDir;
  const itemDir = contentItem && instanceDir ? `${instanceDir}/content-items/${contentItem.id}` : null;
  const handoffEnabled = release.spec?.handoff?.version === 1 && instanceDir;
  const handoffContract = handoffEnabled ? stageHandoffContract(release, stage.id) : null;
  const handoffPath = handoffEnabled ? stageHandoffPath({
    instanceDir,
    contentItemId: contentItem?.id ?? null,
    release,
    stageId: stage.id,
  }) : null;
  const upstreamHandoffPaths = handoffEnabled ? handoffContract.previous.map((upstream) => stageHandoffPath({
    instanceDir,
    contentItemId: contentItem?.id ?? null,
    release,
    stageId: upstream.id,
  })) : [];
  const exactApprovalRecorded = Boolean(stage.approval?.before) && !requiredApproval(stage, instance, new Date(), contentItem?.id ?? null);
  const approvalBinding = exactApprovalRecorded ? resolveApprovalBinding(stage, instance, contentItem?.id ?? null) : null;
  const lines = [
    `Night Shift workflow: ${release.metadata.name} (${release.metadata.version})`,
    `Instance: ${instance.id}`,
    `Stage: ${stage.id} — ${stage.title}`,
    ...(contentItem ? [`Content item: ${JSON.stringify(summarizeContentItem(contentItem))}`] : []),
    `Objective: ${strategy?.description ?? stage.description ?? "Complete the declared stage."}`,
    `Required skills (load in order): ${stageSkills(stage, contentItem?.route).join(", ") || "none"}`,
    `Input summary: ${JSON.stringify(inlineInputs)}`,
    ...(projectInputsPath
      ? [`Authoritative project inputs: read ${projectInputsPath} before acting. The snapshot contains the complete redacted project brief and constraints; do not replace it with this summary.`]
      : []),
    ...(stage.id === "plan" && instance.inputs?.nightshift?.contentItemsManifestPath
      ? [`Content backlog contract: write {"contentItems":[{"id":"stable-id","title":"...","route":"AI_GENERATE|SCENE_EDIT|null","status":"planned|routing"}]} to ${instance.inputs.nightshift.contentItemsManifestPath}. The control plane imports this file and fans out Workboard tasks.`]
      : []),
    ...(stage.id === "route" && instance.inputs?.nightshift?.contentItemsManifestPath
      ? [`Route writeback contract: update only this ContentItem in ${instance.inputs.nightshift.contentItemsManifestPath}; preserve every other item and stable id.`]
      : []),
    ...(itemDir ? [`Content item artifact directory: ${itemDir}`] : []),
    ...(handoffEnabled ? [
      `Stage handoff inputs: ${upstreamHandoffPaths.length > 0 ? `read ${upstreamHandoffPaths.join(", ")} and every artifact they reference before acting` : "use the declared project inputs as the authoritative source"}.`,
      `Stage handoff output: after finishing the declared outputs, write ${handoffPath} using exactly this v1 shape: ${JSON.stringify(handoffManifestExample({ instanceId: instance.id, contentItemId: contentItem?.id ?? null, release, stageId: stage.id }))}`,
      "The handoff summary is for people; the referenced artifacts are authoritative. Do not silently drop, rewrite, or replace an upstream requirement.",
    ] : []),
    ...(stage.outputs?.includes("deliveryManifest") && itemDir
      ? [`Delivery contract: write exactly this v1 shape to ${itemDir}/deliverables.json (paths are relative to ${itemDir}): ${JSON.stringify(deliveryManifestExample(instance.id, contentItem))}`]
      : []),
    `Required outputs: ${(stage.outputs ?? []).join(", ") || "none"}`,
    ...(exactApprovalRecorded ? [
      `Execution authorization: a later, exact Workboard approval is recorded for ${stage.approval.before} with scope ${stage.approval.scope ?? "stage"}${contentItem ? ` on content item ${contentItem.id}` : ""}. It intentionally opens only this approved action after the project's default-deny baseline; do not treat that earlier baseline as a conflict and do not edit the project inputs.`,
      ...(approvalBinding && Object.keys(approvalBinding.values).length > 0
        ? [`Immutable approval bindings: ${JSON.stringify(redactSensitiveInputs(approvalBinding.values))}. Use this exact target; never guess or substitute another account or device.`]
        : []),
    ] : []),
    ...(release.spec?.completion?.mode === "strict-v1" ? [
      "Strict completion: the control plane will load every declared output artifact and evaluate every completeWhen rule from this Workflow. A summary, internal substitute, or claimed success cannot complete the card. JSON facts must be booleans or concrete values; URL outputs must put the real HTTPS URL directly in the handoff artifact field.",
      ...Object.entries(stage.outputContracts ?? {}).map(([name, contract]) => `Output contract ${name}: ${JSON.stringify(contract)}`),
    ] : []),
    ...(stage.id === "brief" && itemDir ? [
      `Brief output contract: read ${itemDir}/routeDecision.json and ${itemDir}/frozenInputManifest.json, then write ${itemDir}/finishedVideoBrief.md. It must explicitly record routeMatchesContentItem, inputsFrozen, and productionReady; include target duration, narrative structure, a shot table bound to exact frozen source_url/start_sec/end_sec values, TTS or no-TTS behavior, subtitle/audio rules, missing-footage handling, and final QC acceptance. Do not inspect Night Shift source code to infer this contract.`,
    ] : []),
    `Completion checks: ${(stage.completeWhen ?? []).join("; ") || "human decision"}`,
    `Safety: ${(stage.sideEffects ?? []).length ? `requires approved side effects: ${stage.sideEffects.join(", ")}` : "no declared external side effect"}`,
    "Workboard completion safety: Never probe, test, or enumerate completion RPCs, and never use placeholder input such as summary=test. Finish every required output and verify every completion check first. Then call workboard_complete exactly once; if unavailable in an isolated Worker, call `openclaw gateway call workboard.cards.complete` exactly once with the real card id, claim token, and evidence summary. Block exactly once only for a genuine blocker. Do not search source code or inspect plugin internals. Never print the claim token.",
    "Return a concise result with evidence links or an explicit blocker. Do not invent missing evidence.",
  ];
  const brief = lines.join("\n");
  if (brief.length > WORKBOARD_NOTES_LIMIT) {
    throw new Error(`Night Shift card brief exceeds the native Workboard ${WORKBOARD_NOTES_LIMIT} character limit (${brief.length})`);
  }
  return brief;
}

function deliveryManifestExample(instanceId, contentItem) {
  return {
    version: 1,
    instanceId,
    contentItemId: contentItem.id,
    title: contentItem.title,
    proposal: { title: "策划与执行方案", externalUrl: null, summaryPath: "finishedVideoBrief.md" },
    video: {
      title: "最终成片",
      path: "produce/final.mp4",
      posterPath: null,
      mimeType: "video/mp4",
      durationSeconds: 26,
      width: 1080,
      height: 1920,
      sha256: "actual-sha256",
      projectUrl: null,
    },
    qc: { status: "passed", reportPath: "produce/machineQc.json", summary: ["完整解码通过"] },
    review: { stageId: "review", status: "review" },
  };
}

export function redactSensitiveInputs(value, key = "") {
  if (/(secret|token|password|credential|api.?key)/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveInputs(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactSensitiveInputs(child, childKey),
      ]),
    );
  }
  return value;
}

function summarizeInputs(inputs) {
  const keys = [
    "customerId",
    "customerName",
    "briefUrl",
    "sceneProjectId",
    "targetVideoCount",
    "authorizationScope",
    "publicationTarget",
    "nightshift",
  ];
  return Object.fromEntries(keys.filter((key) => inputs[key] !== undefined).map((key) => [key, inputs[key]]));
}

function summarizeContentItem(contentItem) {
  return redactSensitiveInputs({
    id: contentItem.id,
    title: contentItem.title,
    route: contentItem.route ?? null,
    status: contentItem.status ?? null,
  });
}

function actionKey(release, instance, stage, action, contentItem = null) {
  const inputHash = instance.inputHash ?? hashJson(instance.inputs ?? {});
  const template = stage.retry?.idempotencyKey;
  const logicalKey = template
    ? interpolate(template, {
        account: instance.account ?? {},
        asset: instance.asset ?? {},
        input: { ...(instance.inputs ?? {}), hash: inputHash },
        instance,
        contentItem: contentItem ?? {},
        stage,
      })
    : `${instance.id}:${contentItem?.id ?? "project"}:${stage.id}:${inputHash}`;
  return `${release.metadata.workflowSha256}:${action}:${logicalKey}`;
}

export function requiredApproval(stage, instance, now, contentItemId = null) {
  if (!stage.approval?.before) return null;
  const approvals = Array.isArray(instance.approvals) ? instance.approvals : [];
  const requiredScope = stage.approval.scope ?? "stage";
  const binding = resolveApprovalBinding(stage, instance, contentItemId);
  const accepted = binding.missingFields.length === 0 && approvals.some((approval) => {
    if (approval.status !== "approved") return false;
    if (approval.stageId && approval.stageId !== stage.id) return false;
    if ((approval.contentItemId ?? null) !== contentItemId) return false;
    if (approval.effect !== stage.approval.before) return false;
    if (approval.scope !== requiredScope) return false;
    if (binding.bindingHash && approval.bindingHash !== binding.bindingHash) return false;
    if (approval.expiresAt && new Date(approval.expiresAt) <= now) return false;
    return true;
  });
  if (accepted) return null;
  return {
    effect: stage.approval.before,
    scope: requiredScope,
    ...(Object.keys(binding.values).length > 0 ? { bindings: redactSensitiveInputs(binding.values) } : {}),
    ...(binding.bindingHash ? { bindingHash: binding.bindingHash } : {}),
    ...(binding.missingFields.length > 0 ? { missingFields: binding.missingFields } : {}),
  };
}

export function resolveApprovalBinding(stage, instance, contentItemId = null) {
  const bindings = stage.approval?.bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    return { bindingHash: null, missingFields: [], values: {} };
  }
  const values = {};
  const missingFields = [];
  for (const [name, binding] of Object.entries(bindings)) {
    const value = resolvePath({ input: instance.inputs ?? {}, instance }, binding.source);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      missingFields.push(name);
      continue;
    }
    values[name] = value;
    for (const field of binding.requiredFields ?? []) {
      const fieldValue = resolvePath(value, field);
      if (fieldValue === undefined || fieldValue === null || fieldValue === "") {
        missingFields.push(`${name}.${field}`);
      }
    }
  }
  const payload = { contentItemId, stageId: stage.id, values };
  return {
    bindingHash: missingFields.length === 0 ? hashJson(payload) : null,
    missingFields: [...new Set(missingFields)],
    values,
  };
}

function resolvePath(root, path) {
  if (typeof path !== "string" || !path.trim()) return undefined;
  return path.split(".").reduce((value, key) => value?.[key], root);
}

function timerReady(expression, instance, now) {
  const resolved = resolveExpression(expression, instance);
  const timestamp = new Date(resolved);
  return !Number.isNaN(timestamp.valueOf()) && timestamp <= now;
}

function resolveExpression(expression, instance) {
  return interpolate(expression, { input: instance.inputs ?? {}, instance });
}

function dependenciesDone(stage, latestRuns) {
  return (stage.needs ?? []).every(
    (dependency) => latestRuns.get(dependency)?.status === "done",
  );
}

function dependenciesDoneForContentItem(stage, stageById, projectRuns, itemRuns, contentItemId) {
  return (stage.needs ?? []).every((dependency) => {
    const dependencyStage = stageById.get(dependency);
    if ((dependencyStage?.scope ?? "project") === "content-item") {
      return itemRuns.get(contentItemRunKey(contentItemId, dependency))?.status === "done";
    }
    return projectRuns.get(dependency)?.status === "done";
  });
}

function latestRunByStage(runs) {
  const latest = new Map();
  for (const run of runs) {
    const previous = latest.get(run.stageId);
    if (!previous || (run.attempt ?? 0) > (previous.attempt ?? 0)) {
      latest.set(run.stageId, run);
    }
  }
  return latest;
}

function latestRunByContentItemStage(runs) {
  const latest = new Map();
  for (const run of runs) {
    const key = contentItemRunKey(run.contentItemId, run.stageId);
    const previous = latest.get(key);
    if (!previous || (run.attempt ?? 0) > (previous.attempt ?? 0)) latest.set(key, run);
  }
  return latest;
}

function contentItemRunKey(contentItemId, stageId) {
  return `${contentItemId}\u0000${stageId}`;
}

function assertInstance(release, instance) {
  if (!release?.metadata?.workflowSha256) {
    throw new Error("A compiled WorkflowRelease is required");
  }
  if (!instance?.id) throw new Error("instance.id is required");
  if (
    instance.workflowSha256 &&
    instance.workflowSha256 !== release.metadata.workflowSha256
  ) {
    throw new Error("Instance is pinned to a different workflow release");
  }
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
