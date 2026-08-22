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
    return this.store.createInstance(instance);
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
      if (!stageLabel) continue;
      if (labels.includes("nightshift:approval")) continue;
      this.store.upsertStageRun({
        instanceId,
        stageId: stageLabel.slice("stage:".length),
        attempt: card.metadata?.automation?.attempt ?? 1,
        cardId: card.id,
        status: card.status,
        summary: card.metadata?.automation?.summary ?? null,
      });
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
    const actions = planNextActions({
      release: savedRelease.manifest,
      instance,
      runs,
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
        this.store.upsertStageRun({
          instanceId,
          stageId: result.action.stageId,
          attempt: 1,
          cardId: card.id,
          status: card.status,
        });
        this.store.appendEvent({
          instanceId,
          type: `workboard.card.${result.status}`,
          payload: { cardId: card.id, stageId: result.action.stageId },
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
        await this.workboard.dispatch(1);
      }
    }
    return { actions, applied, instance: this.store.getInstance(instanceId) };
  }

  async approve({
    actor,
    cardId,
    effect,
    evidence,
    instanceId,
    scope,
    stageId,
  }) {
    const approval = this.store.recordApproval({
      actor,
      cardId,
      effect,
      evidence,
      instanceId,
      scope,
      stageId,
      status: "approved",
    });
    if (cardId) await this.workboard.moveCard(cardId, "done");
    const run = this.store
      .listStageRuns(instanceId)
      .find((entry) => entry.stageId === stageId && entry.cardId === cardId);
    if (run) {
      this.store.upsertStageRun({ ...run, status: "done" });
    }
    return approval;
  }

  async reject({ actor, cardId, evidence, instanceId, stageId }) {
    const approval = this.store.recordApproval({
      actor,
      cardId,
      evidence,
      instanceId,
      stageId,
      status: "rejected",
    });
    if (cardId) await this.workboard.moveCard(cardId, "blocked");
    const run = this.store
      .listStageRuns(instanceId)
      .find((entry) => entry.stageId === stageId && entry.cardId === cardId);
    if (run) this.store.upsertStageRun({ ...run, status: "blocked" });
    return approval;
  }

  async requestChanges({ actor, cardId, evidence, instanceId, stageId }) {
    const approval = this.store.recordApproval({
      actor,
      cardId,
      evidence,
      instanceId,
      stageId,
      status: "changes_requested",
    });
    if (cardId) await this.workboard.moveCard(cardId, "blocked");
    const run = this.store
      .listStageRuns(instanceId)
      .find((entry) => entry.stageId === stageId && entry.cardId === cardId);
    if (run) this.store.upsertStageRun({ ...run, status: "blocked" });
    return approval;
  }
}
