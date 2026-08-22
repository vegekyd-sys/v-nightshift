import { createHash } from "node:crypto";
import { interpolate, stageSkills } from "./workflow.mjs";

const ACTIVE_STATUSES = new Set(["ready", "running"]);
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

  const actions = [];
  for (const stage of stages) {
    if (actions.length + activeCount >= limit) break;
    if ((stage.scope ?? "project") === "content-item") {
      for (const contentItem of contentItems) {
        if (actions.length + activeCount >= limit) break;
        const key = contentItemRunKey(contentItem.id, stage.id);
        const existing = latestItemRuns.get(key);
        if (existing && PRESENT_STATUSES.has(existing.status)) continue;
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
        actions.push({
          type,
          instanceId: instance.id,
          contentItemId: contentItem.id,
          stageId: stage.id,
          idempotencyKey: actionKey(release, instance, stage, stage.actor === "human" ? "review" : "run", contentItem),
          card: cardPayload(release, instance, stage, stage.actor === "human" ? "review" : "ready", contentItem),
        });
      }
      continue;
    }
    const existing = latestRuns.get(stage.id);
    if (existing && PRESENT_STATUSES.has(existing.status)) continue;
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
      actions.push({
        type: "create_workboard_card",
        instanceId: instance.id,
        stageId: stage.id,
        idempotencyKey: actionKey(release, instance, stage, "run"),
        card: cardPayload(release, instance, stage, "ready"),
      });
    }
  }

  return actions;
}

function cardPayload(release, instance, stage, status, contentItem = null) {
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
      maxAttempts: stage.retry?.maxAttempts ?? 1,
    },
  };
}

export function buildAgentBrief(release, instance, stage, contentItem = null) {
  const safeInputs = redactSensitiveInputs(instance.inputs ?? {});
  const strategy = contentItem?.route ? stage.routeStrategies?.[contentItem.route] : null;
  const instanceDir = instance.inputs?.nightshift?.instanceDir;
  const itemDir = contentItem && instanceDir ? `${instanceDir}/content-items/${contentItem.id}` : null;
  return [
    `Night Shift workflow: ${release.metadata.name} (${release.metadata.version})`,
    `Instance: ${instance.id}`,
    `Stage: ${stage.id} — ${stage.title}`,
    ...(contentItem ? [`Content item: ${JSON.stringify(redactSensitiveInputs(contentItem))}`] : []),
    `Objective: ${strategy?.description ?? stage.description ?? "Complete the declared stage."}`,
    `Required skills (load in order): ${stageSkills(stage, contentItem?.route).join(", ") || "none"}`,
    `Inputs: ${JSON.stringify(safeInputs)}`,
    ...(stage.id === "plan" && instance.inputs?.nightshift?.contentItemsManifestPath
      ? [`Content backlog contract: write {"contentItems":[{"id":"stable-id","title":"...","route":"AI_GENERATE|SCENE_EDIT|null","status":"planned|routing"}]} to ${instance.inputs.nightshift.contentItemsManifestPath}. The control plane imports this file and fans out Workboard tasks.`]
      : []),
    ...(stage.id === "route" && instance.inputs?.nightshift?.contentItemsManifestPath
      ? [`Route writeback contract: update only this ContentItem in ${instance.inputs.nightshift.contentItemsManifestPath}; preserve every other item and stable id.`]
      : []),
    ...(itemDir ? [`Content item artifact directory: ${itemDir}`] : []),
    ...(stage.outputs?.includes("deliveryManifest") && itemDir
      ? [`Delivery contract: write exactly this v1 shape to ${itemDir}/deliverables.json (paths are relative to ${itemDir}): ${JSON.stringify(deliveryManifestExample(instance.id, contentItem))}`]
      : []),
    `Required outputs: ${(stage.outputs ?? []).join(", ") || "none"}`,
    `Completion checks: ${(stage.completeWhen ?? []).join("; ") || "human decision"}`,
    `Safety: ${(stage.sideEffects ?? []).length ? `requires approved side effects: ${stage.sideEffects.join(", ")}` : "no declared external side effect"}`,
    "Return a concise result with evidence links or an explicit blocker. Do not invent missing evidence.",
  ].join("\n").slice(0, 8000);
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

function redactSensitiveInputs(value, key = "") {
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

function requiredApproval(stage, instance, now, contentItemId = null) {
  if (!stage.approval?.before) return null;
  const approvals = Array.isArray(instance.approvals) ? instance.approvals : [];
  const accepted = approvals.some((approval) => {
    if (approval.status !== "approved") return false;
    if (approval.stageId && approval.stageId !== stage.id) return false;
    if ((approval.contentItemId ?? null) !== contentItemId) return false;
    if (approval.effect && approval.effect !== stage.approval.before) return false;
    if (approval.expiresAt && new Date(approval.expiresAt) <= now) return false;
    return true;
  });
  if (accepted) return null;
  return {
    effect: stage.approval.before,
    scope: stage.approval.scope ?? "stage",
  };
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
