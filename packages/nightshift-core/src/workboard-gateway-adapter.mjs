import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class WorkboardGatewayAdapter {
  constructor({
    board = "nightshift",
    command = "openclaw",
    configPath = process.env.OPENCLAW_CONFIG_PATH,
    env = process.env,
    gatewayUrl = process.env.NIGHTSHIFT_GATEWAY_URL,
    runner = defaultRunner,
  } = {}) {
    this.board = board;
    this.command = command;
    this.configPath = configPath;
    this.env = env;
    this.gatewayUrl = gatewayUrl;
    this.runner = runner;
  }

  async listCards() {
    const result = await this.call("workboard.cards.list", { boardId: this.board });
    return result.cards ?? [];
  }

  async applyPlan(actions, { dryRun = false } = {}) {
    const results = [];
    for (const action of actions) results.push(await this.applyAction(action, { dryRun }));
    return results;
  }

  async applyAction(action, { dryRun = false } = {}) {
    if (action.type === "schedule_timer") {
      return { action, status: "deferred", reason: "timer_store_required" };
    }
    const marker = gatewayIdempotencyLabel(action.idempotencyKey);
    const existing = (await this.listCards()).find((card) =>
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

  async dispatch(maxStarts = 1) {
    return this.call("workboard.cards.dispatch", {
      boardId: this.board,
      maxStarts,
    });
  }

  async call(method, params) {
    if (!this.gatewayUrl) throw new Error("NIGHTSHIFT_GATEWAY_URL is required");
    if (!this.configPath) throw new Error("OPENCLAW_CONFIG_PATH is required");
    const config = JSON.parse(await readFile(this.configPath, "utf8"));
    const token = config.gateway?.auth?.token;
    if (!token) throw new Error("Gateway auth token is missing from the configured file");
    const args = [
      "gateway",
      "call",
      method,
      "--url",
      this.gatewayUrl,
      "--token",
      token,
      "--params",
      JSON.stringify(params),
      "--json",
      "--timeout",
      "10000",
    ];
    const output = await this.runner(this.command, args, this.env);
    return typeof output === "string" ? JSON.parse(output) : output;
  }
}

export function gatewayIdempotencyLabel(key) {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 20);
  return `nightshift-action:${digest}`;
}

function approvalCard(action) {
  return {
    title: `${action.instanceId}｜审批 ${action.stageId}`,
    status: "review",
    labels: [
      `instance:${action.instanceId}`,
      `stage:${action.stageId}`,
      "nightshift:approval",
    ],
    automation: { approval: action.approval },
  };
}

async function defaultRunner(command, args, env) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}
