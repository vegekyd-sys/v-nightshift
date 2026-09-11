import {
  compileWorkflow,
  parseWorkflow,
  stageEnabled,
  validateWorkflow,
  WorkflowValidationError,
} from "./workflow.mjs";
import { actionKey, buildAgentBrief, nativeActionKey, planNextActions, requiredApproval, resolveApprovalBinding, stageTimeoutSeconds } from "./orchestrator.mjs";

export class NightShiftRuntime {
  constructor({
    board = "nightshift",
    completionValidator = null,
    dispatchMaxStarts = 8,
    maxWorkboardActive = 36,
    store,
    workboard,
  }) {
    if (!store) throw new Error("NightShift store is required");
    if (!workboard) throw new Error("Workboard adapter is required");
    this.board = board;
    this.completionValidator = completionValidator;
    this.dispatchMaxStarts = positiveDispatchLimit(dispatchMaxStarts, "dispatchMaxStarts");
    this.maxWorkboardActive = positiveDispatchLimit(maxWorkboardActive, "maxWorkboardActive");
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
    const instance = this.store.getInstance(instanceId);
    if (!instance) throw new Error(`Unknown instance ${instanceId}`);
    const release = this.store.getRelease(instance.workflowSha256)?.manifest;
    for (const card of currentCards) {
      const labels = card.labels ?? [];
      if (!labels.includes(`instance:${instanceId}`)) continue;
      const stageLabel = labels.find((label) => label.startsWith("stage:"));
      const contentItemLabel = labels.find((label) => label.startsWith("content-item:"));
      if (!stageLabel) continue;
      if (labels.includes("nightshift:approval")) continue;
      let status = card.status;
      let summary = card.metadata?.automation?.summary ?? null;
      const stageId = stageLabel.slice("stage:".length);
      const contentItemId = contentItemLabel?.slice("content-item:".length) ?? null;
      const stage = release?.spec?.stages?.find((entry) => entry.id === stageId);
      if (!stage || !stageEnabled(stage, instance.inputs ?? {})) continue;
      let completionAlreadyValidated = false;
      if (status === "blocked" && stage.actor === "agent" && card.sessionKey && !this.store.getHumanAttempt?.(card.id)) {
        const recovered = await this.recoverWrittenArtifacts({ card, cards: currentCards, contentItemId, instance, release, stageId });
        if (recovered) {
          status = recovered.status;
          summary = recovered.summary;
          completionAlreadyValidated = true;
        }
      }
      if (status === "running") {
        const recovered = await this.recoverTerminalCard({ card, contentItemId, instance, release, stageId });
        if (recovered) {
          status = recovered.status;
          summary = recovered.summary;
          completionAlreadyValidated = recovered.status === "done";
        }
      }
      if (status === "done" && this.completionValidator && !completionAlreadyValidated) {
        try {
          const validation = await this.completionValidator({ card, contentItemId, instance, release, stageId });
          this.store.appendEvent({
            eventId: `completion-validation:${card.id}:${card.metadata?.automation?.attempt ?? 1}`,
            instanceId,
            type: "stage.completion.validated",
            payload: { cardId: card.id, contentItemId, stageId, evidence: validation ?? null },
          });
          await this.restoreDownstreamCards({
            cards: currentCards,
            contentItemId,
            recoveredStageId: stageId,
            instanceId,
            release,
          });
        } catch (error) {
          status = "blocked";
          summary = `Completion validation failed: ${error.message}`;
          await this.workboard.moveCard(card.id, "blocked");
          this.store.appendEvent({
            instanceId,
            type: "stage.completion.rejected",
            payload: { cardId: card.id, contentItemId, error: error.message, stageId },
          });
          await this.blockDownstreamCards({
            cards: currentCards,
            contentItemId,
            failedStageId: stageId,
            instanceId,
            release,
          });
        }
      }
      const run = {
        instanceId,
        stageId,
        attempt: card.metadata?.automation?.attempt ?? 1,
        cardId: card.id,
        status,
        summary,
      };
      if (contentItemLabel) {
        this.store.upsertContentItemRun({ ...run, contentItemId: contentItemLabel.slice("content-item:".length) });
      } else {
        this.store.upsertStageRun(run);
      }
    }
    return this.store.listStageRuns(instanceId);
  }

  async recoverTerminalCard({ card, contentItemId, instance, release, stageId }) {
    if (!card.sessionKey || card.execution?.status !== "running") return null;
    if (typeof this.workboard.getSession !== "function") return null;
    if (typeof this.workboard.completeCard !== "function" || typeof this.workboard.blockCard !== "function") return null;
    let session;
    try {
      session = await this.workboard.getSession(card.sessionKey, { limit: 12 });
    } catch {
      return null;
    }
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const latest = messages.at(-1);
    const startedAt = Number(card.execution?.startedAt ?? card.metadata?.attempts?.at(-1)?.startedAt ?? 0);
    const terminalAt = Number(latest?.timestamp ?? latest?.__openclaw?.recordTimestampMs ?? 0);
    if (latest?.role !== "assistant" || !["stop", "error", "aborted"].includes(latest.stopReason) || terminalAt < startedAt) return null;
    const terminalText = messageText(latest);
    try {
      if (this.completionValidator) {
        await this.completionValidator({ card, contentItemId, instance, release, stageId });
      }
    } catch (error) {
      const reason = boundedReason(`Terminal Agent Session did not satisfy the Workflow output contract: ${error.message}`);
      const blocked = await this.workboard.blockCard(card.id, { reason });
      Object.assign(card, blocked);
      this.store.appendEvent({
        instanceId: instance.id,
        type: "stage.terminal.blocked",
        payload: { cardId: card.id, contentItemId, error: error.message, stageId, terminalAt },
      });
      return { status: "blocked", summary: reason };
    }
    const summary = boundedSummary(terminalText || `${stageId} completed with validated outputs`);
    const attempt = card.runId ?? card.execution?.runId ?? card.metadata?.automation?.attempt ?? 1;
    try {
      const completed = await this.workboard.completeCard(card.id, {
        summary,
        proof: {
          status: "passed",
          label: "Night Shift terminal reconciliation",
          note: "Agent Session is terminal and the pinned Workflow output contract passed validation.",
        },
      });
      Object.assign(card, completed);
      this.store.appendEvent({
        eventId: `terminal-recovery:${card.id}:${attempt}`,
        instanceId: instance.id,
        type: "stage.terminal.recovered",
        payload: { cardId: card.id, contentItemId, stageId, terminalAt },
      });
      return { status: "done", summary };
    } catch (error) {
      this.store.appendEvent({
        eventId: `terminal-recovery-deferred:${card.id}:${attempt}`,
        instanceId: instance.id,
        type: "stage.terminal.recovery-deferred",
        payload: { cardId: card.id, contentItemId, error: error.message, stageId, terminalAt },
      });
      return null;
    }
  }

  async recoverWrittenArtifacts({ card, cards, contentItemId, instance, release, stageId }) {
    if (!this.completionValidator || typeof this.workboard.completeCard !== "function") return null;
    try {
      await this.completionValidator({ card, contentItemId, instance, release, stageId });
    } catch (error) {
      return { status: "blocked", summary: `Completion validation failed: ${error.message}` };
    }
    const attempt = card.runId ?? card.execution?.runId ?? card.metadata?.automation?.attempt ?? 1;
    const summary = boundedSummary(card.metadata?.automation?.summary || `${stageId} recovered from validated persisted artifacts`);
    try {
      const completed = await this.workboard.completeCard(card.id, {
        summary,
        proof: {
          status: "passed",
          label: "Night Shift artifact reconciliation",
          note: "Persisted artifacts satisfy the pinned Workflow output contract after a worker state-update failure.",
        },
      });
      Object.assign(card, completed);
      this.store.appendEvent({
        eventId: `artifact-recovery:${card.id}:${attempt}`,
        instanceId: instance.id,
        type: "stage.artifacts.recovered",
        payload: { cardId: card.id, contentItemId, stageId },
      });
      await this.restoreDownstreamCards({
        cards,
        contentItemId,
        recoveredStageId: stageId,
        instanceId: instance.id,
        release,
      });
      return { status: "done", summary };
    } catch (error) {
      this.store.appendEvent({
        eventId: `artifact-recovery-deferred:${card.id}:${attempt}`,
        instanceId: instance.id,
        type: "stage.artifacts.recovery-deferred",
        payload: { cardId: card.id, contentItemId, error: error.message, stageId },
      });
      return null;
    }
  }

  async blockDownstreamCards({ cards, contentItemId, failedStageId, instanceId, release }) {
    const downstream = downstreamStageIds(release, failedStageId);
    for (const card of cards) {
      const labels = card.labels ?? [];
      if (!labels.includes(`instance:${instanceId}`)) continue;
      if (contentItemId && !labels.includes(`content-item:${contentItemId}`)) continue;
      if (labels.includes("nightshift:approval")) continue;
      const stageId = labels.find((label) => label.startsWith("stage:"))?.slice("stage:".length);
      if (!stageId || !downstream.has(stageId) || ["blocked", "cancelled"].includes(card.status)) continue;
      const stage = release.spec.stages.find((entry) => entry.id === stageId);
      if (!stageEnabled(stage, this.store.getInstance(instanceId)?.inputs ?? {})) continue;
      await this.workboard.moveCard(card.id, "blocked");
      const blockedSummary = `Blocked because upstream stage ${failedStageId} failed completion validation`;
      card.status = "blocked";
      card.metadata = {
        ...(card.metadata ?? {}),
        automation: { ...(card.metadata?.automation ?? {}), summary: blockedSummary },
      };
      if (contentItemId) {
        this.store.upsertContentItemRun({
          instanceId,
          contentItemId,
          stageId,
          attempt: card.metadata?.automation?.attempt ?? 1,
          cardId: card.id,
          status: "blocked",
          summary: blockedSummary,
        });
      }
      this.store.appendEvent({
        instanceId,
        type: "stage.downstream.blocked",
        payload: { cardId: card.id, contentItemId, failedStageId, stageId },
      });
    }
  }

  async restoreDownstreamCards({ cards, contentItemId, recoveredStageId, instanceId, release }) {
    const immediate = new Set((release?.spec?.stages ?? []).filter((stage) => (stage.needs ?? []).includes(recoveredStageId)).map((stage) => stage.id));
    const runs = contentItemId ? this.store.listContentItemRuns(instanceId) : this.store.listStageRuns(instanceId);
    for (const card of cards) {
      const labels = card.labels ?? [];
      if (!labels.includes(`instance:${instanceId}`)) continue;
      if (contentItemId && !labels.includes(`content-item:${contentItemId}`)) continue;
      const stageId = labels.find((label) => label.startsWith("stage:"))?.slice("stage:".length);
      if (!stageId || !immediate.has(stageId) || card.status !== "blocked") continue;
      const stage = release.spec.stages.find((entry) => entry.id === stageId);
      if (!stageEnabled(stage, this.store.getInstance(instanceId)?.inputs ?? {})) continue;
      const run = runs.find((entry) => entry.cardId === card.id && entry.stageId === stageId);
      if (!run?.summary?.includes(`upstream stage ${recoveredStageId} failed completion validation`)) continue;
      const status = stage?.actor === "human" ? "review" : "ready";
      await this.workboard.moveCard(card.id, status);
      const reopenedSummary = `Reopened after ${recoveredStageId} passed completion validation`;
      card.status = status;
      card.metadata = {
        ...(card.metadata ?? {}),
        automation: { ...(card.metadata?.automation ?? {}), summary: reopenedSummary },
      };
      const updated = { ...run, status, summary: reopenedSummary };
      if (contentItemId) this.store.upsertContentItemRun(updated);
      else this.store.upsertStageRun(updated);
      this.store.appendEvent({
        instanceId,
        type: "stage.downstream.reopened",
        payload: { cardId: card.id, contentItemId, recoveredStageId, stageId },
      });
    }
  }

  async retry({ actor, cardId, contentItemId, evidence, instanceId, stageId }) {
    const instance = this.store.getInstance(instanceId);
    if (!instance) throw new Error(`Unknown instance ${instanceId}`);
    const release = this.store.getRelease(instance.workflowSha256)?.manifest;
    const stage = release?.spec?.stages?.find((entry) => entry.id === stageId);
    if (!stage || !["agent", "system"].includes(stage.actor)) throw new Error("Only blocked executable stages can be retried");
    const missingApproval = requiredApproval(stage, instance, new Date(), contentItemId ?? null);
    if (missingApproval) throw new Error("Execution confirmation is required before this stage can be retried");
    const cards = await this.workboard.listCards();
    const card = cards.find((entry) => entry.id === cardId);
    if (!card || card.status !== "blocked") throw new Error("Retry requires a blocked Workboard card");
    const contentItem = contentItemId
      ? this.store.listContentItems(instanceId).find((entry) => entry.id === contentItemId)
      : null;
    if (contentItemId && !contentItem) throw new Error(`Unknown content item ${contentItemId}`);
    await this.workboard.updateCard(cardId, {
      idempotencyKey: nativeActionKey(actionKey(release, instance, stage, "run", contentItem)),
      notes: buildAgentBrief(release, instance, stage, contentItem, this.store.listContentItems(instanceId)),
      maxRetries: stage.retry?.maxAttempts ?? 1,
      maxRuntimeSeconds: stageTimeoutSeconds(stage.timeout),
    });
    await this.workboard.moveCard(cardId, "ready");
    const runs = contentItemId ? this.store.listContentItemRuns(instanceId) : this.store.listStageRuns(instanceId);
    const run = runs.find((entry) => entry.cardId === cardId && entry.stageId === stageId);
    const updated = {
      ...(run ?? { instanceId, contentItemId, stageId, attempt: 1, cardId }),
      status: "ready",
      summary: `Retry requested by ${actor}: ${evidence ?? "no evidence"}`,
    };
    if (contentItemId) this.store.upsertContentItemRun(updated);
    else this.store.upsertStageRun(updated);
    this.store.appendEvent({
      instanceId,
      type: "stage.retry.requested",
      payload: { actor, cardId, contentItemId, evidence, stageId },
    });
    return { cardId, contentItemId, stageId, status: "ready" };
  }

  async tick(instanceId, {
    cards = null,
    dispatch = false,
    dispatchMaxStarts = this.dispatchMaxStarts,
    dryRun = false,
  } = {}) {
    const currentCards = cards ?? await this.workboard.listCards();
    await this.reconcile(instanceId, currentCards);
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
    let dispatchResult = null;
    const applied = await this.workboard.applyPlan(actions, { cards: currentCards, dryRun });
    if (!dryRun) {
      for (const result of applied) {
        const card = result.card;
        if (!card) continue;
        if (result.action.type === "request_approval") {
          if (card.status === "done") {
            await this.workboard.moveCard(card.id, "review");
            card.status = "review";
            this.store.appendEvent({
              instanceId,
              type: "approval.reopened",
              payload: {
                cardId: card.id,
                contentItemId: result.action.contentItemId ?? null,
                stageId: result.action.stageId,
                approval: result.action.approval,
              },
            });
          }
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
      if (dispatch && (this.store.getInstanceControl?.(instanceId)?.automaticDispatch ?? true)) {
        const instanceCards = new Map(currentCards
          .filter((card) => (card.labels ?? []).includes(`instance:${instanceId}`))
          .map((card) => [card.id, card]));
        for (const result of applied) {
          if (result.action.type === "create_workboard_card" && result.card) {
            instanceCards.set(result.card.id, result.card);
          }
        }
        const now = Date.now();
        const active = [...instanceCards.values()].filter(cardConsumesDispatchSlot);
        const activeAcrossBoard = currentCards.filter(cardConsumesDispatchSlot).length;
        const cardIds = [...instanceCards.values()].filter((card) =>
          card.status === "ready" && !active.includes(card) && !cardHasActiveClaim(card, now) && !(card.labels ?? []).includes("nightshift:approval"))
          .map((card) => card.id);
        const maxStarts = Math.min(
          this.dispatchMaxStarts,
          normalizeDispatchBudget(dispatchMaxStarts),
          Math.max(0, this.maxWorkboardActive - activeAcrossBoard),
          Math.max(0, (savedRelease.manifest.spec.concurrency?.perInstance ?? 1) - active.length),
          cardIds.length,
        );
        if (maxStarts > 0) {
          const result = await this.workboard.dispatch(maxStarts, { cardIds });
          dispatchResult = result;
          if (result?.startFailures?.length) {
            throw new Error(`Agent dispatch failed: ${result.startFailures.map((failure) => `${failure.cardId}: ${failure.error}`).join("; ")}`);
          }
        }
      }
      if (actions.length === 0 && workflowComplete(savedRelease.manifest, instance, runs, contentItems, contentItemRuns)) {
        this.store.updateInstanceStatus(instanceId, "done");
        this.store.appendEvent({ instanceId, type: "instance.completed", payload: { contentItemCount: contentItems.length } });
      }
    }
    return { actions, applied, dispatch: dispatchResult, instance: this.store.getInstance(instanceId) };
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
    const instance = this.store.getInstance(instanceId);
    const release = instance ? this.store.getRelease(instance.workflowSha256)?.manifest : null;
    const stage = release?.spec?.stages?.find((entry) => entry.id === stageId);
    const binding = resolveApprovalBinding(stage ?? {}, instance ?? {}, contentItemId ?? null);
    if (binding.missingFields.length > 0) {
      throw new Error(`Approval binding is incomplete: ${binding.missingFields.join(", ")}`);
    }
    const approval = this.store.recordApproval({
      actor,
      bindingHash: binding.bindingHash,
      bindings: binding.values,
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
    const requiredScope = stage?.approval?.scope ?? "stage";
    if (stage?.approval?.before === effect && requiredScope === scope) {
      const cards = await this.workboard.listCards();
      const blockedExecutionCard = cards.find((card) => {
        const labels = card.labels ?? [];
        if (card.status !== "blocked" || labels.includes("nightshift:approval")) return false;
        if (!labels.includes(`instance:${instanceId}`) || !labels.includes(`stage:${stageId}`)) return false;
        const cardContentItemId = labels.find((label) => label.startsWith("content-item:"))?.slice("content-item:".length) ?? null;
        return cardContentItemId === (contentItemId ?? null);
      });
      if (blockedExecutionCard) {
        await this.retry({
          actor,
          cardId: blockedExecutionCard.id,
          contentItemId,
          evidence: `Execution confirmed by ${actor}: ${evidence ?? "no evidence"}`,
          instanceId,
          stageId,
        });
      }
    }
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

export function cardConsumesDispatchSlot(card) {
  return card?.status === "running" || card?.execution?.status === "running";
}

function cardHasActiveClaim(card, now) {
  const expiresAt = Number(card?.metadata?.claim?.expiresAt ?? 0);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function normalizeDispatchBudget(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveDispatchLimit(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 36) {
    throw new Error(`${name} must be an integer between 1 and 36`);
  }
  return parsed;
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content.trim();
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function boundedSummary(value) {
  const normalized = String(value ?? "").trim();
  return normalized.length <= 1900 ? normalized : `${normalized.slice(0, 1897)}...`;
}

function boundedReason(value) {
  const normalized = String(value ?? "").trim();
  return normalized.length <= 950 ? normalized : `${normalized.slice(0, 947)}...`;
}

function workflowComplete(release, instance, projectRuns, contentItems, contentItemRuns) {
  const activeStages = release.spec.stages.filter((stage) => stageEnabled(stage, instance.inputs ?? {}));
  const projectStages = activeStages.filter((stage) => (stage.scope ?? "project") === "project");
  const itemStages = activeStages.filter((stage) => stage.scope === "content-item");
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

function downstreamStageIds(release, failedStageId) {
  const downstream = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of release?.spec?.stages ?? []) {
      if (downstream.has(stage.id)) continue;
      if ((stage.needs ?? []).some((dependency) => dependency === failedStageId || downstream.has(dependency))) {
        downstream.add(stage.id);
        changed = true;
      }
    }
  }
  return downstream;
}
