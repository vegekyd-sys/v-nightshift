import {
  compileWorkflow,
  parseWorkflow,
  validateWorkflow,
  WorkflowValidationError,
} from "./workflow.mjs";
import { planNextActions } from "./orchestrator.mjs";

export class NightShiftRuntime {
  constructor({ board = "nightshift", store, workboard }) {
    if (!store) throw new Error("NightShift store is required");
    if (!workboard) throw new Error("Workboard adapter is required");
    this.board = board;
    this.store = store;
    this.workboard = workboard;
  }

  validate(sourceYaml) {
    const workflow = parseWorkflow(sourceYaml);
    const issues = validateWorkflow(workflow);
    return { issues, ok: issues.length === 0, workflow };
  }

  saveDraft(sourceYaml) {
    const result = this.validate(sourceYaml);
    const workflowId = result.workflow?.metadata?.id;
    if (!workflowId) throw new WorkflowValidationError(result.issues);
    const draft = this.store.saveDraft(workflowId, sourceYaml);
    return { ...draft, issues: result.issues, valid: result.ok };
  }

  publish(sourceYaml) {
    const workflow = parseWorkflow(sourceYaml);
    const release = compileWorkflow(workflow);
    return this.store.saveRelease(release, sourceYaml);
  }

  startInstance(instance) {
    if (!this.store.getRelease(instance.workflowSha256)) {
      throw new Error(`Unknown workflow release ${instance.workflowSha256}`);
    }
    const created = this.store.createInstance(instance);
    if (Array.isArray(instance.contentItems) && instance.contentItems.length > 0) {
      this.setContentItems(created.id, instance.contentItems);
    }
    return this.store.getInstance(created.id);
  }

  setContentItems(instanceId, items) {
    const instance = this.store.getInstance(instanceId);
    if (!instance) throw new Error(`Unknown instance ${instanceId}`);
    const release = this.store.getRelease(instance.workflowSha256);
    const maxItems = release?.manifest?.spec?.contentItems?.maxItems ?? 50;
    const routes = release?.manifest?.spec?.contentItems?.routes ?? [];
    return this.store.replaceContentItems(instanceId, items, new Date(), maxItems, routes);
  }

  updateInstanceInputs(instanceId, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Instance input patch must be an object");
    }
    return this.store.updateInstanceInputs(instanceId, patch);
  }

  async reconcile(instanceId, cards = null) {
    const currentCards = cards ?? await this.workboard.listCards();
    for (const card of currentCards) {
      const labels = card.labels ?? [];
      if (!labels.includes(`instance:${instanceId}`)) continue;
      const stageLabel = labels.find((label) => label.startsWith("stage:"));
      const contentItemLabel = labels.find((label) => label.startsWith("content-item:"));
      if (!stageLabel) continue;
      if (labels.includes("nightshift:approval")) continue;
      const run = {
        instanceId,
        stageId: stageLabel.slice("stage:".length),
        attempt: card.metadata?.automation?.attempt ?? 1,
        cardId: card.id,
        status: card.status,
        summary: card.metadata?.automation?.summary ?? null,
      };
      if (contentItemLabel) {
        this.store.upsertContentItemRun({ ...run, contentItemId: contentItemLabel.slice("content-item:".length) });
      } else {
        this.store.upsertStageRun(run);
      }
    }
    return this.store.listStageRuns(instanceId);
  }

  async tick(instanceId, { cards = null, dispatch = false, dryRun = false } = {}) {
    await this.reconcile(instanceId, cards);
    const instance = this.store.getInstance(instanceId);
    if (!instance) throw new Error(`Unknown instance ${instanceId}`);
    const savedRelease = this.store.getRelease(instance.workflowSha256);
    if (!savedRelease) throw new Error(`Missing release ${instance.workflowSha256}`);
    const runs = this.store.listStageRuns(instanceId);
    const contentItems = this.store.listContentItems(instanceId);
    const contentItemRuns = this.store.listContentItemRuns(instanceId);
    const actions = planNextActions({
      release: savedRelease.manifest,
      instance,
      runs,
      contentItems,
      contentItemRuns,
    });
    const applied = await this.workboard.applyPlan(actions, { dryRun });
    if (!dryRun) {
      for (const result of applied) {
        const card = result.card;
        if (!card) continue;
        if (result.action.type === "request_approval") {
          this.store.appendEvent({
            instanceId,
            type: "approval.requested",
            payload: {
              cardId: card.id,
              stageId: result.action.stageId,
              approval: result.action.approval,
            },
          });
          continue;
        }
        const run = {
          instanceId,
          stageId: result.action.stageId,
          attempt: 1,
          cardId: card.id,
          status: card.status,
        };
        if (result.action.contentItemId) {
          this.store.upsertContentItemRun({ ...run, contentItemId: result.action.contentItemId });
        } else {
          this.store.upsertStageRun(run);
        }
        this.store.appendEvent({
          instanceId,
          type: `workboard.card.${result.status}`,
          payload: { cardId: card.id, stageId: result.action.stageId, contentItemId: result.action.contentItemId ?? null },
        });
      }
      if (
        dispatch &&
        applied.some(
          (result) =>
            result.card?.status === "ready" &&
            result.action.type === "create_workboard_card",
        )
      ) {
        const maxStarts = applied.filter(
          (result) =>
            result.card?.status === "ready" &&
            result.action.type === "create_workboard_card",
        ).length;
        await this.workboard.dispatch(maxStarts);
      }
      if (actions.length === 0 && workflowComplete(savedRelease.manifest, runs, contentItems, contentItemRuns)) {
        this.store.updateInstanceStatus(instanceId, "done");
        this.store.appendEvent({ instanceId, type: "instance.completed", payload: { contentItemCount: contentItems.length } });
      }
    }
    return { actions, applied, instance: this.store.getInstance(instanceId) };
  }

  async approve({
    actor,
    cardId,
    contentItemId,
    effect,
    evidence,
    instanceId,
    scope,
    stageId,
  }) {
    const approval = this.store.recordApproval({
      actor,
      cardId,
      contentItemId,
      effect,
      evidence,
      instanceId,
      scope,
      stageId,
      status: "approved",
    });
    if (cardId) await this.workboard.moveCard(cardId, "done");
    const run = contentItemId
      ? this.store.listContentItemRuns(instanceId).find((entry) => entry.contentItemId === contentItemId && entry.stageId === stageId && entry.cardId === cardId)
      : this.store.listStageRuns(instanceId).find((entry) => entry.stageId === stageId && entry.cardId === cardId);
    if (run) contentItemId
      ? this.store.upsertContentItemRun({ ...run, status: "done" })
      : this.store.upsertStageRun({ ...run, status: "done" });
    return approval;
  }

  async reject({ actor, cardId, contentItemId, evidence, instanceId, stageId }) {
    const approval = this.store.recordApproval({
      actor,
      cardId,
      contentItemId,
      evidence,
      instanceId,
      stageId,
      status: "rejected",
    });
    if (cardId) await this.workboard.moveCard(cardId, "blocked");
    const run = contentItemId
      ? this.store.listContentItemRuns(instanceId).find((entry) => entry.contentItemId === contentItemId && entry.stageId === stageId && entry.cardId === cardId)
      : this.store.listStageRuns(instanceId).find((entry) => entry.stageId === stageId && entry.cardId === cardId);
    if (run) contentItemId
      ? this.store.upsertContentItemRun({ ...run, status: "blocked" })
      : this.store.upsertStageRun({ ...run, status: "blocked" });
    return approval;
  }

  async requestChanges({ actor, cardId, contentItemId, evidence, instanceId, stageId }) {
    const approval = this.store.recordApproval({
      actor,
      cardId,
      contentItemId,
      evidence,
      instanceId,
      stageId,
      status: "changes_requested",
    });
    if (cardId) await this.workboard.moveCard(cardId, "blocked");
    const run = contentItemId
      ? this.store.listContentItemRuns(instanceId).find((entry) => entry.contentItemId === contentItemId && entry.stageId === stageId && entry.cardId === cardId)
      : this.store.listStageRuns(instanceId).find((entry) => entry.stageId === stageId && entry.cardId === cardId);
    if (run) contentItemId
      ? this.store.upsertContentItemRun({ ...run, status: "blocked" })
      : this.store.upsertStageRun({ ...run, status: "blocked" });
    return approval;
  }
}

function workflowComplete(release, projectRuns, contentItems, contentItemRuns) {
  const projectStages = release.spec.stages.filter((stage) => (stage.scope ?? "project") === "project");
  const itemStages = release.spec.stages.filter((stage) => stage.scope === "content-item");
  const latestProject = latestBy(projectRuns, (run) => run.stageId);
  if (!projectStages.every((stage) => latestProject.get(stage.id)?.status === "done")) return false;
  if (itemStages.length === 0) return true;
  if (contentItems.length === 0) return false;
  const latestItems = latestBy(contentItemRuns, (run) => `${run.contentItemId}\u0000${run.stageId}`);
  return contentItems.every((item) => itemStages.every((stage) => latestItems.get(`${item.id}\u0000${stage.id}`)?.status === "done"));
}

function latestBy(runs, keyFor) {
  const latest = new Map();
  for (const run of runs) {
    const key = keyFor(run);
    const previous = latest.get(key);
    if (!previous || (run.attempt ?? 0) > (previous.attempt ?? 0)) latest.set(key, run);
  }
  return latest;
}
