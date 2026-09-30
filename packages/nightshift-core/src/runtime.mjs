import {
  compileWorkflow,
  parseWorkflow,
  stageEnabled,
  validateWorkflow,
  WorkflowValidationError,
} from "./workflow.mjs";
import { actionKey, buildAgentBrief, nativeActionKey, planNextActions, projectConcurrencyLimit, requiredApproval, resolveApprovalBinding, stageTimeoutSeconds, WORKBOARD_NOTES_LIMIT } from "./orchestrator.mjs";
import { classifyRunOutcome, classifyTerminalFailure, infrastructureFailureSummary, runEndedNormally, scheduleAutomaticRetry } from "./failure-policy.mjs";
import { normalizeProjectCollaboration } from "./project.mjs";

// A blocked card with an empty Session is read as never started only after this
// long, so a transcript still being written is not mistaken for one.
const NOT_STARTED_GRACE_MS = 2 * 60_000;
// Attempts a card may spend on faults of the substrate before a person hears.
const SUBSTRATE_MAX_ATTEMPTS = 5;

export class NightShiftRuntime {
  constructor({
    board = "nightshift",
    completionValidator = null,
    dispatchMaxStarts = 8,
    maxWorkboardActive = 36,
    terminalInspectionMaxStarts = 3,
    terminalInspectionWindowMs = 30_000,
    // A blocked card whose Agent Session has written nothing for this long has
    // lost its run: the Worker that carried it exited without a terminal message.
    orphanedSessionMs = 45 * 60_000,
    // The 需要你 queue: turns a card that stopped for good into a decision request.
    needsYou = null,
    // The clock behind the inspection budgets and the orphaned-Session age.
    now = () => Date.now(),
    store,
    workboard,
  }) {
    if (!store) throw new Error("NightShift store is required");
    if (!workboard) throw new Error("Workboard adapter is required");
    this.board = board;
    this.completionValidator = completionValidator;
    this.dispatchMaxStarts = positiveDispatchLimit(dispatchMaxStarts, "dispatchMaxStarts");
    this.maxWorkboardActive = positiveDispatchLimit(maxWorkboardActive, "maxWorkboardActive");
    this.terminalInspectionMaxStarts = positiveDispatchLimit(terminalInspectionMaxStarts, "terminalInspectionMaxStarts");
    this.terminalInspectionWindowMs = positiveInteger(terminalInspectionWindowMs, "terminalInspectionWindowMs");
    this.terminalInspectionStarts = [];
    this.sessionInspectionStarts = [];
    this.deferredSessionInspections = new Set();
    this.orphanedSessionMs = positiveInteger(orphanedSessionMs, "orphanedSessionMs");
    this.needsYou = needsYou;
    this.reportReads = new Set();
    this.now = now;
    this.nextReconcileAt = 0;
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

  // Set who hears about a project that was created without it, such as a
  // project already running when notifications were switched on.
  updateInstanceCollaboration(instanceId, collaboration) {
    return this.store.updateInstanceCollaboration(instanceId, normalizeProjectCollaboration(collaboration));
  }

  updateInstanceInputs(instanceId, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Instance input patch must be an object");
    }
    return this.store.updateInstanceInputs(instanceId, patch);
  }

  // Every card this service created for a project is linked to one of its
  // runs, so a project can be read from the native board by exact ID.
  instanceCardIds(instanceId) {
    const ids = new Set();
    for (const run of [...this.store.listStageRuns(instanceId), ...this.store.listContentItemRuns(instanceId)]) {
      if (typeof run.cardId === "string" && run.cardId) ids.add(run.cardId);
    }
    return [...ids];
  }

  async reconcile(instanceId, cards = null, { inspectSessions = true } = {}) {
    this.nextReconcileAt = 0;
    const currentCards = cards ?? await this.workboard.listCards({ cardIds: this.instanceCardIds(instanceId) });
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
      const storedRuns = contentItemLabel ? this.store.listContentItemRuns(instanceId) : this.store.listStageRuns(instanceId);
      const storedRun = storedRuns.filter((entry) => entry.cardId === card.id && entry.stageId === stageId).at(-1);
      let failure = storedRun?.failure ?? null;
      let completionAlreadyValidated = false;
      let completionValidationDeferred = false;
      let terminalReconciliationDeferred = false;
      let terminalSession = null;
      let salvageable = false;
      if (status === "blocked" && failure) {
        const recovered = await this.maybeAutoRetryFailure({ card, contentItemId, failure, instance, stageId });
        status = recovered.status;
        summary = recovered.summary;
        failure = recovered.failure;
      }
      const hasNativeTerminalEvidence = nativeAttemptIsTerminal(card);
      if (!failure && ["running", "review", "blocked"].includes(status) && stage.actor === "agent" && card.sessionKey &&
        (inspectSessions || hasNativeTerminalEvidence || this.deferredSessionInspections.has(card.id))) {
        const recovered = await this.recoverTerminalCard({ card, contentItemId, instance, release, stageId });
        if (recovered?.deferred) {
          terminalReconciliationDeferred = true;
          terminalSession = recovered.terminalSession ?? null;
          salvageable = Boolean(recovered.salvageable);
        } else if (recovered) {
          status = recovered.status;
          summary = recovered.summary;
          failure = recovered.failure ?? null;
          completionAlreadyValidated = recovered.status === "done";
        }
      }
      if ((!terminalReconciliationDeferred || terminalSession || salvageable) && status === "blocked" && (!failure || recoverableContractFailure(failure)) && stage.actor === "agent" && card.sessionKey && !this.store.getHumanAttempt?.(card.id)) {
        const recovered = await this.recoverWrittenArtifacts({ card, cards: currentCards, contentItemId, failure, instance, release, stageId, terminalSession });
        if (recovered) {
          status = recovered.status;
          summary = recovered.summary;
          failure = recovered.failure ?? null;
          completionAlreadyValidated = !recovered.unrecovered;
        }
      }
      const completionValidationEventId = `completion-validation:${card.id}:${card.metadata?.automation?.attempt ?? 1}`;
      if (status === "done" && this.store.getEvent?.(completionValidationEventId)) {
        completionAlreadyValidated = true;
      } else if (status === "done" && stage.actor === "agent" && card.sessionKey && !this.consumeTerminalInspectionBudget()) {
        completionValidationDeferred = true;
        // A native done card still needs the Workflow artifact contract. Keep
        // its local projection pending until validation has actually passed.
        status = "running";
        summary = "Waiting for completion validation";
      }
      if (status === "done" && this.completionValidator && !completionAlreadyValidated && !completionValidationDeferred) {
        try {
          const validation = await this.completionValidator({ card, contentItemId, instance, release, stageId });
          this.store.appendEvent({
            eventId: completionValidationEventId,
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
          failure = contractFailure(error);
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
      if (this.needsYou && status === "blocked" && failure && !failure.agentReport && !failure.automaticRetry &&
        stage.actor === "agent" && card.sessionKey && typeof this.workboard.getSession === "function" &&
        this.needsYou.wantsReport({ card, instance }) && !this.reportReads.has(`${card.id}:${terminalAttempt(card)}`) &&
        this.consumeSessionInspectionBudget()) {
        // Stops recorded before the Agent's report was kept (and reports lost
        // with a Session's last turn): read the Agent's final words once.
        this.reportReads.add(`${card.id}:${terminalAttempt(card)}`);
        try {
          const session = await this.workboard.getSession(card.sessionKey, { limit: 12 });
          const report = lastAssistantText(session);
          if (report) failure = { ...failure, agentReport: boundedSummary(report) };
        } catch {
          // The request opens with the engine's explanation; the next attempt may read it.
        }
      }
      if (this.needsYou && contentItemId && this.isContentItemSkipped(instanceId, contentItemId)) {
        // A person already decided this item is not delivered; its stopped
        // cards are nobody's matter.
        this.store.supersedeDecisionRequests(card.id);
      } else if (this.needsYou) {
        const operation = stage.sideEffects?.length
          ? this.store.listExternalOperations(instanceId).filter((entry) => entry.ownerCardId === card.id).at(-1) ?? null
          : null;
        this.needsYou.observe({ card, instance, stage, stageId, contentItemId, status, failure, summary, operation });
      }
      const run = {
        instanceId,
        stageId,
        attempt: card.metadata?.automation?.attempt ?? 1,
        cardId: card.id,
        status,
        summary,
        failure,
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
    if (!card.sessionKey || ["done", "cancelled"].includes(card.status)) return null;
    if (typeof this.workboard.getSession !== "function") return null;
    if (typeof this.workboard.completeCard !== "function" || typeof this.workboard.blockCard !== "function") return null;
    const attempt = terminalAttempt(card);
    const knownFailure = this.store.getEvent?.(`attempt-failure:${card.id}:${attempt}`);
    if (knownFailure?.payload?.failure) {
      if (card.status !== "blocked") {
        const blocked = await this.workboard.blockCard(card.id, { reason: knownFailure.payload.summary });
        Object.assign(card, blocked);
      }
      return {
        status: "blocked",
        summary: knownFailure.payload.summary,
        failure: knownFailure.payload.failure,
      };
    }
    const knownContractFailure = this.store.getEvent?.(`terminal-blocked:${card.id}:${attempt}`);
    if (knownContractFailure?.payload?.failure) {
      if (card.status !== "blocked") {
        const blocked = await this.workboard.blockCard(card.id, { reason: knownContractFailure.payload.summary });
        Object.assign(card, blocked);
      }
      return {
        status: "blocked",
        summary: knownContractFailure.payload.summary,
        failure: knownContractFailure.payload.failure,
      };
    }
    const inspectionEventId = card.status === "running"
      ? null
      : terminalInspectionEventId(card, attempt);
    const inspected = inspectionEventId ? this.store.getEvent?.(inspectionEventId) : null;
    // Read in this five-minute window already. Written outputs may still be
    // salvaged, unless the Gateway said the run was still going.
    if (inspected) return { deferred: true, salvageable: inspected.type !== "stage.run.active" };
    // Blocked-card Sessions have their own budget. Sharing one with completion
    // validation starved them on V (2026-09-28): 70 validations in two hours
    // used every repair pass's budget, and no blocked card was read at all.
    // A card deferred here is read on the next pass, not the next repair tick.
    if (inspectionEventId && !this.consumeSessionInspectionBudget()) {
      this.deferredSessionInspections.add(card.id);
      return { deferred: true };
    }
    this.deferredSessionInspections.delete(card.id);
    // Ask the Gateway how the run ended before reading anything into the
    // transcript. On V (2026-09-29) six cards whose runs had failed or timed out
    // (Agent DB lease timeouts) left transcripts with no terminal message; read
    // as unfinished, they reached a person as missing handoffs, and one whose
    // run was still going reached a person while its Agent finished the video.
    let endedNormally = false;
    let runEndedAt = 0;
    let runOutcomeRead = false;
    if (card.status === "blocked" && typeof this.workboard.getRunOutcome === "function") {
      const runId = card.runId ?? card.execution?.runId;
      let outcome = null;
      try {
        outcome = runId ? await this.workboard.getRunOutcome({ sessionKey: card.sessionKey, runId }) : null;
      } catch {
        // The transcript below is the fallback.
      }
      if (outcome && ["queued", "running"].includes(String(outcome.status).toLowerCase())) {
        if (inspectionEventId) {
          this.store.appendEvent({
            eventId: inspectionEventId,
            instanceId: instance.id,
            type: "stage.run.active",
            payload: { cardId: card.id, contentItemId, stageId, runId },
          });
        }
        return { deferred: true };
      }
      const runFailure = classifyRunOutcome(outcome);
      if (runFailure) {
        return this.failTerminalAttempt({
          attempt,
          card,
          contentItemId,
          failure: runFailure,
          instance,
          ledgerDecides: true,
          release,
          stageId,
          terminalAt: timestampMs(outcome.endedAt ?? 0) || this.now(),
        });
      }
      endedNormally = runEndedNormally(outcome);
      runEndedAt = timestampMs(outcome?.endedAt ?? 0);
      runOutcomeRead = true;
    }
    let session;
    try {
      session = await this.workboard.getSession(card.sessionKey, { limit: 12 });
    } catch (error) {
      if (inspectionEventId) {
        this.store.appendEvent({
          eventId: inspectionEventId,
          instanceId: instance.id,
          type: "stage.session.inspection-deferred",
          payload: { cardId: card.id, contentItemId, error: error.message, stageId },
        });
      }
      return inspectionEventId ? { deferred: true } : null;
    }
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const latest = messages.at(-1);
    const startedAt = timestampMs(card.execution?.startedAt ?? card.metadata?.attempts?.at(-1)?.startedAt ?? 0);
    let terminalAt = timestampMs(latest?.timestamp ?? latest?.__openclaw?.recordTimestampMs ?? 0);
    const stopReason = String(latest?.stopReason ?? "").toLowerCase();
    const silentMs = this.now() - Math.max(terminalAt, startedAt);
    // The rules below infer a stopped run from the transcript. They apply only
    // when the Gateway has not said the run ended normally: on the shared VLab
    // (2026-09-29) a completed run's transcript read back empty and the first
    // rule failed it as never started, sending the Agent's own stop to a person
    // as a start failure.
    if (!endedNormally && card.status === "blocked" && startedAt > 0 && messages.length === 0 && silentMs >= NOT_STARTED_GRACE_MS) {
      // On V (2026-09-29) a brief card was blocked 7 s after dispatch, during
      // Agent DB lease contention, with an empty Session. Read as "not terminal",
      // it fell through to artifact recovery and reached a person as "the handoff
      // is missing". The Agent never took a turn: that is the execution substrate.
      return this.failTerminalAttempt({
        attempt,
        card,
        contentItemId,
        failure: {
          kind: "agent_not_started",
          source: "gateway",
          rawError: "The Worker blocked this card before the Agent's first turn: its Session has no messages",
          retryable: true,
        },
        instance,
        ledgerDecides: true,
        release,
        stageId,
        terminalAt: this.now(),
      });
    }
    if (!endedNormally && card.status === "blocked" && startedAt > 0 && silentMs >= this.orphanedSessionMs &&
      (latest?.role !== "assistant" || !["stop", "error", "aborted"].includes(stopReason) || terminalAt < startedAt)) {
      // On V two paid produce cards sat blocked for two hours after their Worker
      // exited mid-poll: no terminal message ever arrives for such a run, so it
      // is failed here as interrupted and handed to the ordinary retry policy.
      // A paid stage still retries only when its ledger holds an external task.
      return this.failTerminalAttempt({
        attempt,
        card,
        contentItemId,
        failure: {
          kind: "agent_interrupted",
          source: "runtime",
          rawError: `Agent Session silent for ${Math.round(silentMs / 60_000)} min while its card is blocked`,
          retryable: true,
        },
        instance,
        release,
        stageId,
        terminalAt: this.now(),
      });
    }
    if (!endedNormally && (latest?.role !== "assistant" || !["stop", "error", "aborted"].includes(stopReason) || terminalAt < startedAt)) {
      if (inspectionEventId) {
        this.store.appendEvent({
          eventId: inspectionEventId,
          instanceId: instance.id,
          type: "stage.session.inspected",
          payload: { cardId: card.id, contentItemId, stageId, terminal: false },
        });
      }
      return inspectionEventId ? { deferred: true, terminalSession: session } : null;
    }
    // A transcript that ends on an error is read against the Gateway's run
    // record too when the card was still shown running, so the check above did
    // not run. On V (2026-09-29 21:05) a run the Gateway recorded as a failed
    // provider request ended its transcript on "incomplete or malformed tool
    // call", was classified as the Agent's own error and reached a person.
    let runFailure = null;
    if (!endedNormally && !runOutcomeRead && ["error", "aborted"].includes(stopReason) &&
      typeof this.workboard.getRunOutcome === "function") {
      const runId = card.runId ?? card.execution?.runId;
      let outcome = null;
      try {
        outcome = runId ? await this.workboard.getRunOutcome({ sessionKey: card.sessionKey, runId }) : null;
      } catch {
        // The transcript's own error is the fallback.
      }
      if (outcome && ["queued", "running"].includes(String(outcome.status).toLowerCase())) return null;
      if (runEndedNormally(outcome)) {
        endedNormally = true;
        runEndedAt = timestampMs(outcome?.endedAt ?? 0);
      } else {
        runFailure = classifyRunOutcome(outcome);
      }
    }
    const terminalFailure = endedNormally ? null : runFailure ?? classifyTerminalFailure({ message: latest, session });
    if (terminalFailure) {
      // A retryable kind is a fault of the substrate read from the transcript
      // (a lease timeout, a lost connection), the same fault the Gateway's run
      // record would report. It gets the same ledger rule. On V (2026-09-29
      // 20:21) a paid card whose run failed on an Agent DB lease was read while
      // the board still showed it running, so the Gateway was not asked; with
      // nothing on its ledger it went to a person instead of retrying.
      return this.failTerminalAttempt({
        attempt, card, contentItemId, failure: terminalFailure, instance,
        ledgerDecides: terminalFailure.retryable === true, release, stageId, terminalAt,
      });
    }
    if (endedNormally) terminalAt = runEndedAt || terminalAt;
    const terminalText = endedNormally ? lastAssistantText(session) : messageText(latest);
    try {
      if (this.completionValidator) {
        await this.completionValidator({ card, contentItemId, instance, release, stageId, terminalSession: session });
      }
    } catch (error) {
      const reason = boundedReason(`Terminal Agent Session did not satisfy the Workflow output contract: ${error.message}`);
      // The Agent's own closing words: when it stopped on purpose, they say why.
      const failure = { ...contractFailure(error), ...(terminalText ? { agentReport: boundedSummary(terminalText) } : {}) };
      const blocked = await this.workboard.blockCard(card.id, { reason });
      Object.assign(card, blocked);
      this.store.appendEvent({
        eventId: `terminal-blocked:${card.id}:${attempt}`,
        instanceId: instance.id,
        type: "stage.terminal.blocked",
        payload: { cardId: card.id, contentItemId, error: error.message, failure, stageId, summary: reason, terminalAt },
      });
      return { status: "blocked", summary: reason, failure };
    }
    const summary = boundedSummary(terminalText || `${stageId} completed with validated outputs`);
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

  // ledgerDecides: the run ended by a fault of the substrate (it failed, timed
  // out, or never took a turn), so a paid stage may retry unless the ledger
  // shows an operation this card left unresolved. Agents reserve on the ledger
  // before any paid call.
  async failTerminalAttempt({ attempt, card, contentItemId, failure: terminalFailure, instance, ledgerDecides = false, release, stageId, terminalAt }) {
    const eventId = `attempt-failure:${card.id}:${attempt}`;
    const previousFailures = this.store.listEvents(instance.id, 1000).filter((event) =>
      event.type === "stage.attempt.failed" && event.payload?.cardId === card.id);
    const safeToRetry = this.safeToAutomaticallyRetry({ card, contentItemId, instance, release, stageId }) ||
      (ledgerDecides && this.ledgerSettledFor({ card, contentItemId, instance, stageId }));
    const retry = scheduleAutomaticRetry({
      failure: terminalFailure,
      failureCount: previousFailures.length + 1,
      // A fault of the substrate is not the stage failing: it gets its own,
      // larger allowance, so a card is not handed to a person because lease
      // timeouts and a Gateway restart used up its ordinary retries (V,
      // 2026-09-29: e3f71162's third interruption opened a request).
      maxAttempts: terminalFailure.retryable
        ? Math.max(SUBSTRATE_MAX_ATTEMPTS, release.spec.stages.find((entry) => entry.id === stageId)?.retry?.maxAttempts ?? 1)
        : release.spec.stages.find((entry) => entry.id === stageId)?.retry?.maxAttempts ?? 1,
      safeToRetry,
    });
    const failure = {
      ...terminalFailure,
      ...retry,
      attempt,
      occurredAt: new Date(terminalAt || Date.now()).toISOString(),
    };
    const summary = boundedReason(infrastructureFailureSummary(failure));
    const blocked = await this.workboard.blockCard(card.id, { reason: summary });
    Object.assign(card, blocked);
    this.store.appendEvent({
      eventId,
      instanceId: instance.id,
      type: "stage.attempt.failed",
      payload: { cardId: card.id, contentItemId, failure, stageId, summary, terminalAt },
    });
    return { status: "blocked", summary, failure };
  }

  // A person's answer to a 需要你 request. Retry carries their choice and note
  // into the next attempt's brief; pause stops the project and leaves the
  // request open until someone restarts it and decides. Deciding twice returns
  // the first decision.
  async decide({ decisionId, optionId, note = null, actor, applyToGroup = false }) {
    const request = this.store.getDecisionRequest(decisionId);
    if (!request) throw Object.assign(new Error(`Unknown decision request ${decisionId}`), { statusCode: 404 });
    if (request.status !== "open") return { request, affectedCardIds: [], alreadyDecided: true };
    const option = request.options.find((entry) => entry.id === optionId);
    if (!option) throw Object.assign(new Error(`Unknown option ${optionId}`), { statusCode: 400 });
    if (!actor) throw Object.assign(new Error("actor is required"), { statusCode: 400 });
    if (option.effect === "pause") {
      this.store.updateInstanceStatus(request.instanceId, "paused");
      this.store.appendEvent({
        instanceId: request.instanceId,
        type: "decision.paused",
        payload: { decisionId, actor, note },
      });
      return { request: this.store.getDecisionRequest(decisionId), affectedCardIds: [], alreadyDecided: false };
    }
    if (option.effect === "skip") {
      const targets = applyToGroup
        ? this.store.listDecisionRequests({ instanceId: request.instanceId, status: "open" }).filter((entry) => entry.groupKey === request.groupKey)
        : [request];
      const affectedCardIds = [];
      for (const target of targets) {
        if (!target.contentItemId) continue;
        this.store.skipContentItem({
          instanceId: target.instanceId,
          contentItemId: target.contentItemId,
          reason: note || target.problem,
          actor,
          decisionId: target.id,
        });
        this.store.decideRequest(target.id, { optionId, note, actor });
        this.store.appendEvent({
          instanceId: target.instanceId,
          type: "decision.skipped",
          payload: { decisionId: target.id, cardId: target.cardId, contentItemId: target.contentItemId, actor, note },
        });
        affectedCardIds.push(target.cardId);
      }
      if (affectedCardIds.length === 0) {
        throw Object.assign(new Error("Only a stop on one content item can be skipped"), { statusCode: 400 });
      }
      return { request: this.store.getDecisionRequest(decisionId), affectedCardIds, alreadyDecided: false, errors: [] };
    }
    if (option.effect !== "retry") throw Object.assign(new Error(`Option effect ${option.effect} is not supported yet`), { statusCode: 400 });
    const targets = applyToGroup
      ? this.store.listDecisionRequests({ instanceId: request.instanceId, status: "open" }).filter((entry) => entry.groupKey === request.groupKey)
      : [request];
    const affectedCardIds = [];
    const errors = [];
    for (const target of targets) {
      const decisionNote = [`${actor} 的决定：${option.label}`, option.note, note].filter(Boolean).join("\n");
      try {
        await this.retry({
          actor,
          cardId: target.cardId,
          contentItemId: target.contentItemId,
          evidence: `需要你 ${target.id}：${option.label}${note ? `（${note}）` : ""}`,
          instanceId: target.instanceId,
          stageId: target.stageId,
          decisionNote,
        });
        this.store.decideRequest(target.id, { optionId, note, actor });
        affectedCardIds.push(target.cardId);
      } catch (error) {
        errors.push({ decisionId: target.id, cardId: target.cardId, error: error.message });
      }
    }
    if (affectedCardIds.length === 0 && errors.length) {
      throw Object.assign(new Error(errors[0].error), { statusCode: 409, errors });
    }
    return { request: this.store.getDecisionRequest(decisionId), affectedCardIds, alreadyDecided: false, errors };
  }

  // Items a person decided not to deliver, with the title and reason the
  // delivery brief and the completion notice show.
  skippedContentItems(instanceId) {
    const skipped = this.store.listSkippedContentItems?.(instanceId) ?? [];
    if (skipped.length === 0) return [];
    const items = new Map(this.store.listContentItems(instanceId).map((item) => [item.id, item]));
    return skipped.map((entry) => ({ id: entry.contentItemId, title: items.get(entry.contentItemId)?.title ?? entry.contentItemId, reason: entry.reason, actor: entry.actor }));
  }

  isContentItemSkipped(instanceId, contentItemId) {
    return (this.store.listSkippedContentItems?.(instanceId) ?? []).some((entry) => entry.contentItemId === contentItemId);
  }

  consumeSessionInspectionBudget(now = this.now()) {
    const cutoff = now - this.terminalInspectionWindowMs;
    this.sessionInspectionStarts = this.sessionInspectionStarts.filter((startedAt) => startedAt > cutoff);
    if (this.sessionInspectionStarts.length >= this.terminalInspectionMaxStarts) {
      this.nextReconcileAt = this.sessionInspectionStarts[0] + this.terminalInspectionWindowMs;
      return false;
    }
    this.sessionInspectionStarts.push(now);
    return true;
  }

  consumeTerminalInspectionBudget(now = this.now()) {
    const cutoff = now - this.terminalInspectionWindowMs;
    this.terminalInspectionStarts = this.terminalInspectionStarts.filter((startedAt) => startedAt > cutoff);
    if (this.terminalInspectionStarts.length >= this.terminalInspectionMaxStarts) {
      this.nextReconcileAt = this.terminalInspectionStarts[0] + this.terminalInspectionWindowMs;
      return false;
    }
    this.terminalInspectionStarts.push(now);
    return true;
  }

  safeToAutomaticallyRetry({ card, contentItemId, instance, release, stageId }) {
    if (this.hasHumanTakeover({ cardId: card.id, contentItemId, instanceId: instance.id, stageId })) return false;
    const stage = release.spec.stages.find((entry) => entry.id === stageId);
    if (!Array.isArray(stage?.sideEffects) || stage.sideEffects.length === 0) return true;
    return this.store.listExternalOperations(instance.id).some((operation) =>
      operation.ownerCardId === card.id &&
      operation.stageId === stageId &&
      (operation.contentItemId ?? null) === (contentItemId ?? null) &&
      ["executing", "succeeded"].includes(operation.status) &&
      Boolean(operation.externalTaskId));
  }

  // Agents reserve on the ledger before a paid call, so a card with nothing in
  // flight there has not started one; an earlier attempt of the same card may
  // still have reserved an operation it never resolved. Only a ledger with
  // nothing in flight for this card lets a paid stage retry after a fault.
  ledgerSettledFor({ card, contentItemId, instance, stageId }) {
    if (this.hasHumanTakeover({ cardId: card.id, contentItemId, instanceId: instance.id, stageId })) return false;
    return !this.store.listExternalOperations(instance.id).some((operation) =>
      operation.ownerCardId === card.id &&
      (operation.status === "reserved" || (operation.status === "executing" && !operation.externalTaskId)));
  }

  hasHumanTakeover({ cardId, contentItemId, instanceId, stageId }) {
    if (this.store.getHumanAttempt?.(cardId)) return true;
    return this.store.listApprovals(instanceId).some((approval) =>
      approval.cardId === cardId &&
      approval.stageId === stageId &&
      (approval.contentItemId ?? null) === (contentItemId ?? null) &&
      ["changes_requested", "rejected"].includes(approval.status));
  }

  async maybeAutoRetryFailure({ card, contentItemId, failure, instance, stageId }) {
    if (this.hasHumanTakeover({ cardId: card.id, contentItemId, instanceId: instance.id, stageId })) {
      const cancelledFailure = { ...failure, automaticRetry: false, nextRetryAt: null };
      return { status: "blocked", summary: infrastructureFailureSummary(cancelledFailure), failure: cancelledFailure };
    }
    const summary = infrastructureFailureSummary(failure);
    if (!failure.automaticRetry || !failure.nextRetryAt || Date.parse(failure.nextRetryAt) > Date.now()) {
      return { status: "blocked", summary, failure };
    }
    try {
      await this.retry({
        actor: "Night Shift auto recovery",
        cardId: card.id,
        contentItemId,
        evidence: `${failure.kind} retry window reached`,
        instanceId: instance.id,
        stageId,
      });
      card.status = "ready";
      if (card.metadata?.claim) card.metadata = { ...card.metadata, claim: undefined };
      this.store.appendEvent({
        eventId: `automatic-retry:${card.id}:${failure.attempt}`,
        instanceId: instance.id,
        type: "stage.retry.automatic",
        payload: { cardId: card.id, contentItemId, failure, stageId },
      });
      return { status: "ready", summary: `Automatic retry scheduled after ${failure.kind}`, failure: null };
    } catch (error) {
      this.store.appendEvent({
        eventId: `automatic-retry-deferred:${card.id}:${failure.attempt}`,
        instanceId: instance.id,
        type: "stage.retry.automatic-deferred",
        payload: { cardId: card.id, contentItemId, error: error.message, stageId },
      });
      return { status: "blocked", summary, failure };
    }
  }

  async recoverWrittenArtifacts({ card, cards, contentItemId, failure, instance, release, stageId, terminalSession = null }) {
    if (!this.completionValidator || typeof this.workboard.completeCard !== "function") return null;
    const stage = release?.spec?.stages?.find((entry) => entry.id === stageId);
    // A legacy completion check validates attempt provenance only. It cannot
    // prove that a cancelled or unfinished attempt produced its outputs.
    const hasArtifactContract = stage?.outputs?.includes("deliveryManifest") || (
      release?.spec?.completion?.mode === "strict-v1" &&
      release?.spec?.handoff?.version === 1 && (stage?.completeWhen?.length ?? 0) > 0
    );
    if (!hasArtifactContract) return null;
    try {
      await this.completionValidator({
        card,
        contentItemId,
        instance,
        release,
        reuseExecutionEvidence: Boolean(terminalSession) || recoverableContractFailure(failure),
        stageId,
        terminalSession,
      });
    } catch (error) {
      // Recovery only salvages outputs a finished attempt left behind. Without
      // a recorded failure there is no verdict to keep: nobody claimed these
      // outputs, so their absence says nothing about the Agent's work. Turning
      // it into a contract failure sent eight stopped runs to 需要你 on V
      // (2026-09-28/29) as missing handoffs and unrecorded payments.
      // The board still shows what is missing.
      if (!failure) return { status: "blocked", summary: `Outputs not found yet: ${error.message}`, failure: null, unrecovered: true };
      return { status: "blocked", summary: `Completion validation failed: ${error.message}`, failure: contractFailure(error) };
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

  async retry({ actor, cardId, contentItemId, evidence, instanceId, stageId, decisionNote = null }) {
    const instance = this.store.getInstance(instanceId);
    if (!instance) throw new Error(`Unknown instance ${instanceId}`);
    const release = this.store.getRelease(instance.workflowSha256)?.manifest;
    const stage = release?.spec?.stages?.find((entry) => entry.id === stageId);
    if (!stage || !["agent", "system"].includes(stage.actor)) throw new Error("Only blocked executable stages can be retried");
    const missingApproval = requiredApproval(stage, instance, new Date(), contentItemId ?? null);
    if (missingApproval) throw new Error("Execution confirmation is required before this stage can be retried");
    const cards = await this.workboard.listCards({ cardIds: [cardId] });
    const card = cards.find((entry) => entry.id === cardId);
    if (!card || card.status !== "blocked") throw new Error("Retry requires a blocked Workboard card");
    const contentItem = contentItemId
      ? this.store.listContentItems(instanceId).find((entry) => entry.id === contentItemId)
      : null;
    if (contentItemId && !contentItem) throw new Error(`Unknown content item ${contentItemId}`);
    await this.workboard.updateCard(cardId, {
      idempotencyKey: nativeActionKey(actionKey(release, instance, stage, "run", contentItem)),
      notes: withDecisionNote(buildAgentBrief(release, instance, stage, contentItem,
        this.store.listContentItems(instanceId).filter((item) => !this.isContentItemSkipped(instanceId, item.id)),
        this.skippedContentItems(instanceId)), decisionNote),
      maxRetries: stage.retry?.maxAttempts ?? 1,
      maxRuntimeSeconds: stageTimeoutSeconds(stage.timeout),
    });
    // A retry is a fresh budget. Without the reset, a card that had already
    // failed more than maxRetries times went to ready, the board declined to
    // start it, and the next repair pass judged its old session and blocked it
    // again, so the retry never ran (three cards on V, 2026-09-23 to 09-24).
    await this.workboard.resetCardFailures(cardId, `Night Shift retry by ${actor}`);
    // Retry must clear the prior Attempt's claim atomically with reopening the
    // card. A blocked card can retain a long-lived claim after an interrupted
    // Worker; moving it to ready without releasing that claim makes it look
    // queued while native dispatch correctly refuses to start it.
    await this.workboard.releaseCard(cardId, "ready");
    const runs = contentItemId ? this.store.listContentItemRuns(instanceId) : this.store.listStageRuns(instanceId);
    const run = runs.find((entry) => entry.cardId === cardId && entry.stageId === stageId);
    const updated = {
      ...(run ?? { instanceId, contentItemId, stageId, attempt: 1, cardId }),
      status: "ready",
      summary: `Retry requested by ${actor}: ${evidence ?? "no evidence"}`,
      failure: null,
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
    inspectSessions = true,
    now: nowMs = Date.now(),
  } = {}) {
    const currentCards = cards ?? await this.workboard.listCards({ cardIds: this.instanceCardIds(instanceId) });
    await this.reconcile(instanceId, currentCards, { inspectSessions });
    const instance = this.store.getInstance(instanceId);
    if (!instance) throw new Error(`Unknown instance ${instanceId}`);
    const savedRelease = this.store.getRelease(instance.workflowSha256);
    if (!savedRelease) throw new Error(`Missing release ${instance.workflowSha256}`);
    const runs = this.store.listStageRuns(instanceId);
    // A skipped item is out of the project: nothing more is planned for it, and
    // stages that wait on every item (delivery) wait only on the rest.
    const skippedContentItems = this.skippedContentItems(instanceId);
    const skippedIds = new Set(skippedContentItems.map((entry) => entry.id));
    const contentItems = this.store.listContentItems(instanceId).filter((item) => !skippedIds.has(item.id));
    const contentItemRuns = this.store.listContentItemRuns(instanceId).filter((run) => !skippedIds.has(run.contentItemId));
    const perInstanceLimit = projectConcurrencyLimit(savedRelease.manifest, this.store.getInstanceControl?.(instanceId));
    const actions = planNextActions({
      release: savedRelease.manifest,
      instance,
      runs,
      contentItems,
      contentItemRuns,
      now: new Date(nowMs),
      perInstanceLimit,
      skippedContentItems,
    });
    // A card the board holds for a timed release must wake the scheduler at
    // exactly that moment. Two sources, because the card can be planned in this
    // pass or left over from before a restart, and only the second survives one.
    const dueTimes = [
      ...actions.map(action => action.card?.scheduledAt),
      ...currentCards.filter(card => card.status === "scheduled")
        .map(card => card.metadata?.automation?.scheduledAt ?? card.scheduledAt),
      ...[...runs, ...contentItemRuns].filter(run => run.failure?.automaticRetry).map(run => Date.parse(run.failure.nextRetryAt)),
    ].filter(at => Number.isFinite(at) && at > nowMs);
    let dispatchResult = null;
    const applied = await this.workboard.applyPlan(actions, { cards: currentCards, dryRun });
    if (!dryRun) {
      for (const result of applied) {
        const card = result.card;
        if (!card) continue;
        // Every card this project owns goes in the ledger, whether or not it also
        // becomes a run. That is what keeps idempotency working under a scoped read.
        this.store.recordActionCard?.({ actionKey: result.action.idempotencyKey, cardId: card.id, instanceId });
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
        const now = nowMs;
        // A human stage card is created in review with native dependencies.
        // Workboard holds it in todo until its upstream completes and then
        // promotes it to ready like any other card. Ready is an executable
        // state, so put it back into review before choosing what to dispatch;
        // a human card handed to the dispatcher has no Agent and blocks.
        const stageActor = (card) => {
          const stageId = (card.labels ?? []).find((label) => label.startsWith("stage:"))?.slice("stage:".length)
            ?? card.metadata?.automation?.stageId;
          return savedRelease.manifest.spec.stages.find((entry) => entry.id === stageId)?.actor ?? null;
        };
        for (const card of instanceCards.values()) {
          if (card.status !== "ready" || stageActor(card) !== "human") continue;
          await this.workboard.moveCard(card.id, "review");
          card.status = "review";
          const run = [...runs, ...contentItemRuns].find((entry) => entry.cardId === card.id);
          if (run && run.status !== "review") {
            const updated = { ...run, status: "review" };
            if (run.contentItemId) this.store.upsertContentItemRun(updated); else this.store.upsertStageRun(updated);
          }
        }
        const active = [...instanceCards.values()].filter(cardConsumesDispatchSlot);
        const activeAcrossBoard = currentCards.filter(cardConsumesDispatchSlot).length;
        const cardIds = [...instanceCards.values()].filter((card) =>
          cardIsStartable(card, now) && ["agent", "system"].includes(stageActor(card)) && !active.includes(card) && !cardHasActiveClaim(card, now) && !(card.labels ?? []).includes("nightshift:approval"))
          .map((card) => card.id);
        const maxStarts = Math.min(
          this.dispatchMaxStarts,
          normalizeDispatchBudget(dispatchMaxStarts),
          Math.max(0, this.maxWorkboardActive - activeAcrossBoard),
          Math.max(0, perInstanceLimit - active.length),
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
    const now = nowMs;
    const pendingTimes = [...dueTimes, this.nextReconcileAt].filter(at => Number.isFinite(at) && at > 0);
    return { actions, applied, dispatch: dispatchResult, instance: this.store.getInstance(instanceId),
      retryAfterMs: pendingTimes.length ? Math.max(1, Math.min(...pendingTimes) - now) : null };
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
      const cards = await this.workboard.listCards({ cardIds: this.instanceCardIds(instanceId) });
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

// A card the board holds for a timed release is startable the moment its time
// arrives: the scoped dispatch promotes it and starts it in the same call.
// Leave it out of the scope and nothing ever makes that call, so the release
// never happens and the card waits forever one tick short of going out.
export function cardIsStartable(card, nowMs) {
  if (card?.status === "ready") return true;
  if (card?.status !== "scheduled") return false;
  const at = card.metadata?.automation?.scheduledAt ?? card.scheduledAt;
  return Number.isFinite(at) && at <= nowMs;
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

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function contractFailure(error) {
  return {
    kind: "contract_error",
    source: "workflow",
    rawError: String(error?.message ?? error).slice(0, 2000),
    retryable: false,
    automaticRetry: false,
    nextRetryAt: null,
    validationPhase: error?.completionPhase ?? inferContractFailurePhase(error),
  };
}

function recoverableContractFailure(failure) {
  return failure?.kind === "contract_error" && ["handoff", "outputs", "side_effect"].includes(failure.validationPhase);
}

function inferContractFailurePhase(error) {
  const message = String(error?.message ?? error).toLowerCase();
  if (message.includes("handoff")) return "handoff";
  if (/(artifact|deliverable|manifest|output)/.test(message)) return "outputs";
  if (/(external side effect|checkpoint|ledger)/.test(message)) return "side_effect";
  return "unknown";
}

// The person's decision goes on top of the regenerated brief, inside the
// native Workboard note limit.
function withDecisionNote(brief, note) {
  if (!note) return brief;
  const block = `## 人工决定\n${note}\n\n`;
  const room = WORKBOARD_NOTES_LIMIT - brief.length;
  if (room <= 40) return brief;
  return `${block.length <= room ? block : `${block.slice(0, room - 2)}\n\n`}${brief}`;
}

function timestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function nativeAttemptIsTerminal(card) {
  const status = String(card.metadata?.attempts?.at(-1)?.status ?? card.execution?.status ?? "").toLowerCase();
  return ["aborted", "blocked", "cancelled", "done", "error", "failed", "review", "stopped", "succeeded"].includes(status);
}

function terminalAttempt(card) {
  return card.runId ?? card.execution?.runId ?? card.metadata?.automation?.attempt ?? 1;
}

function terminalInspectionEventId(card, attempt, now = Date.now()) {
  const fiveMinuteBucket = Math.floor(now / 300_000);
  return `session-inspection:${card.id}:${attempt}:${fiveMinuteBucket}`;
}

function lastAssistantText(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "assistant") continue;
    const text = messageText(messages[index]);
    if (text) return text;
  }
  return "";
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
