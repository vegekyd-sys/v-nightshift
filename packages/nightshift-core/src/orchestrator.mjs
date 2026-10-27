import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { handoffManifestExample, stageHandoffContract, stageHandoffPath } from "./handoff.mjs";
import { interpolate, stageEnabled, stageSkills } from "./workflow.mjs";
import { resolveReleaseAt } from "./release-schedule.mjs";

const ACTIVE_STATUSES = new Set(["ready", "running"]);
export const WORKBOARD_NOTES_LIMIT = 12000;
// The native Workboard refuses a card title over 180 characters. A card title is
// only for people: the full item title stays on the content item and in the brief.
// On V (2026-10-23) a plan stage appended the trade-show line to every title, 28
// of 30 items ran to 182-207 characters, and every scheduler pass of DL-1022-21
// failed "title must be 180 characters or fewer" before any brief card existed.
// Like CARD_LABEL_MAX, the budget is a knob for when the Gateway's limit changes.
export const CARD_TITLE_MAX = titleBudget(process.env.NIGHTSHIFT_CARD_TITLE_MAX);

function titleBudget(value) {
  if (value === undefined || value === null || value === "") return 180;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 40 && parsed <= 1000 ? parsed : 180;
}

// Shortens text to at most `max` UTF-16 units (what the Workboard counts) without
// splitting a character, ending in "…" when anything was cut.
function fitText(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  if (max <= 0) return "";
  let out = "";
  for (const char of value) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

// "<project>｜<item>｜<stage>" within the budget. The item title gives way first,
// keeping at least a few characters; then the project name; the stage last.
export function cardTitle({ project, item = null, stage }, max = CARD_TITLE_MAX) {
  const separator = "｜";
  const parts = item === null ? [project, stage] : [project, item, stage];
  const join = (values) => values.join(separator);
  if (join(parts).length <= max) return join(parts);
  const room = (others) => max - others.reduce((sum, value) => sum + value.length, 0) - separator.length * (parts.length - 1);
  let [name, title, stageTitle] = item === null ? [project, null, stage] : parts;
  if (title !== null) title = fitText(title, Math.max(12, room([name, stageTitle])));
  const fitted = () => join(title === null ? [name, stageTitle] : [name, title, stageTitle]);
  if (fitted().length > max) name = fitText(name, Math.max(8, room(title === null ? [stageTitle] : [title, stageTitle])));
  if (fitted().length > max) stageTitle = fitText(stageTitle, Math.max(1, room(title === null ? [name] : [name, title])));
  return fitText(fitted(), max);
}
// A card the native board is holding for a timed release is present work, not
// missing work. Leave "scheduled" out and every pass re-plans the same stage.
const PRESENT_STATUSES = new Set([
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
  "skipped",
  "cancelled",
]);

// How many cards of one project may run at once. A project's own limit, set
// while it runs by an operator or an Agent (nightshiftctl projects concurrency),
// wins; otherwise the Workflow's perInstance, which is what every project got
// before the limit could be set. The board-wide brakes still apply on top.
export const PROJECT_CONCURRENCY_MAX = 8;

export function projectConcurrencyLimit(release, control = {}) {
  const own = control?.perInstanceLimit;
  if (Number.isSafeInteger(own) && own >= 1) return Math.min(own, PROJECT_CONCURRENCY_MAX);
  return release?.spec?.concurrency?.perInstance ?? 1;
}

// How many cards a project may run while nothing else is waiting for a start.
// perInstance is a project's fair share of a busy board; on an idle board it
// only leaves capacity unused. On V (2026-10-14..21) a 30-item project that
// ran alone took 3–5 h at 3.4 of its 4 cards while the board had room for 12.
// The scheduler decides when the board is idle; this says how far a project
// may go then. A Workflow that runs one card at a time and a limit an operator
// set for a project are both meant, so neither is raised.
export function projectIdleConcurrencyLimit(release, control = {}, idleLimit = 0) {
  const limit = projectConcurrencyLimit(release, control);
  if (Number.isSafeInteger(control?.perInstanceLimit) && control.perInstanceLimit >= 1) return limit;
  if (limit <= 1 || !Number.isSafeInteger(idleLimit)) return limit;
  return Math.max(limit, Math.min(idleLimit, PROJECT_CONCURRENCY_MAX));
}

export function planNextActions({
  release,
  instance,
  runs = [],
  contentItems = [],
  contentItemRuns = [],
  now = new Date(),
  perInstanceLimit = null,
  skippedContentItems = [],
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
  // The caller passes the project's effective limit; alone, the Workflow's.
  const limit = Number.isSafeInteger(perInstanceLimit) && perInstanceLimit >= 1 ? perInstanceLimit : projectConcurrencyLimit(release);
  if (activeCount >= limit) return [];
  const itemById = new Map(contentItems.map((item) => [item.id, item]));
  const reservedResources = activeResourceLocks({ instance, itemById, latestItemRuns, latestRuns, stageById });

  const actions = [];
  for (const stage of stages) {
    if (actions.length + activeCount >= limit) break;
    if (!stageEnabled(stage, instance.inputs ?? {})) continue;
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
        if (!dependenciesDoneForContentItem(stage, stageById, latestRuns, latestItemRuns, contentItem.id, instance)) continue;

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
        // A stage a person asked to redo (runtime.redoForChanges) gets a new
        // card for the attempt the redo reserved.
        const attempt = existing?.status === "redo" ? existing.attempt : undefined;
        const payload = cardPayload(
          release,
          instance,
          stage,
          stage.actor === "human" ? "review" : "ready",
          contentItem,
          resourceKey,
          contentItems,
          dependencyCardIdsForContentItem(stage, stageById, latestRuns, latestItemRuns, contentItem.id),
          now,
        );
        if (attempt) payload.automation.attempt = attempt;
        actions.push({
          type,
          instanceId: instance.id,
          contentItemId: contentItem.id,
          stageId: stage.id,
          ...(attempt ? { attempt } : {}),
          idempotencyKey: actionKey(release, instance, stage, stage.actor === "human" ? "review" : "run", contentItem),
          card: payload,
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
          idempotencyKey: actionKey(release, instance, stage, "approval", null, existing?.attempt),
        });
      }
      continue;
    }
    if (!dependenciesDoneForProject(stage, stageById, latestRuns, latestItemRuns, contentItems, instance)) continue;

    const missingApproval = requiredApproval(stage, instance, now);
    if (missingApproval) {
      actions.push({
        type: "request_approval",
        instanceId: instance.id,
        stageId: stage.id,
        approval: missingApproval,
        idempotencyKey: actionKey(release, instance, stage, "approval", null, existing?.attempt),
      });
      continue;
    }

    if (stage.actor === "human") {
      actions.push({
        type: "create_review_card",
        instanceId: instance.id,
        stageId: stage.id,
        ...(existing?.status === "redo" ? { attempt: existing.attempt } : {}),
        idempotencyKey: actionKey(release, instance, stage, "review", null, existing?.attempt),
        card: cardPayload(
          release,
          instance,
          stage,
          "review",
          null,
          null,
          contentItems,
          dependencyCardIdsForProject(stage, stageById, latestRuns, latestItemRuns, contentItems),
          now,
          skippedContentItems,
        ),
      });
      continue;
    }

    if (stage.actor === "agent" || stage.actor === "system") {
      const resourceKey = stageResourceLock(stage, instance);
      if (resourceKey && reservedResources.has(resourceKey)) continue;
      const attempt = existing?.status === "redo" ? existing.attempt : undefined;
      actions.push({
        type: "create_workboard_card",
        instanceId: instance.id,
        stageId: stage.id,
        ...(attempt ? { attempt } : {}),
        idempotencyKey: actionKey(release, instance, stage, "run", null, attempt),
        card: cardPayload(
          release,
          attempt ? { ...instance, projectStageRevision: { stageId: stage.id, attempt, note: existing.summary } } : instance,
          stage,
          "ready",
          null,
          resourceKey,
          contentItems,
          dependencyCardIdsForProject(stage, stageById, latestRuns, latestItemRuns, contentItems),
          now,
          skippedContentItems,
        ),
      });
      if (resourceKey) reservedResources.add(resourceKey);
    }
  }

  return actions;
}

// The native board refuses a card with more than 20 parents ("parents supports
// at most 20 entries"). On V (2026-09-29) a 30-item project finished every
// produce card and then could not create its delivery card. Parents only draw
// lineage on the board: Night Shift itself creates a fan-in stage after all of
// its dependencies are done. So the list is capped and the full count kept.
export const WORKBOARD_PARENTS_LIMIT = 20;

function cardPayload(release, instance, stage, status, contentItem = null, resourceKey = null, contentItems = [], parents = [], now = new Date(), skippedContentItems = []) {
  const inputHash = instance.inputHash ?? hashJson(instance.inputs ?? {});
  const agentRole = stage.agentRole ?? release.spec.ownerAgentRole;
  const assignedAgent = stage.actor === "agent" ? instance.agentBindings?.[agentRole] : null;
  if (stage.actor === "agent" && !assignedAgent) {
    throw new Error(`Missing agent binding for role ${agentRole}`);
  }
  // A timed stage is held by the board, not by withholding the card: the card
  // exists, is visible, can be approved and re-timed, and the board refuses to
  // start it early. `waitUntil` is the older spelling of the same field.
  const releaseAt = resolveReleaseAt(stage.releaseAt ?? stage.waitUntil ?? null, {
    instance,
    contentItem,
    now: now instanceof Date ? now.getTime() : now,
  });
  return {
    ...(releaseAt === null ? {} : { scheduledAt: releaseAt }),
    title: cardTitle({ project: instance.name ?? instance.id, item: contentItem ? contentItem.title : null, stage: stage.title }),
    status,
    assignedAgent,
    notes: buildAgentBrief(release, instance, stage, contentItem, contentItems, skippedContentItems),
    labels: [
      `workflow:${release.metadata.id}`,
      `release:${release.metadata.workflowSha256.slice(0, 12)}`,
      `instance:${instance.id}`,
      `stage:${stage.id}`,
      ...(contentItem ? [`content-item:${contentItem.id}`, `route:${contentItem.route ?? "UNROUTED"}`] : []),
    ],
    parents: parents.slice(0, WORKBOARD_PARENTS_LIMIT),
    automation: {
      ...(parents.length > WORKBOARD_PARENTS_LIMIT ? { dependencyCount: parents.length } : {}),
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
      sideEffects: stage.sideEffects ?? [],
      maxRuntime: stage.timeout,
      maxRuntimeSeconds: stageTimeoutSeconds(stage.timeout),
      maxAttempts: stage.retry?.maxAttempts ?? 1,
      resourceKey,
    },
  };
}

function dependencyCardIdsForProject(stage, stageById, projectRuns, itemRuns, contentItems) {
  const ids = [];
  for (const dependency of stage.needs ?? []) {
    const dependencyStage = stageById.get(dependency);
    if (dependencyStage?.scope === "content-item") {
      for (const item of contentItems) {
        const run = itemRuns.get(contentItemRunKey(item.id, dependency));
        if (run?.cardId) ids.push(run.cardId);
      }
      continue;
    }
    const run = projectRuns.get(dependency);
    if (run?.cardId) ids.push(run.cardId);
  }
  return [...new Set(ids)];
}

function dependencyCardIdsForContentItem(stage, stageById, projectRuns, itemRuns, contentItemId) {
  const ids = [];
  for (const dependency of stage.needs ?? []) {
    const dependencyStage = stageById.get(dependency);
    const run = dependencyStage?.scope === "content-item"
      ? itemRuns.get(contentItemRunKey(contentItemId, dependency))
      : projectRuns.get(dependency);
    if (run?.cardId) ids.push(run.cardId);
  }
  return [...new Set(ids)];
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

// Absolute, so a Worker whose cwd is the agent workspace can still run it.
const DUPLICATE_CHECK_SCRIPT = fileURLToPath(new URL("../../../scripts/check-video-duplicates.mjs", import.meta.url));
const NIGHTSHIFTCTL_SCRIPT = fileURLToPath(new URL("../../../scripts/nightshiftctl.mjs", import.meta.url));

export function buildAgentBrief(release, instance, stage, contentItem = null, contentItems = [], skippedContentItems = []) {
  const brief = composeAgentBrief({ release, instance, stage, contentItem, contentItems, skippedContentItems, compact: false });
  if (brief.length <= WORKBOARD_NOTES_LIMIT) return brief;
  // A project stage after per-item stages lists one handoff path per item, and a
  // brief that outgrows the board's note limit would stop the project at card
  // creation. The compact brief names the path pattern and the skipped ids only.
  const compact = composeAgentBrief({ release, instance, stage, contentItem, contentItems, skippedContentItems, compact: true });
  if (compact.length > WORKBOARD_NOTES_LIMIT) {
    throw new Error(`Night Shift card brief exceeds the native Workboard ${WORKBOARD_NOTES_LIMIT} character limit (${compact.length})`);
  }
  return compact;
}

function composeAgentBrief({ release, instance, stage, contentItem, contentItems, skippedContentItems, compact }) {
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
  const upstreamHandoffPaths = handoffEnabled ? handoffContract.previous.flatMap((upstream) => {
    const upstreamStage = release.spec.stages.find((entry) => entry.id === upstream.id);
    if ((stage.scope ?? "project") === "project" && upstreamStage?.scope === "content-item") {
      return contentItems.map((item) => stageHandoffPath({
        instanceDir,
        contentItemId: item.id,
        release,
        stageId: upstream.id,
      }));
    }
    return [stageHandoffPath({
      instanceDir,
      contentItemId: upstreamStage?.scope === "content-item" ? contentItem?.id ?? null : null,
      release,
      stageId: upstream.id,
    })];
  }) : [];
  const exactApprovalRecorded = Boolean(stage.approval?.before) && !requiredApproval(stage, instance, new Date(), contentItem?.id ?? null);
  const approvalBinding = exactApprovalRecorded ? resolveApprovalBinding(stage, instance, contentItem?.id ?? null) : null;
  const lines = [
    `Night Shift workflow: ${release.metadata.name} (${release.metadata.version})`,
    `Instance: ${instance.id}`,
    `Stage: ${stage.id} — ${stage.title}`,
    ...(contentItem ? [`Content item: ${JSON.stringify(summarizeContentItem(contentItem))}`] : []),
    `Objective: ${strategy?.description ?? stage.description ?? "Complete the declared stage."}`,
    ...(!contentItem && instance.projectStageRevision?.stageId === stage.id ? [
      `Project stage revision ${instance.projectStageRevision.attempt - 1}: ${instance.projectStageRevision.note}. Only redo this stage on the existing upstream results; never repeat upstream purchases. This card has a new external-operation key; keep the previous operation and receipt unchanged.`,
    ] : []),
    ...(contentItem?.revisionRequest && (contentItem.revisionRequest.stageIds ?? []).includes(stage.id) ? [
      redoLine(release, stage, contentItem),
    ] : []),
    // A Night Shift card runs as the same agent, with the same Skills, as a
    // chat turn. The stage's Skills are a hint and an install-time dependency
    // (checked by project preflight), not something to load before acting.
    ...(stageSkills(stage, contentItem?.route).length ? [`Skills likely useful here: ${stageSkills(stage, contentItem?.route).join(", ")}`] : []),
    `Input summary: ${JSON.stringify(inlineInputs)}`,
    ...(projectInputsPath ? [`Project inputs: ${projectInputsPath}`] : []),
    ...(stage.id === "plan" && instance.inputs?.nightshift?.contentItemsManifestPath
      ? [`Content backlog contract: write {"contentItems":[{"id":"stable-id","title":"...","route":"AI_GENERATE|SCENE_EDIT|null","status":"planned|routing"}]} to ${instance.inputs.nightshift.contentItemsManifestPath}. The control plane imports this file and fans out Workboard tasks.`]
      : []),
    ...(stage.id === "route" && instance.inputs?.nightshift?.contentItemsManifestPath
      ? [`Route writeback contract: update only this ContentItem in ${instance.inputs.nightshift.contentItemsManifestPath}; preserve every other item and stable id.`]
      : []),
    ...(itemDir ? [`Content item artifact directory: ${itemDir}`] : []),
    ...(handoffEnabled ? [
      ...(upstreamHandoffPaths.length > 0 ? [compact && upstreamHandoffPaths.length > 1
        ? `Previous stage output: ${compactHandoffPaths(upstreamHandoffPaths, instanceDir, contentItems)}`
        : `Previous stage output: ${upstreamHandoffPaths.join(", ")}`] : []),
      `Stage handoff output: after finishing the declared outputs, write ${handoffPath} using exactly this v1 shape: ${JSON.stringify(handoffManifestExample({ instanceId: instance.id, contentItemId: contentItem?.id ?? null, release, stageId: stage.id }))}`,
    ] : []),
    ...(stage.outputs?.includes("deliveryManifest") && itemDir
      ? [
          `Delivery contract: write exactly this v1 shape to ${itemDir}/deliverables.json (paths are relative to ${itemDir}): ${JSON.stringify(deliveryManifestExample(instance.id, contentItem))}`,
          ...(contentItem.route === "SCENE_EDIT" ? [`Temporal duplicate gate: run node ${DUPLICATE_CHECK_SCRIPT} ${itemDir}/produce/final.mp4 --out ${itemDir}/produce/duplicate-check.json. A failed or missing report blocks completion.`] : []),
        ]
      : []),
    ...outputChecklist(stage),
    ...(exactApprovalRecorded ? [
      `Execution authorization: a later, exact Workboard approval is recorded for ${stage.approval.before} with scope ${stage.approval.scope ?? "stage"}${contentItem ? ` on content item ${contentItem.id}` : ""}. It intentionally opens only this approved action after the project's default-deny baseline; do not treat that earlier baseline as a conflict and do not edit the project inputs.`,
      ...(approvalBinding && Object.keys(approvalBinding.values).length > 0
        ? [`Immutable approval bindings: ${JSON.stringify(redactSensitiveInputs(approvalBinding.values))}. Use this exact target; never guess or substitute another account or device.`]
        : []),
    ] : []),
    ...(release.spec?.completion?.mode === "strict-v1"
      ? Object.entries(stage.outputContracts ?? {}).map(([name, contract]) => `Output contract ${name}: ${JSON.stringify(contract)}`)
      : []),
    // A project-wide stage (delivery, packaging) must not wait for or include
    // items a person decided to skip; content-items.json still lists them.
    ...((stage.scope ?? "project") === "project" && skippedContentItems.length ? [
      `Skipped content items (a person decided these are not delivered; content-items.json still lists them): ${skippedContentItems.map((entry) => compact ? entry.id : `${entry.id} 「${entry.title}」${entry.reason ? ` — ${String(entry.reason).slice(0, 160)}` : ""}`).join("; ")}. Do not wait for them, do not package or count them: this delivery has ${contentItems.length} items.`,
    ] : []),
    ...(stage.id === "deliver-download" && instanceDir ? [
      `Download delivery contract: aggregate every validated ContentItem deliverables.json and produce handoff into ${instanceDir}/deliver-download/delivery-package.zip; upload that exact package once under a stable instance-bound OSS object key; upsert one Base delivery row keyed by instance ${instance.id}; write ${instanceDir}/deliver-download/oss-delivery.json with uploaded=true and ${instanceDir}/deliver-download/base-delivery-receipt.json with recorded=true; and reference those concrete artifacts from the stage handoff.`,
      "This branch must not create human review work, request external-publication approval, publish content, call GeeLark, or invoke geelark-cloud-phone.",
    ] : []),
    ...((stage.completeWhen ?? []).length ? [] : ["Completion checks: human decision"]),
    `Safety: ${(stage.sideEffects ?? []).length ? `declared external side effects: ${stage.sideEffects.join(", ")}; ${stage.approval?.before ? `requires ${stage.approval.before} approval` : "no separate human approval gate"}` : "no declared external side effect"}`,
    ...((stage.sideEffects ?? []).length ? [
      `External-operation gate: before the first paid/public/external call, compute a stable SHA-256 of the exact external request and run \`node ${NIGHTSHIFTCTL_SCRIPT} operations reserve <Card id from Worker protocol> --request-hash <sha256>\`. If the response is reused+succeeded, reuse its result and do not call the provider again; if that result does not pass this stage's checks, block with the stop report rather than paying again, asking a person to look at the result. If it is reused+executing with an externalTaskId, resume by reading that external task and never submit a replacement. If it is reused+reserved without an externalTaskId, treat the outcome as ambiguous and block for readback instead of resubmitting. If it is reused+failed, the call under this key already failed: do not submit again under it; block with the stop report, and Night Shift starts a fresh attempt with a new key. After provider submission run \`operations checkpoint ... --status executing --external-task-id <id>\`; after verified success run \`operations checkpoint ... --status succeeded --result-json '<json>'\`. The ledger is the only external side-effect checkpoint.`,
      // V, 2026-10-09: DL-1009-07's paid calls ran for hours without a video
      // while each card's Agent kept polling. Most results come within ten
      // minutes; an hour with nothing is a stop the engine can act on.
      "Waiting on the provider: if it asks to confirm a plan, script or proposal that this brief already settles, confirm it once in the same project instead of waiting. If the provider has no result 60 minutes after submission, stop waiting: checkpoint the operation as executing with its external task id if you have not yet, then block with the stop report — 原因 says how long it ran and where it stopped (for example 「Makaron 提交 60 分钟仍未出片，停在分镜」) — and write 需要人做：无 unless a person must act. Night Shift then resumes reading that task or starts a fresh attempt by itself.",
    ] : []),
    "Workboard completion safety: this attempt owns only this card. When the outputs are written, call workboard_complete exactly once (in an isolated Worker without that tool, `openclaw gateway call workboard.cards.complete` once with the real card id and claim token), or block once for a real blocker. Never probe, test, or enumerate completion RPCs, never use placeholder input such as summary=test, never touch another card, do not search source code or inspect plugin internals, and never print the claim token.",
    // The 需要你 card shows these two lines. Agents never see the operator
    // skill, so before this line they wrote long English reports and the card
    // could not say what a person should do (DL-1008-04 on V, 2026-10-08).
    "Stop report: if you end without completing this stage, begin your final message with two lines in Chinese, written for someone who is not technical: 需要人做：<the one thing only a person can do so this can go on, as one plain instruction of at most 40 Chinese characters that says what to give or fix and where, with no ids, field names, file paths or card names — such as 请给 seedance 视频服务充值, 请在 Scene 里补一段烟雾测试画面, 请更新巴西手机的代理账号, 请看一下这条视频能不能用：<link>; or 无 when no person is needed, such as a crash, a timeout or a provider error a new attempt may fix: Night Shift then tries again by itself> 原因：<one plain sentence on what actually happened, at most 60 Chinese characters; not the name of a Night Shift rule>. Details may follow after a blank line.",
    // V, 2026-10-12..22: 55–90% of the makaron agent's daily memory files were
    // card runs' own logs, and later cards read them back as instructions (visual
    // QC no stage asked for, "the previous run was fake" retractions of real
    // outputs). Cards may read memory for background (Tianyi 2026-10-22) but never
    // write it.
    "Memory: you may read the agent's memory for background, but do not write to it (memory/*.md, MEMORY.md, user-patterns.md). What this card did goes in your final message and the stage handoff, not in memory.",
    "Return a concise result with evidence links or an explicit blocker. Do not invent missing evidence.",
  ];
  return lines.join("\n");
}

// One path per item, written as the pattern they share: "<dir>/content-items/<id>/handoffs/x.json
// for each content item in content-items.json (N)". Paths that do not share it stay listed.
function compactHandoffPaths(paths, instanceDir, contentItems) {
  const ids = contentItems.map((item) => item.id);
  const patterns = new Map();
  const rest = [];
  for (const path of paths) {
    const id = ids.find((value) => path.includes(`/content-items/${value}/`));
    if (!id) {
      rest.push(path);
      continue;
    }
    const pattern = path.replace(`/content-items/${id}/`, "/content-items/<content item id>/");
    patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1);
  }
  return [
    ...[...patterns].map(([pattern, count]) => `${pattern} for each content item in ${instanceDir}/content-items.json (${count})`),
    ...rest,
  ].join(", ");
}

// Why this stage runs again for the item: a person sent its review back with
// changes (要求修改), or a stopped stage went on as a fresh attempt.
function redoLine(release, stage, contentItem) {
  const request = contentItem.revisionRequest;
  const note = `Their note, verbatim: «${String(request.note ?? "(no note)").slice(0, 1500)}».`;
  const from = release.spec?.stages?.find((entry) => entry.id === request.fromStageId);
  if (!from || from.actor === "human") {
    return `Redo requested (revision ${contentItem.revision}): ${request.actor} reviewed the previous result of this item and asked for changes. ${note} Do this stage again so the result meets that note: write new outputs and a new stage handoff over the previous ones; do not hand back the previous result.`;
  }
  const ledger = (stage.sideEffects ?? []).length
    ? " This revision has its own external-operation key, so `operations reserve` returns a new operation; a paid or external call made under it is a new one the person accepted to pay for. Do not reuse the previous attempt's provider result."
    : "";
  return `Redo requested (revision ${contentItem.revision}): ${request.actor} started a fresh attempt after the previous attempt of this item stopped at ${from.id}. ${note} Do this stage again${stage.id === from.id ? "" : " on the redone result"}: write new outputs and a new stage handoff over the previous ones.${ledger}`;
}

// What the completion validator derives by itself, so the agent never has to
// read the validator to learn what a fact name means.
const DERIVED_FACTS = {
  accessible: "the referenced file exists",
  exists: "the referenced file exists",
  newForThisRun: "the file was written during this project run",
  hasAtLeastOneItem: "its items[] (or contentItems[]) is non-empty",
  everyItemHasStableIdAndTitle: "every entry in items[] has a non-empty id and title",
  terminal: "its JSON status is passed, warning, failed, done, complete or completed",
  reachable: "the HTTPS URL answers",
  hostAllowed: "the HTTPS URL's host is allowed by the Workflow",
  valid: "the HTTPS URL is reachable on an allowed host",
};

// One line per declared output: which file to write, how the stage handoff
// points at it, and exactly which facts the Workflow's completeWhen reads.
function outputChecklist(stage) {
  const outputs = stage.outputs ?? [];
  if (outputs.length === 0) return ["Required outputs: none"];
  const checks = new Map(outputs.map((name) => [name, []]));
  for (const rule of stage.completeWhen ?? []) {
    const [, name, ...path] = String(rule).split(".");
    if (checks.has(name) && path.length) checks.get(name).push(path.join("."));
  }
  return [
    "Required outputs — write each as a file (or put the HTTPS URL) and list it by name in the stage handoff outputs[].artifact; completion reads the facts below from that artifact (top-level JSON fields, or `name: true` lines in a text file):",
    ...outputs.map((name) => {
      const facts = checks.get(name);
      if (facts.length === 0) return `- ${name}: no fact is checked beyond the handoff entry`;
      return `- ${name}: ${facts.map((fact) => DERIVED_FACTS[fact] ? `${fact} (automatic: ${DERIVED_FACTS[fact]})` : `${fact} must be true`).join("; ")}`;
    }),
  ];
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
    qc: {
      status: "passed",
      reportPath: "produce/machineQc.json",
      ...(contentItem.route === "SCENE_EDIT" ? {
        duplicateCheck: {
          status: "passed",
          method: "temporal-luma-window-v1",
          threshold: 0.985,
          maxDuplicateRatio: 0.25,
          duplicateRatio: 0.08,
          comparedPairs: 120,
          reportPath: "produce/duplicate-check.json",
        },
      } : {}),
      summary: ["完整解码通过"],
    },
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
    "deliveryMode",
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

export function actionKey(release, instance, stage, action, contentItem = null, projectAttempt = 1) {
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
  // A redone item's new cards must not be matched to its old ones.
  const revision = Number.isSafeInteger(contentItem?.revision) && contentItem.revision > 0 ? `:revision-${contentItem.revision}`
    : !contentItem && Number.isSafeInteger(projectAttempt) && projectAttempt > 1 ? `:project-revision-${projectAttempt - 1}` : "";
  return `${release.metadata.workflowSha256}:${action}:${logicalKey}${revision}`;
}

export function nativeActionKey(logicalKey) {
  return `nightshift:${createHash("sha256").update(logicalKey).digest("hex")}`;
}

export function requiredApproval(stage, instance, now, contentItemId = null) {
  if (!stage.approval?.before) return null;
  // The project inputs already carry the operator's decision. When they authorize
  // paid production for this project, an approval card per item adds no decision
  // — it only pushed workflows into leaving the side effect undeclared to avoid
  // the cards, which then hid the spending from the ledger. Publication stays
  // per-target: it binds an account and a device.
  if (stage.approval.before === "paid-production" && instance.inputs?.authorizationScope?.paidProduction === true) return null;
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

function dependenciesDoneForProject(stage, stageById, projectRuns, itemRuns, contentItems, instance) {
  return (stage.needs ?? []).every((dependency) => {
    const dependencyStage = stageById.get(dependency);
    if (!stageEnabled(dependencyStage, instance.inputs ?? {})) return true;
    if (dependencyStage?.scope === "content-item") {
      return contentItems.length > 0 && contentItems.every((item) =>
        itemRuns.get(contentItemRunKey(item.id, dependency))?.status === "done");
    }
    return projectRuns.get(dependency)?.status === "done";
  });
}

function dependenciesDoneForContentItem(stage, stageById, projectRuns, itemRuns, contentItemId, instance) {
  return (stage.needs ?? []).every((dependency) => {
    const dependencyStage = stageById.get(dependency);
    if (!stageEnabled(dependencyStage, instance.inputs ?? {})) return true;
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
