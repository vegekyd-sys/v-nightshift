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
    logBoardReads = process.env.NIGHTSHIFT_LOG_BOARD_READS === "1",
    // Card IDs to re-read after a failed Gateway mutation. Without it, recovery
    // falls back to listing the whole board.
    recoveryCardIds = null,
    // Cards per scoped cards.list request. Production cards average ~13 KB and
    // reach ~36 KB serialized, so 200 stays near 7 MiB at worst.
    readChunkSize = process.env.NIGHTSHIFT_BOARD_READ_CHUNK ?? 200,
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
    this.logBoardReads = Boolean(logBoardReads);
    this.recoveryCardIds = typeof recoveryCardIds === "function" ? recoveryCardIds : null;
    this.readChunkSize = readChunk(readChunkSize);
    this.runner = runner;
    this.startBurst = dispatchBurst(startBurst);
    this.startIntervalMs = dispatchInterval(startIntervalMs);
    this.startWindowAt = null;
    this.startsInWindow = 0;
    this.changeListeners = new Set();
    this.lifecycleListeners = new Set();
    this.rpcClient = null;
    this.rpcEventUnsubscribe = null;
    this.needsFullSnapshot = false;
  }

  async listCards({ cardIds } = {}) {
    const recovering = this.needsFullSnapshot;
    let ids = Array.isArray(cardIds) ? uniqueCardIds(cardIds) : null;
    if (recovering) {
      // A failed mutation can leave the cache stale for cards outside this
      // caller's scope, so recovery widens the read. It widens to the projects
      // the service can still act on, never to the whole board: production
      // carried 2,386 cards of which the archived majority is never scheduled,
      // and the failure that triggers recovery is usually a Gateway already
      // under load. Observed on V at 03:00 on 2026-09-17, where a cards.list
      // timeout was answered with a 2,386-card scan.
      const scope = this.recoveryCardIds?.();
      ids = Array.isArray(scope) ? uniqueCardIds([...(ids ?? []), ...scope]) : null;
    }
    if (ids?.length === 0) return [];
    const started = this.now();
    // A scoped read is still one response. The startup and recovery scope is
    // every card of every unarchived project, and on V on 2026-09-24 that one
    // response outgrew the Gateway client's 25 MiB frame limit: every pass
    // closed the socket with 1006 and the scheduler stood still for six hours.
    // Reading the scope in bounded requests keeps each frame small however many
    // projects a mature board holds.
    const chunks = ids ? chunk(ids, this.readChunkSize) : [null];
    const cards = [];
    for (const cardIds of chunks) {
      const result = await this.call("workboard.cards.list", { boardId: this.board, ...(cardIds ? { cardIds } : {}) });
      cards.push(...(result.cards ?? []));
    }
    if (recovering) this.needsFullSnapshot = false;
    // Every board read is an observable event so acceptance can prove that
    // no hot path lists the whole board.
    if (this.logBoardReads) {
      console.error(JSON.stringify({ event: "board.read", scope: ids ? "ids" : "board", requested: ids?.length ?? null, returned: cards.length, requests: chunks.length, ms: Math.round(this.now() - started), recovering }));
    }
    return cards;
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

  // The native board refuses to dispatch a card whose failureCount exceeds its
  // maxRetries, and releasing it does not clear the count. A retried card that
  // had already failed past that budget sat in ready, never started, and went
  // back to blocked on the next repair pass. Reassign is the board's own reset.
  async resetCardFailures(id, reason) {
    const result = await this.call("workboard.cards.reassign", {
      id,
      resetFailures: true,
      ...(reason ? { reason } : {}),
    });
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

  // How the Gateway says one run of a card's Session ended. The Workboard keeps
  // no reason for a blocked attempt; the Gateway's task registry does. Returns
  // null when the Gateway holds no entry for that run.
  async getRunOutcome({ sessionKey, runId }) {
    if (!sessionKey || !runId) return null;
    const result = await this.call("tasks.list", { sessionKey, limit: 20 });
    const task = (result?.tasks ?? []).find((entry) => entry?.runId === runId || entry?.sourceId === runId);
    if (!task) return null;
    return {
      status: task.status ?? null,
      error: task.error ?? null,
      endedAt: task.endedAt ?? null,
      startedAt: task.startedAt ?? null,
      updatedAt: task.updatedAt ?? null,
    };
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
    // Session slots are not the binding resource. The pool gives each Session a
    // whole Worker before it packs a second one into any process, so report the
    // Worker numbers too and let the guard reserve interactive room in the unit
    // the pool actually allocates.
    const workerCapacity = Number.isSafeInteger(status.maxWorkers) ? status.maxWorkers : undefined;
    const workersBusy = status.workers.filter((worker) => count(worker.assignedSessions ?? 0) > 0).length;
    return {latencyMs, workerPool: {
      capacity,
      active: status.workers.reduce((sum, worker) => sum + count(worker.activeCount), 0),
      queued: count(status.pending) + status.workers.reduce((sum, worker) => sum + count(worker.queued), 0),
      ...(workerCapacity === undefined ? {} : { workerCapacity, workersBusy }),
    }};
  }

  onChange(listener) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  // The Gateway going away and coming back: { type: "shutdown", reason,
  // restartExpectedMs } | { type: "disconnected" } | { type: "connected", bootId }.
  onGatewayLifecycle(listener) {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  get bootId() {
    return this.rpcClient?.bootId ?? null;
  }

  async connect() {
    if (this.runner) return;
    const client = await this.ensureRpcClient();
    await client.ensureConnected();
  }

  async call(method, params) {
    // A failed mutation can leave the local card cache stale, so both transports
    // mark the next read for recovery. Marking only the persistent client left
    // the CLI transport silently inconsistent.
    try {
      return await this.invoke(method, params);
    } catch (error) {
      if (MUTATION_METHOD.test(method)) this.needsFullSnapshot = true;
      throw error;
    }
  }

  async invoke(method, params) {
    if (!this.gatewayUrl) throw new Error("NIGHTSHIFT_GATEWAY_URL is required");
    if (!this.configPath) throw new Error("OPENCLAW_CONFIG_PATH is required");
    if (!this.runner) {
      const client = await this.ensureRpcClient();
      return await client.request(method, params);
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
      const lifecycle = gatewayLifecycle(event, client.bootId ?? null);
      if (lifecycle) {
        for (const listener of this.lifecycleListeners) {
          try {
            listener(lifecycle);
          } catch {
            // A lifecycle observer must not break the shared connection.
          }
        }
      }
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

function gatewayLifecycle(event, bootId = null) {
  const payload = event?.payload ?? {};
  if (event?.event === "shutdown") {
    return {
      type: "shutdown",
      reason: typeof payload.reason === "string" ? payload.reason : null,
      restartExpectedMs: Number.isFinite(payload.restartExpectedMs) ? payload.restartExpectedMs : null,
    };
  }
  if (event?.event === "gateway.suspension") {
    return payload.phase === "accepting" ? { type: "accepting", bootId } : { type: "suspended", phase: payload.phase ?? null };
  }
  if (event?.event === "nightshift.gateway.disconnected") return { type: "disconnected" };
  if (event?.event === "nightshift.gateway.connected" && payload.bootId) return { type: "connected", bootId: payload.bootId };
  return null;
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

const MUTATION_METHOD = /^workboard\.cards\.(create|dispatchWithOptions|complete|block|release|move|update|reassign)$/;

function readChunk(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_000) {
    throw new Error("readChunkSize must be an integer between 1 and 2000");
  }
  return parsed;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
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
