import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { buildNeedsYou } from "./needs-you.mjs";

const execFileAsync = promisify(execFile);
// The 2026-08-25 build used "feishu-notifications-v1.bootstrap" and left it set on
// V. This build tracks subjects it never saw, so it takes a fresh baseline: the
// first pass records every project's current state and sends nothing, and only
// later transitions to done are announced. Without it, every project already
// finished before the upgrade would be announced at once.
const BOOTSTRAP_KEY = "feishu-notifications-v2.bootstrap";
// Review cards already waiting when 需要你 notices first run are not announced.
const NEEDS_YOU_BOOTSTRAP_KEY = "needs-you-notice-v1.bootstrap";
// Stops that arrive together are announced together.
const NEEDS_YOU_BATCH_MS = 120_000;

// Tells the person who asked for a project, in Feishu, when it finishes.
// Carried over from the 2026-08-25 build (5cb239f), which reached V from a side
// branch, never reached dev, and was replaced by the next release built from dev.
export class NightShiftNotificationCoordinator {
  constructor({ baseUrl, now = () => new Date(), sender, store, needsYouBatchMs = NEEDS_YOU_BATCH_MS }) {
    if (!baseUrl) throw new Error("Night Shift public base URL is required for notifications");
    if (!sender) throw new Error("Night Shift notification sender is required");
    if (!store) throw new Error("Night Shift store is required for notifications");
    this.baseUrl = baseUrl;
    this.now = now;
    this.sender = sender;
    this.store = store;
    this.needsYouBatchMs = needsYouBatchMs;
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
    queued.push(...this.enqueueNeedsYou({ cards, instances, releaseBySha }));
    const delivered = await this.deliverPending();
    return { bootstrapped: false, delivered, queued };
  }

  // One notice per project for what newly needs a person: stops (decision
  // requests) grouped by root cause, and review cards waiting on someone.
  enqueueNeedsYou({ cards, instances, releaseBySha }) {
    const now = this.now();
    const bootstrap = !this.store.getNotificationMetadata(NEEDS_YOU_BOOTSTRAP_KEY);
    const releases = [...releaseBySha.values()];
    const queue = buildNeedsYou({ store: this.store, instances, cards, releases, now: now.getTime() });
    const byInstance = new Map();
    // A person already told about a stop in this project and stage, and not
    // done with it, is not told again: later stops join it on the board. On
    // V the broken Brazil proxy was announced four times in two nights, once
    // per GeeLark item (2026-10-07 22:00 and 23:44, 10-08 01:04 and 01:07).
    const told = new Set(this.store.listDecisionRequests({ status: "open" })
      .filter((request) => request.announcedAt)
      .map((request) => `${request.instanceId}\u0000${request.stageId}`));
    const joined = [];
    for (const item of queue.items) {
      if (item.kind === "decision") {
        const request = this.store.getDecisionRequest(item.id);
        if (!request || request.announcedAt) continue;
        if (now.getTime() - Date.parse(request.createdAt) < this.needsYouBatchMs) continue;
        if (told.has(`${request.instanceId}\u0000${request.stageId}`)) {
          joined.push(request.id);
          continue;
        }
      } else {
        const transition = this.store.transitionNotificationSubject(`needs-you:${item.cardId}`, "review", now);
        if (!transition.changed || bootstrap) continue;
      }
      if (!byInstance.has(item.instanceId)) byInstance.set(item.instanceId, []);
      byInstance.get(item.instanceId).push(item);
    }
    if (joined.length) this.store.markDecisionRequestsAnnounced(joined, now);
    if (bootstrap) this.store.setNotificationMetadata(NEEDS_YOU_BOOTSTRAP_KEY, { completedAt: now.toISOString() }, now);
    const queued = [];
    for (const [instanceId, items] of byInstance) {
      const instance = instances.find((entry) => entry.id === instanceId);
      const settings = needsYouSettings(releaseBySha.get(instance?.workflowSha256));
      // The project's own chat wins; else the Workflow's target for this event.
      const target = settings.enabled === true ? (instance?.collaboration?.sourceChatId || settings.to || null) : null;
      const decisionIds = items.filter((item) => item.kind === "decision").map((item) => item.id);
      // Without a target nothing is sent, but the requests still count as seen.
      if (target) {
        const projectUrl = dashboardUrl(this.baseUrl, { project: instance.id, view: "workflows" });
        const digest = createHash("sha256").update(items.map((item) => item.id).sort().join("\n")).digest("hex").slice(0, 16);
        const stages = releaseBySha.get(instance.workflowSha256)?.manifest?.spec?.stages ?? [];
        const groups = needsYouGroups({ items, stages, store: this.store });
        queued.push(this.store.enqueueNotification({
          allowedOpenIds: [instance.collaboration?.createdByOpenId].filter(Boolean),
          fallbackText: `需要你决定：${instance.name}\n${groups.map((group) => `${group.heading}：${group.problem}`).join("\n")}\n${projectUrl}`,
          instanceId: instance.id,
          kind: "needs-you",
          notificationKey: `needs-you:${instance.id}:${digest}`,
          presentation: needsYouPresentation({ instance, groups, projectUrl, now }),
          targetChatId: target,
        }, now));
      }
      this.store.markDecisionRequestsAnnounced(decisionIds, now);
    }
    return queued;
  }

  enqueueCompletion({ cards, generation, instance, target }) {
    const projectUrl = dashboardUrl(this.baseUrl, { project: instance.id, view: "workflows" });
    const skipped = this.store.listSkippedContentItems?.(instance.id) ?? [];
    const titles = new Map((this.store.listContentItems?.(instance.id) ?? []).map((item) => [item.id, item.title]));
    const skippedIds = new Set(skipped.map((entry) => entry.contentItemId));
    // A skipped item's stopped card is settled by the person's decision.
    const counted = cards.filter((card) => !skippedIds.has(contentItemLabel(card)));
    return this.store.enqueueNotification({
      allowedOpenIds: [instance.collaboration?.createdByOpenId].filter(Boolean),
      fallbackText: `项目已完成：${instance.name}\n${projectUrl}`,
      instanceId: instance.id,
      kind: "instance-completed",
      notificationKey: `complete:${instance.id}:${generation}`,
      presentation: completionPresentation({
        instance,
        projectUrl,
        summary: summarizeCards(counted),
        skipped: skipped.map((entry) => ({ id: entry.contentItemId, title: titles.get(entry.contentItemId) ?? entry.contentItemId, reason: entry.reason })),
      }),
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

// Who hears that a project needs them: the Workflow's own needsYou setting, or
// else whoever hears when it finishes.
function needsYouSettings(release) {
  const notifications = notificationSettings(release);
  if (notifications.needsYou) return notifications.needsYou;
  return notifications.instanceCompleted?.enabled ? notifications.instanceCompleted : {};
}

// One group per root cause, carrying everything the card shows for it.
export function needsYouGroups({ items, stages = [], store = null }) {
  const groups = new Map();
  for (const item of items) {
    const entry = groups.get(item.groupKey) ?? { items: [], first: item };
    entry.items.push(item);
    groups.set(item.groupKey, entry);
  }
  return [...groups.values()].map(({ items: members, first }) => {
    const stage = stages.find((entry) => entry.id === first.stageId);
    const stageTitle = stage?.title || first.stageId || "这一步";
    const count = members.length;
    if (first.kind === "decision") {
      const request = store?.getDecisionRequest(first.id) ?? first;
      return {
        kind: "decision",
        heading: `${stageTitle}停下了：${count} 张卡${count > 1 ? "，同一件事" : ""}`,
        problem: request.problem,
        cause: request.cause || "",
        impact: request.impact || "",
        suggestion: request.suggestion || "",
        options: request.options ?? first.options,
      };
    }
    const waiting = first.kind === "approval" ? "等你确认" : "等你审核";
    return {
      kind: first.kind,
      heading: `${stageTitle}${waiting}：${count} 张卡`,
      problem: members.map((member) => member.problem).slice(0, 3).join("；") + (count > 3 ? " 等" : ""),
      cause: "",
      impact: "",
      suggestion: "",
      options: first.options,
    };
  });
}

// What the person is asked to do first, then one sentence of why, then every
// answer with what it does, and a link to the board (Tianyi, 2026-10-08: the
// card must say what to do, not what the system saw).
export function needsYouPresentation({ instance, groups, projectUrl, now = new Date() }) {
  const blocks = [];
  for (const group of groups) {
    blocks.push({ type: "text", text: `**${group.heading}**` });
    if (group.kind === "decision") {
      blocks.push({ type: "text", text: `**需要你做**\n${group.problem}` });
      if (group.cause) blocks.push({ type: "text", text: `**为什么**\n${group.cause}` });
      if (group.impact) blocks.push({ type: "text", text: `**影响**\n${group.impact}` });
      if (group.suggestion) blocks.push({ type: "text", text: `**建议怎么做**\n${group.suggestion}` });
    } else {
      blocks.push({ type: "text", text: group.problem });
    }
  }
  const options = new Map();
  for (const group of groups) for (const option of group.options ?? []) if (!options.has(option.id)) options.set(option.id, option);
  if (options.size) {
    blocks.push({
      type: "text",
      text: `**做完后选**\n${[...options.values()].map((option) => `· **${option.label}**${option.description ? `：${option.description}` : ""}`).join("\n")}`,
    });
  }
  const at = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
  blocks.push({ type: "context", text: `项目 ${instance.id} · ${at} · 同一原因的卡会合并在这一条里` });
  blocks.push({ type: "buttons", buttons: [{ label: "去看板处理", style: "primary", url: projectUrl }] });
  return { title: `需要你处理 · ${instance.name}`, tone: "warning", blocks };
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

export function completionPresentation({ instance, projectUrl, summary, skipped = [] }) {
  const skippedLines = skipped.map((entry) => `· ${entry.title}${entry.reason ? `：${truncateText(entry.reason, 120)}` : ""}`);
  return {
    title: `项目已完成 · ${instance.name}`,
    tone: "success",
    blocks: [
      { type: "text", text: `**全部流程已经结束**\n完成 ${summary.done} 项，阻塞 ${summary.blocked} 项。` },
      ...(skipped.length ? [{ type: "text", text: `**跳过 ${skipped.length} 条（有人决定不交付）**\n${skippedLines.join("\n")}` }] : []),
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

function contentItemLabel(card) {
  return card.labels?.find((entry) => entry.startsWith("content-item:"))?.slice("content-item:".length) ?? null;
}

function truncateText(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
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
