import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { handoffManifestExample, stageHandoffContract, stageHandoffPath } from "./handoff.mjs";
import { interpolate, stageEnabled, stageSkills } from "./workflow.mjs";
import { resolveReleaseAt } from "./release-schedule.mjs";

const ACTIVE_STATUSES = new Set(["ready", "running"]);
export const WORKBOARD_NOTES_LIMIT = 12000;
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
          idempotencyKey: actionKey(release, instance, stage, "approval"),
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
      actions.push({
        type: "create_workboard_card",
        instanceId: instance.id,
        stageId: stage.id,
        idempotencyKey: actionKey(release, instance, stage, "run"),
        card: cardPayload(
          release,
          instance,
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
    title: contentItem
      ? `${instance.name ?? instance.id}｜${contentItem.title}｜${stage.title}`
      : `${instance.name ?? instance.id}｜${stage.title}`,
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
    ...(contentItem?.revisionRequest && (contentItem.revisionRequest.stageIds ?? []).includes(stage.id) ? [
      `Redo requested (revision ${contentItem.revision}): ${contentItem.revisionRequest.actor} reviewed the previous result of this item and asked for changes. Their note, verbatim: «${String(contentItem.revisionRequest.note ?? "(no note)").slice(0, 1500)}». Do this stage again so the result meets that note: write new outputs and a new stage handoff over the previous ones; do not hand back the previous result.`,
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
      ...(upstreamHandoffPaths.length > 0 ? [`Previous stage output: ${upstreamHandoffPaths.join(", ")}`] : []),
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
      `Skipped content items (a person decided these are not delivered; content-items.json still lists them): ${skippedContentItems.map((entry) => `${entry.id} 「${entry.title}」${entry.reason ? ` — ${String(entry.reason).slice(0, 160)}` : ""}`).join("; ")}. Do not wait for them, do not package or count them: this delivery has ${contentItems.length} items.`,
    ] : []),
    ...(stage.id === "deliver-page" && instanceDir ? [
      `Delivery page contract: once every ContentItem that is not skipped has its finished video, run \`node ${NIGHTSHIFTCTL_SCRIPT} deliveries publish <Card id from Worker protocol>\`. Night Shift builds the page from each item's produce finishedAsset.json (the provider's CDN URL, checked against the finished file's size) and answers {"published":true,"url":…}. If it answers {"ok":false,"missing":[…]}, upload only the listed finished videos with the fixed OSS uploader and run it again with \`--source <contentItemId>=<https URL>\` for each. Never build a zip and never download the videos to V. Write ${instanceDir}/deliver-page/delivery-page.json as {"published":true,"url":"<the page URL>"}, write the Base delivery row with 下载链接 = the page URL, and reference both from the stage handoff. Publishing again keeps the same URL.`,
    ] : []),
    ...(stage.id === "deliver-download" && instanceDir ? [
      `Download delivery contract: aggregate every validated ContentItem deliverables.json and produce handoff into ${instanceDir}/deliver-download/delivery-package.zip; upload that exact package once under a stable instance-bound OSS object key; upsert one Base delivery row keyed by instance ${instance.id}; write ${instanceDir}/deliver-download/oss-delivery.json with uploaded=true and ${instanceDir}/deliver-download/base-delivery-receipt.json with recorded=true; and reference those concrete artifacts from the stage handoff.`,
      "This branch must not create human review work, request external-publication approval, publish content, call GeeLark, or invoke geelark-cloud-phone.",
    ] : []),
    ...((stage.completeWhen ?? []).length ? [] : ["Completion checks: human decision"]),
    `Safety: ${(stage.sideEffects ?? []).length ? `declared external side effects: ${stage.sideEffects.join(", ")}; ${stage.approval?.before ? `requires ${stage.approval.before} approval` : "no separate human approval gate"}` : "no declared external side effect"}`,
    ...((stage.sideEffects ?? []).length ? [
      `External-operation gate: before the first paid/public/external call, compute a stable SHA-256 of the exact external request and run \`node ${NIGHTSHIFTCTL_SCRIPT} operations reserve <Card id from Worker protocol> --request-hash <sha256>\`. If the response is reused+succeeded, reuse its result and do not call the provider again. If it is reused+executing with an externalTaskId, resume by reading that external task and never submit a replacement. If it is reused+reserved without an externalTaskId, treat the outcome as ambiguous and block for readback instead of resubmitting. After provider submission run \`operations checkpoint ... --status executing --external-task-id <id>\`; after verified success run \`operations checkpoint ... --status succeeded --result-json '<json>'\`. The ledger is the only external side-effect checkpoint.`,
    ] : []),
    "Workboard completion safety: this attempt owns only this card. When the outputs are written, call workboard_complete exactly once (in an isolated Worker without that tool, `openclaw gateway call workboard.cards.complete` once with the real card id and claim token), or block once for a real blocker. Never probe, test, or enumerate completion RPCs, never use placeholder input such as summary=test, never touch another card, do not search source code or inspect plugin internals, and never print the claim token.",
    "Return a concise result with evidence links or an explicit blocker. Do not invent missing evidence.",
  ];
  const brief = lines.join("\n");
  if (brief.length > WORKBOARD_NOTES_LIMIT) {
    throw new Error(`Night Shift card brief exceeds the native Workboard ${WORKBOARD_NOTES_LIMIT} character limit (${brief.length})`);
  }
  return brief;
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

export function actionKey(release, instance, stage, action, contentItem = null) {
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
  const revision = Number.isSafeInteger(contentItem?.revision) && contentItem.revision > 0 ? `:revision-${contentItem.revision}` : "";
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
