import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { nativeActionKey } from "./orchestrator.mjs";

const execFileAsync = promisify(execFile);

export class WorkboardGatewayAdapter {
  constructor({
    board = "nightshift",
    command = process.env.NIGHTSHIFT_OPENCLAW_COMMAND ?? "openclaw",
    configPath = process.env.OPENCLAW_CONFIG_PATH,
    entry = process.env.NIGHTSHIFT_OPENCLAW_ENTRY,
    env = process.env,
    gatewayUrl = process.env.NIGHTSHIFT_GATEWAY_URL,
    now = Date.now,
    runner = defaultRunner,
    sleep = defaultSleep,
    startBurst = process.env.NIGHTSHIFT_DISPATCH_START_BURST ?? 3,
    startIntervalMs = process.env.NIGHTSHIFT_DISPATCH_START_INTERVAL_MS ?? 15_000,
  } = {}) {
    this.board = board;
    this.command = command;
    this.configPath = configPath;
    this.entry = entry;
    this.env = env;
    this.gatewayUrl = gatewayUrl;
    this.now = now;
    this.runner = runner;
    this.sleep = sleep;
    this.startBurst = dispatchBurst(startBurst);
    this.startIntervalMs = dispatchInterval(startIntervalMs);
    this.startWindowAt = null;
    this.startsInWindow = 0;
    this.startGate = Promise.resolve();
  }

  async listCards({ cardIds } = {}) {
    const ids = Array.isArray(cardIds) ? uniqueCardIds(cardIds) : null;
    if (ids?.length === 0) return [];
    const result = await this.call("workboard.cards.list", { boardId: this.board, ...(ids ? { cardIds: ids } : {}) });
    return result.cards ?? [];
  }

  async applyPlan(actions, { cards = null, dryRun = false } = {}) {
    const knownCards = cards ? [...cards] : await this.listCards();
    const results = [];
    for (const action of actions) {
      const result = await this.applyAction(action, { dryRun, cards: knownCards });
      results.push(result);
      if (result.card && !knownCards.some((card) => card.id === result.card.id)) knownCards.push(result.card);
    }
    return results;
  }

  async applyAction(action, { dryRun = false, cards = null } = {}) {
    if (action.type === "schedule_timer") {
      return { action, status: "deferred", reason: "timer_store_required" };
    }
    const marker = gatewayIdempotencyLabel(action.idempotencyKey);
    const existing = (cards ?? await this.listCards()).find((card) =>
      (card.labels ?? []).includes(marker),
    );
    if (existing) return { action, card: existing, status: "reused" };

    const card = action.card ?? approvalCard(action);
    const payload = {
      title: card.title,
      status: card.status ?? "ready",
      priority: card.priority ?? "normal",
      agentId: card.assignedAgent ?? undefined,
      labels: [...new Set([...(card.labels ?? []), marker])],
      maxRetries: card.automation?.maxAttempts ?? undefined,
      maxRuntimeSeconds: card.automation?.maxRuntimeSeconds ?? undefined,
      notes: card.notes ?? null,
      metadata: {
        automation: {
          ...(card.automation ?? {}),
          boardId: this.board,
          idempotencyKey: nativeActionKey(action.idempotencyKey),
        },
      },
    };
    if (dryRun) return { action, payload, status: "planned" };
    const result = await this.call("workboard.cards.create", payload);
    return { action, card: result.card, status: "created" };
  }

  async moveCard(id, status, position) {
    const result = await this.call("workboard.cards.move", { id, position, status });
    return result.card;
  }

  async updateCard(id, patch) {
    const result = await this.call("workboard.cards.update", { id, patch });
    return result.card;
  }

  async dispatch(maxStarts = 1, { cardIds } = {}) {
    const scopedCardIds = uniqueCardIds(cardIds);
    if (scopedCardIds.length === 0) {
      throw new Error("Night Shift dispatch requires an explicit non-empty card scope");
    }
    if (!Number.isSafeInteger(maxStarts) || maxStarts < 1) throw new Error("maxStarts must be a positive integer");
    const started = [];
    const startFailures = [];
    // Native exact-card start is supported by 9.1 without relying on scoped
    // dispatch extensions. Never downgrade to a board-wide dispatch request.
    for (const id of scopedCardIds.slice(0, maxStarts)) {
      try {
        await this.waitForStartSlot();
        const result = await this.call("workboard.cards.start", { id });
        if (result.card?.id !== id || !result.sessionKey || !result.runId) {
          throw new Error("Native start did not return the requested card and auditable sessionKey/runId");
        }
        started.push(result);
      } catch (error) {
        startFailures.push({ cardId: id, error: error.message });
        // A lost reply may already have started this card. Do not start a
        // replacement or retry it until the next authoritative snapshot.
        break;
      }
    }
    return { started, startFailures };
  }

  async waitForStartSlot() {
    const previous = this.startGate;
    let release;
    this.startGate = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      let current = this.now();
      if (this.startWindowAt === null || current >= this.startWindowAt + this.startIntervalMs) {
        this.startWindowAt = current;
        this.startsInWindow = 0;
      }
      if (this.startsInWindow >= this.startBurst) {
        const waitMs = Math.max(0, this.startWindowAt + this.startIntervalMs - current);
        if (waitMs > 0) await this.sleep(waitMs);
        current = this.now();
        this.startWindowAt = current;
        this.startsInWindow = 0;
      }
      this.startsInWindow += 1;
    } finally {
      release();
    }
  }

  async getSession(sessionKey, { limit = 300 } = {}) {
    if (!sessionKey) throw new Error("A native Workboard session key is required");
    return this.call("sessions.get", { key: sessionKey, limit });
  }

  async completeCard(id, input = {}) {
    const result = await this.call("workboard.cards.complete", { id, ...input });
    return result.card;
  }

  async blockCard(id, input = {}) {
    const result = await this.call("workboard.cards.block", { id, ...input });
    return result.card;
  }

  async getSkillsStatus(agentId) {
    if (!agentId) throw new Error("An Agent id is required for Skill preflight");
    return this.call("skills.status", { agentId });
  }

  async call(method, params) {
    if (!this.gatewayUrl) throw new Error("NIGHTSHIFT_GATEWAY_URL is required");
    if (!this.configPath) throw new Error("OPENCLAW_CONFIG_PATH is required");
    const config = JSON.parse(await readFile(this.configPath, "utf8"));
    const token = config.gateway?.auth?.token;
    if (!token) throw new Error("Gateway auth token is missing from the configured file");
    const args = [
      ...(this.entry ? [this.entry] : []),
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--json",
      "--timeout",
      "10000",
    ];
    const output = await this.runner(this.command, args, {
      ...this.env,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_URL: this.gatewayUrl,
    });
    return typeof output === "string" ? JSON.parse(output) : output;
  }
}

function uniqueCardIds(cardIds) {
  if (!Array.isArray(cardIds)) return [];
  return [...new Set(cardIds
    .filter((id) => typeof id === "string" && id.trim())
    .map((id) => id.trim()))];
}

function dispatchInterval(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 60_000) {
    throw new Error("startIntervalMs must be an integer between 0 and 60000");
  }
  return parsed;
}

function dispatchBurst(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 36) {
    throw new Error("startBurst must be an integer between 1 and 36");
  }
  return parsed;
}

export function gatewayIdempotencyLabel(key) {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 20);
  return `nightshift-action:${digest}`;
}

function approvalCard(action) {
  return {
    title: `${action.instanceId}｜${action.contentItemId ? `${action.contentItemId}｜` : ""}审批 ${action.stageId}`,
    status: "review",
    labels: [
      `instance:${action.instanceId}`,
      `stage:${action.stageId}`,
      ...(action.contentItemId ? [`content-item:${action.contentItemId}`] : []),
      "nightshift:approval",
    ],
    automation: { approval: action.approval, contentItemId: action.contentItemId ?? null, instanceId: action.instanceId, stageId: action.stageId },
  };
}

async function defaultRunner(command, args, env) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      env,
      killSignal: "SIGKILL",
      // A Night Shift board can contain many evidence-rich cards. Gateway list
      // responses are compact at the API boundary but still exceed Node's 8 MiB
      // execFile default once the board is long-lived; do not make the scheduler
      // fail solely while reading that authoritative snapshot.
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15000,
    });
    return stdout;
  } catch (error) {
    const detail = gatewayRpcFailureDetail(error, env.OPENCLAW_GATEWAY_TOKEN);
    throw new Error(
      `OpenClaw Gateway RPC failed${error?.code ? ` (exit ${error.code})` : ""}${detail ? `: ${detail}` : ""}`,
    );
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function gatewayRpcFailureDetail(error, token) {
  let detail = String(error?.stderr ?? "").trim();
  try {
    const payload = JSON.parse(String(error?.stdout ?? ""));
    if (payload.ok === false && typeof payload.error?.message === "string") detail = payload.error.message;
  } catch { /* Older CLI versions report errors on stderr. */ }
  if (typeof token === "string" && token) detail = detail.replaceAll(token, "[redacted]");
  return detail.slice(0, 2000);
}
