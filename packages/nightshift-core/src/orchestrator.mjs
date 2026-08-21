import { createHash } from "node:crypto";
import { interpolate } from "./workflow.mjs";

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

export function planNextActions({ release, instance, runs = [], now = new Date() }) {
  assertInstance(release, instance);
  if (instance.status !== "active") return [];

  const stages = release.spec.stages;
  const latestRuns = latestRunByStage(runs);
  const activeCount = [...latestRuns.values()].filter((run) =>
    ACTIVE_STATUSES.has(run.status),
  ).length;
  const limit = release.spec.concurrency?.perInstance ?? 1;
  if (activeCount >= limit) return [];

  const actions = [];
  for (const stage of stages) {
    if (actions.length + activeCount >= limit) break;
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

function cardPayload(release, instance, stage, status) {
  const inputHash = instance.inputHash ?? hashJson(instance.inputs ?? {});
  const agentRole = stage.agentRole ?? release.spec.ownerAgentRole;
  const assignedAgent = stage.actor === "agent" ? instance.agentBindings?.[agentRole] : null;
  if (stage.actor === "agent" && !assignedAgent) {
    throw new Error(`Missing agent binding for role ${agentRole}`);
  }
  return {
    title: `${instance.name ?? instance.id}｜${stage.title}`,
    status,
    assignedAgent,
    labels: [
      `workflow:${release.metadata.id}`,
      `release:${release.metadata.workflowSha256.slice(0, 12)}`,
      `instance:${instance.id}`,
      `stage:${stage.id}`,
    ],
    automation: {
      workflowId: release.metadata.id,
      workflowVersion: release.metadata.version,
      workflowSha256: release.metadata.workflowSha256,
      agentRole,
      instanceId: instance.id,
      stageId: stage.id,
      inputHash,
      skills: stage.skill ? [stage.skill] : [],
      maxRuntime: stage.timeout,
      maxAttempts: stage.retry?.maxAttempts ?? 1,
    },
  };
}

function actionKey(release, instance, stage, action) {
  const inputHash = instance.inputHash ?? hashJson(instance.inputs ?? {});
  const template = stage.retry?.idempotencyKey;
  const logicalKey = template
    ? interpolate(template, {
        account: instance.account ?? {},
        asset: instance.asset ?? {},
        input: { hash: inputHash },
        instance,
        stage,
      })
    : `${instance.id}:${stage.id}:${inputHash}`;
  return `${release.metadata.workflowSha256}:${action}:${logicalKey}`;
}

function requiredApproval(stage, instance, now) {
  if (!stage.approval?.before) return null;
  const approvals = Array.isArray(instance.approvals) ? instance.approvals : [];
  const accepted = approvals.some((approval) => {
    if (approval.status !== "approved") return false;
    if (approval.stageId && approval.stageId !== stage.id) return false;
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
  return interpolate(expression, { instance });
}

function dependenciesDone(stage, latestRuns) {
  return (stage.needs ?? []).every(
    (dependency) => latestRuns.get(dependency)?.status === "done",
  );
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
