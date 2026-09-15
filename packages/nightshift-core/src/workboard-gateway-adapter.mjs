import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { nativeActionKey } from "./orchestrator.mjs";
import { PersistentGatewayRpcClient } from "./persistent-gateway-rpc-client.mjs";

export class WorkboardGatewayAdapter {
  constructor({
    board = "nightshift",
    command = process.env.NIGHTSHIFT_OPENCLAW_COMMAND ?? "openclaw",
    configPath = process.env.OPENCLAW_CONFIG_PATH,
    entry = process.env.NIGHTSHIFT_OPENCLAW_ENTRY,
    env = process.env,
    gatewayUrl = process.env.NIGHTSHIFT_GATEWAY_URL,
    now = Date.now,
    rpcClientFactory = (options) => new PersistentGatewayRpcClient(options),
    rpcTimeoutMs = process.env.NIGHTSHIFT_GATEWAY_RPC_TIMEOUT_MS ?? 30_000,
    runner,
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
    this.rpcClientFactory = rpcClientFactory;
    this.rpcTimeoutMs = positiveTimeout(rpcTimeoutMs);
    this.runner = runner;
    this.startBurst = dispatchBurst(startBurst);
    this.startIntervalMs = dispatchInterval(startIntervalMs);
    this.startWindowAt = null;
    this.startsInWindow = 0;
    this.changeListeners = new Set();
    this.rpcClient = null;
    this.rpcEventUnsubscribe = null;
    this.needsFullSnapshot = false;
  }

  async listCards({ cardIds } = {}) {
    const recovering = this.needsFullSnapshot;
    const ids = !recovering && Array.isArray(cardIds) ? uniqueCardIds(cardIds) : null;
    if (ids?.length === 0) return [];
    const result = await this.call("workboard.cards.list", { boardId: this.board, ...(ids ? { cardIds: ids } : {}) });
    if (recovering) this.needsFullSnapshot = false;
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
      boardId: this.board,
      title: card.title,
      status: card.status ?? "ready",
      priority: card.priority ?? "normal",
      agentId: card.assignedAgent ?? undefined,
      labels: [...new Set([...(card.labels ?? []), marker])],
      maxRetries: card.automation?.maxAttempts ?? undefined,
      maxRuntimeSeconds: card.automation?.maxRuntimeSeconds ?? undefined,
      notes: card.notes ?? null,
      parents: card.parents ?? undefined,
      scheduledAt: card.scheduledAt ?? undefined,
      skills: card.automation?.skills ?? undefined,
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

  async releaseCard(id, status) {
    const result = await this.call("workboard.cards.release", { id, status });
    return result.card;
  }

  async dispatch(maxStarts = 1, { cardIds } = {}) {
    const scopedCardIds = uniqueCardIds(cardIds);
    if (scopedCardIds.length === 0) {
      throw new Error("Night Shift dispatch requires an explicit non-empty card scope");
    }
    if (!Number.isSafeInteger(maxStarts) || maxStarts < 1) throw new Error("maxStarts must be a positive integer");
    const budget = this.reserveStartBudget(Math.min(maxStarts, scopedCardIds.length));
    if (budget.starts === 0) {
      return { deferred: true, retryAfterMs: budget.retryAfterMs, started: [], startFailures: [] };
    }
    // One scoped native dispatch lets Workboard own dependency, claim, Attempt,
    // Session and same-owner concurrency decisions. It also avoids one Gateway
    // round trip and one serialized sleep per card.
    const result = await this.call("workboard.cards.dispatchWithOptions", {
      boardId: this.board,
      cardIds: scopedCardIds,
      maxStarts: budget.starts,
    });
    const allowed = new Set(scopedCardIds);
    for (const entry of result.started ?? []) {
      if (!allowed.has(entry.cardId) || !entry.sessionKey || !entry.runId) {
        throw new Error("Native scoped dispatch returned a card outside the requested scope or missing Session evidence");
      }
    }
    return {
      ...result,
      deferred: false,
      retryAfterMs: null,
      started: result.started ?? [],
      startFailures: result.startFailures ?? [],
    };
  }

  reserveStartBudget(requested) {
    const current = this.now();
    if (this.startWindowAt === null || current >= this.startWindowAt + this.startIntervalMs) {
      this.startWindowAt = current;
      this.startsInWindow = 0;
    }
    const available = Math.max(0, this.startBurst - this.startsInWindow);
    const starts = Math.min(requested, available);
    this.startsInWindow += starts;
    return {
      starts,
      retryAfterMs: starts > 0 ? null : Math.max(0, this.startWindowAt + this.startIntervalMs - current),
    };
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

  async probeGatewayLatency() {
    return (await this.probeGatewayCapacity()).latencyMs;
  }

  async probeGatewayCapacity() {
    // Probe the admission path without enumerating historical Sessions. A list
    // limit caps the response, not the cost of loading and merging the stores.
    // This RPC still waits on the shared Gateway event loop and validates the
    // live Worker occupancy, so overload and queued foreground work fail closed.
    const started = this.now();
    const status = await this.call("vlab.workers.status", {});
    const latencyMs = Math.max(0, this.now() - started);
    const capacity = status.maxActiveSessions;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Array.isArray(status.workers)) throw new Error("Worker pool capacity is unavailable");
    const count = value => {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Worker pool occupancy is unavailable");
      return value;
    };
    return {latencyMs, workerPool: {
      capacity,
      active: status.workers.reduce((sum, worker) => sum + count(worker.activeCount), 0),
      queued: count(status.pending) + status.workers.reduce((sum, worker) => sum + count(worker.queued), 0),
    }};
  }

  onChange(listener) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async connect() {
    if (this.runner) return;
    const client = await this.ensureRpcClient();
    await client.ensureConnected();
  }

  async call(method, params) {
    if (!this.gatewayUrl) throw new Error("NIGHTSHIFT_GATEWAY_URL is required");
    if (!this.configPath) throw new Error("OPENCLAW_CONFIG_PATH is required");
    if (!this.runner) {
      const client = await this.ensureRpcClient();
      try { return await client.request(method, params); }
      catch (error) {
        if (/^workboard\.cards\.(create|dispatchWithOptions|complete|block|release|move|update)$/.test(method)) this.needsFullSnapshot = true;
        throw error;
      }
    }
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
      String(this.rpcTimeoutMs),
    ];
    const output = await this.runner(this.command, args, {
      ...this.env,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_URL: this.gatewayUrl,
    });
    return typeof output === "string" ? JSON.parse(output) : output;
  }

  async ensureRpcClient(token = null) {
    if (this.rpcClient) return this.rpcClient;
    if (!this.rpcClientPromise) this.rpcClientPromise = this.createRpcClient(token).finally(() => { this.rpcClientPromise = null; });
    return this.rpcClientPromise;
  }

  async createRpcClient(token) {
    let resolvedToken = token;
    if (!resolvedToken) {
      if (!this.configPath) throw new Error("OPENCLAW_CONFIG_PATH is required");
      const config = JSON.parse(await readFile(this.configPath, "utf8"));
      resolvedToken = config.gateway?.auth?.token;
    }
    if (!resolvedToken) throw new Error("Gateway auth token is missing from the configured file");
    const gateway = new URL(this.gatewayUrl);
    if (!gatewayEndpointIsPrivate(gateway)) {
      throw new Error("Night Shift Workboard Gateway must use loopback, Tailscale, or secure WebSocket transport");
    }
    const client = this.rpcClientFactory({
      entry: this.entry,
      env: this.env,
      gatewayUrl: this.gatewayUrl,
      requestTimeoutMs: this.rpcTimeoutMs,
      token: resolvedToken,
    });
    this.rpcEventUnsubscribe = client.onEvent((event) => {
      if (event?.event !== "plugin.workboard.changed" && event?.event !== "nightshift.gateway.reconnected") return;
      if (event.event === "nightshift.gateway.reconnected") this.needsFullSnapshot = true;
      for (const listener of this.changeListeners) {
        try {
          listener(event.payload ?? {});
        } catch {
          // A scheduling observer must not break the shared connection.
        }
      }
    });
    this.rpcClient = client;
    return client;
  }

  get connected() {
    return this.runner ? true : this.rpcClient?.connected === true;
  }

  async close() {
    this.rpcEventUnsubscribe?.();
    this.rpcEventUnsubscribe = null;
    await this.rpcClient?.close?.();
    this.rpcClient = null;
  }
}

function gatewayEndpointIsPrivate(gateway) {
  if (gateway.protocol === "wss:") return true;
  if (["127.0.0.1", "localhost", "[::1]"].includes(gateway.hostname)) return true;
  const octets = gateway.hostname.split(".").map(Number);
  return gateway.protocol === "ws:"
    && octets.length === 4
    && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 100
    && octets[1] >= 64
    && octets[1] <= 127;
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

function positiveTimeout(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error("rpcTimeoutMs must be an integer between 1000 and 120000");
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

export function gatewayRpcFailureDetail(error, token) {
  let detail = String(error?.stderr ?? "").trim();
  try {
    const payload = JSON.parse(String(error?.stdout ?? ""));
    if (payload.ok === false && typeof payload.error?.message === "string") detail = payload.error.message;
  } catch { /* Older CLI versions report errors on stderr. */ }
  if (typeof token === "string" && token) detail = detail.replaceAll(token, "[redacted]");
  return detail.slice(0, 2000);
}
