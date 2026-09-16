import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class WorkboardCliAdapter {
  constructor({
    board = "nightshift",
    command = "openclaw",
    env = process.env,
    runner = defaultRunner,
  } = {}) {
    this.board = board;
    this.command = command;
    this.env = env;
    this.runner = runner;
  }

  async applyPlan(actions, { dryRun = false } = {}) {
    const results = [];
    for (const action of actions) {
      results.push(await this.applyAction(action, { dryRun }));
    }
    return results;
  }

  async applyAction(action, { dryRun = false } = {}) {
    if (action.type === "schedule_timer") {
      return {
        action,
        status: "deferred",
        reason: "timer_store_required",
      };
    }
    if (
      !["create_workboard_card", "create_review_card", "request_approval"].includes(
        action.type,
      )
    ) {
      throw new Error(`Unsupported Workboard action: ${action.type}`);
    }

    const marker = idempotencyLabel(action.idempotencyKey);
    const existing = await this.findByIdempotencyLabel(marker);
    if (existing) {
      return { action, card: existing, status: "reused" };
    }

    const card = action.card ?? approvalCard(action);
    const labels = [...new Set([...(card.labels ?? []), marker])];
    const notes = JSON.stringify(
      {
        nightshift: {
          actionType: action.type,
          automation: card.automation ?? null,
          idempotencyKey: action.idempotencyKey,
          instanceId: action.instanceId,
          stageId: action.stageId,
        },
      },
      null,
      2,
    );
    const args = [
      "workboard",
      "create",
      card.title,
      "--board",
      this.board,
      "--status",
      card.status ?? "ready",
      "--priority",
      card.priority ?? "normal",
      "--labels",
      labels.join(","),
      "--notes",
      notes,
      "--json",
    ];
    if (card.assignedAgent) args.push("--agent", card.assignedAgent);

    if (dryRun) {
      return {
        action,
        command: this.command,
        args: redactNotes(args),
        status: "planned",
      };
    }
    const output = await this.runner(this.command, args, this.env);
    return { action, card: parseJson(output), status: "created" };
  }

  async findByIdempotencyLabel(label) {
    const output = await this.runner(
      this.command,
      ["workboard", "list", "--board", this.board, "--include-archived", "--json"],
      this.env,
    );
    const parsed = parseJson(output);
    const cards = Array.isArray(parsed) ? parsed : parsed.cards ?? parsed.items ?? [];
    return cards.find((card) => labelsOf(card).includes(label)) ?? null;
  }
}

export function idempotencyLabel(key) {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 20);
  return `nightshift-action:${digest}`;
}

function approvalCard(action) {
  return {
    title: `${action.instanceId}｜${action.contentItemId ? `${action.contentItemId}｜` : ""}审批 ${action.stageId}`,
    status: "review",
    assignedAgent: null,
    labels: [
      `instance:${action.instanceId}`,
      `stage:${action.stageId}`,
      ...(action.contentItemId ? [`content-item:${action.contentItemId}`] : []),
      "nightshift:approval",
    ],
    automation: {
      approval: action.approval,
      instanceId: action.instanceId,
      stageId: action.stageId,
      contentItemId: action.contentItemId ?? null,
    },
  };
}

function labelsOf(card) {
  if (Array.isArray(card.labels)) return card.labels;
  if (Array.isArray(card.labelNames)) return card.labelNames;
  if (typeof card.labels === "string") return card.labels.split(",");
  return [];
}

function parseJson(output) {
  if (typeof output !== "string") return output;
  const trimmed = output.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

async function defaultRunner(command, args, env) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function redactNotes(args) {
  const copy = [...args];
  const notesIndex = copy.indexOf("--notes");
  if (notesIndex >= 0) copy[notesIndex + 1] = "<nightshift-metadata>";
  return copy;
}
