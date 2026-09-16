import { createHash, randomUUID } from "node:crypto";
import { requiredApproval } from "./orchestrator.mjs";
import { stageEnabled } from "./workflow.mjs";

export function publicHumanAttempt(record) {
  if (!record) return null;
  const { token, ...visible } = record;
  return visible;
}

export function evidenceHash(evidence) {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

// The record lives in the controller database, never in caller-supplied card metadata.
export function humanCompletionEvidence({ store, card, instance, stageId, contentItemId, submittedAttempt }) {
  const attempt = store.getHumanAttempt(card.id);
  if (!attempt) return null;
  if (attempt.instanceId !== instance.id || attempt.workflowSha256 !== instance.workflowSha256 ||
      attempt.stageId !== stageId || (attempt.contentItemId ?? null) !== (contentItemId ?? null)) {
    throw new Error("Human attempt does not match the pinned card and Workflow");
  }
  const submitting = submittedAttempt?.id === attempt.id && attempt.status === "running";
  if (!submitting && !["completing", "done"].includes(attempt.status)) {
    throw new Error("Human takeover must be submitted through its controlled completion entry");
  }
  if (card.sessionKey || card.runId || card.execution?.status === "running") {
    throw new Error("Human attempt cannot replace a native Agent execution");
  }
  if (card.status !== "done" && card.metadata?.claim?.ownerId !== attempt.ownerId) {
    throw new Error("Human attempt no longer owns this card");
  }
  return { id: attempt.id, actor: attempt.actor, reason: attempt.reason, startedAt: attempt.startedAt, mode: "human" };
}

export class HumanAttemptController {
  constructor({ store, workboard, validateCompletion }) {
    Object.assign(this, { store, workboard, validateCompletion });
  }

  async context(instanceId, cardId) {
    const instance = this.store.getInstance(instanceId);
    if (!instance || !["active", "paused"].includes(instance.status)) throw new Error("Project is not available for takeover");
    const card = (await this.workboard.listCards({ cardIds: [cardId] })).find((entry) => entry.id === cardId);
    const labels = card?.labels ?? [];
    if (!card || !labels.includes(`instance:${instanceId}`) || labels.includes("nightshift:approval")) {
      throw new Error("Takeover card must belong to this project and cannot be an approval card");
    }
    const stageId = labels.find((label) => label.startsWith("stage:"))?.slice(6);
    const contentItemId = labels.find((label) => label.startsWith("content-item:"))?.slice(13) ?? null;
    const release = this.store.getRelease(instance.workflowSha256)?.manifest;
    const stage = release?.spec?.stages?.find((entry) => entry.id === stageId);
    if (stage?.actor !== "agent" || !stageEnabled(stage, instance.inputs ?? {})) throw new Error("Takeover requires an enabled Agent stage");
    if (release.spec?.handoff?.version !== 1 || release.spec?.completion?.mode !== "strict-v1") throw new Error("Human takeover requires a declared handoff and strict output contract");
    if (requiredApproval(stage, instance, new Date(), contentItemId)) throw new Error("Required execution approval is missing");
    return { card, contentItemId, instance, release, stageId };
  }

  async takeover({ instanceId, cardId, actor, reason }) {
    if (!actor?.trim() || !reason?.trim()) throw new Error("Takeover requires an identified operator and a reason");
    const context = await this.context(instanceId, cardId);
    const { card, instance, contentItemId, stageId } = context;
    if (this.store.getInstanceControl(instanceId).automaticDispatch) throw new Error("Disable this project's automatic dispatch before takeover");
    if (card.sessionKey || card.runId || card.execution?.status === "running") throw new Error("Native Agent execution cannot be taken over through a ready-card claim");
    let attempt = this.store.getHumanAttempt(cardId);
    if (attempt && attempt.actor !== actor) throw new Error("Another operator owns this takeover");
    if (attempt?.status === "running" && card.metadata?.claim?.ownerId === attempt.ownerId) return publicHumanAttempt(attempt);
    if (attempt && attempt.status !== "claiming") throw new Error("This card already has a human execution record");
    if (card.status !== "ready" && !(attempt && card.metadata?.claim?.ownerId === attempt.ownerId)) throw new Error("Takeover requires an unclaimed ready card");
    if (!attempt) {
      const id = randomUUID();
      attempt = this.store.saveHumanAttempt({ id, cardId, instanceId, contentItemId, stageId,
        workflowSha256: instance.workflowSha256, actor, reason: reason.trim(), ownerId: `nightshift:human:${id}`,
        token: randomUUID(), startedAt: new Date().toISOString(), status: "claiming" });
      this.event(attempt, "human.takeover.requested");
    }
    // Persisted token makes a lost claim response recoverable without double-claiming.
    if (card.metadata?.claim?.ownerId !== attempt.ownerId) {
      await this.workboard.call("workboard.cards.claim", { id: cardId, ownerId: attempt.ownerId, token: attempt.token, ttlSeconds: 86400 });
    }
    attempt = this.store.saveHumanAttempt({ ...attempt, status: "running" });
    this.event(attempt, "human.takeover.started");
    return publicHumanAttempt(attempt);
  }

  async complete({ instanceId, cardId, actor }) {
    const context = await this.context(instanceId, cardId);
    let attempt = this.store.getHumanAttempt(cardId);
    if (!attempt || attempt.actor !== actor || !["running", "completing", "done"].includes(attempt.status)) throw new Error("No owned human attempt to complete");
    const evidence = await this.validateCompletion({ ...context, submittedAttempt: attempt });
    const digest = evidenceHash(evidence);
    if (attempt.evidenceSha256 && attempt.evidenceSha256 !== digest) throw new Error("Validated human completion evidence changed");
    if (context.card.status !== "done") {
      attempt = this.store.saveHumanAttempt({ ...attempt, status: "completing", evidenceSha256: digest });
      await this.workboard.completeCard(cardId, { ownerId: attempt.ownerId, token: attempt.token,
        summary: `Human execution completed by ${actor}`,
        proof: { status: "passed", label: "Audited human execution", note: `attempt=${attempt.id}; evidenceSha256=${digest}` } });
    }
    attempt = this.store.saveHumanAttempt({ ...attempt, status: "done", evidenceSha256: digest, endedAt: attempt.endedAt ?? new Date().toISOString() });
    this.event(attempt, "human.takeover.completed");
    return publicHumanAttempt(attempt);
  }

  event(attempt, type) {
    this.store.appendEvent({ eventId: `${type}:${attempt.id}`, instanceId: attempt.instanceId, type, payload: publicHumanAttempt(attempt) });
  }
}
