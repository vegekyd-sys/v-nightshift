import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class WorkboardGatewayAdapter {
  constructor({
    board = "nightshift",
    command = process.env.NIGHTSHIFT_OPENCLAW_COMMAND ?? "openclaw",
    configPath = process.env.OPENCLAW_CONFIG_PATH,
    entry = process.env.NIGHTSHIFT_OPENCLAW_ENTRY,
    env = process.env,
    gatewayUrl = process.env.NIGHTSHIFT_GATEWAY_URL,
    runner = defaultRunner,
  } = {}) {
    this.board = board;
    this.command = command;
    this.configPath = configPath;
    this.entry = entry;
    this.env = env;
    this.gatewayUrl = gatewayUrl;
    this.runner = runner;
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
          nightshiftActionKey: action.idempotencyKey,
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
    return this.call("workboard.cards.dispatchWithOptions", {
      boardId: this.board,
      cardIds: scopedCardIds,
      maxStarts: Math.min(maxStarts, scopedCardIds.length),
    });
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
    const detail = String(error?.stderr ?? "").trim().slice(0, 2000);
    throw new Error(
      `OpenClaw Gateway RPC failed${error?.code ? ` (exit ${error.code})` : ""}${detail ? `: ${detail}` : ""}`,
    );
  }
}
