import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// The 2026-08-25 build used "feishu-notifications-v1.bootstrap" and left it set on
// V. This build tracks subjects it never saw, so it takes a fresh baseline: the
// first pass records every project's current state and sends nothing, and only
// later transitions to done are announced. Without it, every project already
// finished before the upgrade would be announced at once.
const BOOTSTRAP_KEY = "feishu-notifications-v2.bootstrap";

// Tells the person who asked for a project, in Feishu, when it finishes.
// Carried over from the 2026-08-25 build (5cb239f), which reached V from a side
// branch, never reached dev, and was replaced by the next release built from dev.
export class NightShiftNotificationCoordinator {
  constructor({ baseUrl, now = () => new Date(), sender, store }) {
    if (!baseUrl) throw new Error("Night Shift public base URL is required for notifications");
    if (!sender) throw new Error("Night Shift notification sender is required");
    if (!store) throw new Error("Night Shift store is required for notifications");
    this.baseUrl = baseUrl;
    this.now = now;
    this.sender = sender;
    this.store = store;
  }

  async reconcile({ cards, instances, releases }) {
    const releaseBySha = new Map(releases.map((release) => [release.workflowSha256, release]));
    const watched = instances
      .map((instance) => ({ instance, settings: notificationSettings(releaseBySha.get(instance.workflowSha256)) }))
      .filter(({ instance, settings }) => settings.instanceCompleted?.enabled === true && completionTarget(instance, settings));

    if (!this.store.getNotificationMetadata(BOOTSTRAP_KEY)) {
      for (const { instance } of watched) {
        this.store.transitionNotificationSubject(`instance:${instance.id}`, instance.status, this.now());
      }
      this.store.setNotificationMetadata(BOOTSTRAP_KEY, { completedAt: this.now().toISOString() }, this.now());
      return { bootstrapped: true, delivered: [], queued: [] };
    }

    const queued = [];
    for (const { instance, settings } of watched) {
      const transition = this.store.transitionNotificationSubject(`instance:${instance.id}`, instance.status, this.now());
      if (!transition.changed || instance.status !== "done") continue;
      const projectCards = cards.filter((card) => cardInstanceId(card) === instance.id);
      queued.push(this.enqueueCompletion({
        cards: projectCards,
        generation: transition.generation,
        instance,
        target: completionTarget(instance, settings),
      }));
    }
    const delivered = await this.deliverPending();
    return { bootstrapped: false, delivered, queued };
  }

  enqueueCompletion({ cards, generation, instance, target }) {
    const projectUrl = dashboardUrl(this.baseUrl, { project: instance.id, view: "workflows" });
    return this.store.enqueueNotification({
      allowedOpenIds: [instance.collaboration?.createdByOpenId].filter(Boolean),
      fallbackText: `项目已完成：${instance.name}\n${projectUrl}`,
      instanceId: instance.id,
      kind: "instance-completed",
      notificationKey: `complete:${instance.id}:${generation}`,
      presentation: completionPresentation({ instance, projectUrl, summary: summarizeCards(cards) }),
      targetChatId: target,
    }, this.now());
  }

  async deliverPending() {
    const results = [];
    for (const delivery of this.store.listPendingNotifications()) {
      try {
        const sent = await this.sender.send(delivery);
        this.store.markNotificationDelivered(delivery.id, sent.messageId, this.now());
        this.store.appendEvent({
          instanceId: delivery.instanceId,
          type: "notification.delivered",
          payload: { kind: delivery.kind, messageId: sent.messageId ?? null, target: delivery.targetChatId },
          now: this.now(),
        });
        results.push({ id: delivery.id, ok: true, messageId: sent.messageId ?? null });
      } catch (error) {
        this.store.markNotificationFailed(delivery.id, error.message, this.now());
        this.store.appendEvent({
          instanceId: delivery.instanceId,
          type: "notification.failed",
          payload: { error: error.message, kind: delivery.kind, target: delivery.targetChatId },
          now: this.now(),
        });
        results.push({ error: error.message, id: delivery.id, ok: false });
      }
    }
    return results;
  }
}

// The project's own creator chat wins; a schedule-created project falls back to
// the Workflow's declared target.
export function completionTarget(instance, settings) {
  return instance.collaboration?.sourceChatId || settings?.instanceCompleted?.to || null;
}

function notificationSettings(release) {
  return release?.manifest?.spec?.notifications ?? release?.spec?.notifications ?? {};
}

export class OpenClawFeishuNotificationSender {
  constructor({
    accountId = process.env.NIGHTSHIFT_FEISHU_ACCOUNT_ID,
    command = process.env.NIGHTSHIFT_OPENCLAW_COMMAND ?? "openclaw",
    configPath = process.env.OPENCLAW_CONFIG_PATH,
    entry = process.env.NIGHTSHIFT_OPENCLAW_ENTRY,
    env = process.env,
    runner = defaultRunner,
  } = {}) {
    this.accountId = accountId;
    this.command = command;
    this.configPath = configPath;
    this.entry = entry;
    this.env = env;
    this.runner = runner;
  }

  async send(delivery) {
    const args = [
      ...(this.entry ? [this.entry] : []),
      "message", "send",
      "--channel", "feishu",
      "--target", delivery.targetChatId,
      "--message", delivery.fallbackText,
      "--presentation", JSON.stringify(delivery.presentation),
      "--json",
      ...(this.accountId ? ["--account", this.accountId] : []),
    ];
    const output = await this.runner(this.command, args, {
      ...this.env,
      ...(this.configPath ? { OPENCLAW_CONFIG_PATH: this.configPath } : {}),
    });
    const parsed = typeof output === "string" ? JSON.parse(output) : output;
    return { messageId: parsed.messageId ?? parsed.message_id ?? parsed.id ?? null, raw: parsed };
  }
}

export function completionPresentation({ instance, projectUrl, summary }) {
  return {
    title: `项目已完成 · ${instance.name}`,
    tone: "success",
    blocks: [
      { type: "text", text: `**全部流程已经结束**\n完成 ${summary.done} 项，阻塞 ${summary.blocked} 项。` },
      { type: "context", text: `Night Shift 项目 · ${instance.id}` },
      { type: "buttons", buttons: [{ label: "查看交付", style: "primary", url: projectUrl }] },
    ],
  };
}

function summarizeCards(cards) {
  return {
    blocked: cards.filter((card) => card.status === "blocked").length,
    done: cards.filter((card) => card.status === "done").length,
  };
}

function cardInstanceId(card) {
  return card.metadata?.automation?.instanceId ??
    card.labels?.find((entry) => entry.startsWith("instance:"))?.slice("instance:".length) ??
    null;
}

function dashboardUrl(baseUrl, parameters) {
  const url = new URL("/", baseUrl);
  for (const [key, value] of Object.entries(parameters)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

async function defaultRunner(command, args, env) {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: "utf8", env, maxBuffer: 4 * 1024 * 1024, timeout: 20000 });
    return stdout;
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? "").trim().slice(0, 2000);
    throw new Error(`Feishu notification delivery failed${detail ? `: ${detail}` : ""}`);
  }
}
