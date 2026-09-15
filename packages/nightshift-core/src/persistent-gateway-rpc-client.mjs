import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export class PersistentGatewayRpcClient {
  constructor({
    entry,
    env = process.env,
    gatewayUrl,
    requestTimeoutMs = 30_000,
    token,
    gatewayClientLoader = loadGatewayClient,
    deviceIdentityLoader = loadDeviceIdentity,
  } = {}) {
    if (!entry) throw new Error("NIGHTSHIFT_OPENCLAW_ENTRY is required for persistent Gateway RPC");
    if (!gatewayUrl) throw new Error("NIGHTSHIFT_GATEWAY_URL is required for persistent Gateway RPC");
    if (!token) throw new Error("Gateway auth token is required for persistent Gateway RPC");
    this.entry = entry;
    this.env = env;
    this.gatewayUrl = gatewayUrl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.token = token;
    this.gatewayClientLoader = gatewayClientLoader;
    this.deviceIdentityLoader = deviceIdentityLoader;
    this.client = null;
    this.connectPromise = null;
    this.connected = false;
    this.listeners = new Set();
    this.stopped = false;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(method, params) {
    const client = await this.ensureConnected();
    try {
      return await client.request(method, params, { timeoutMs: this.requestTimeoutMs });
    } catch (error) {
      // A disconnect may occur after a mutation committed. Retrying a create or
      // dispatch could launch twice; the scheduler reconciles authoritative state.
      if (!isDisconnectedError(error) || !READ_ONLY_METHODS.has(method)) throw error;
      this.connected = false;
      const reconnected = await this.ensureConnected();
      return reconnected.request(method, params, { timeoutMs: this.requestTimeoutMs });
    }
  }

  async ensureConnected() {
    if (this.stopped) throw new Error("Persistent Gateway RPC client is stopped");
    if (this.client && this.connected) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async connect() {
    if (!this.client) {
      const GatewayClient = await this.gatewayClientLoader(this.entry);
      const deviceIdentity = gatewayIsLoopback(this.gatewayUrl)
        ? null
        : await this.deviceIdentityLoader(this.env);
      let resolveReady;
      let rejectReady;
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const client = new GatewayClient({
        clientDisplayName: "Night Shift",
        deviceIdentity,
        env: this.env,
        mode: "backend",
        onClose: () => {
          this.connected = false;
        },
        onConnectError: (error) => {
          if (!this.connected) rejectReady(error);
        },
        onEvent: (event) => {
          for (const listener of this.listeners) {
            try {
              listener(event);
            } catch {
              // One consumer must not break the shared Gateway connection.
            }
          }
        },
        onHelloOk: () => {
          const reconnected = this.hasConnected === true;
          this.connected = true;
          this.hasConnected = true;
          resolveReady(client);
          if (reconnected) for (const listener of this.listeners) {
            try { listener({event: "nightshift.gateway.reconnected", payload: {}}); } catch {}
          }
        },
        requestTimeoutMs: this.requestTimeoutMs,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        token: this.token,
        url: this.gatewayUrl,
      });
      this.client = client;
      client.start();
      return withTimeout(ready, this.requestTimeoutMs, "Gateway persistent connection timeout");
    }

    return waitUntil(
      () => this.connected,
      this.requestTimeoutMs,
      "Gateway persistent reconnection timeout",
    ).then(() => this.client);
  }

  async close() {
    this.stopped = true;
    this.connected = false;
    const client = this.client;
    this.client = null;
    if (!client) return;
    if (typeof client.stopAndWait === "function") {
      await client.stopAndWait({ timeoutMs: 1_000 });
      return;
    }
    client.stop?.();
  }
}

export async function loadDeviceIdentity(env = process.env) {
  const stateDir = env.OPENCLAW_STATE_DIR;
  if (!stateDir) throw new Error("OPENCLAW_STATE_DIR is required for a non-loopback Gateway");
  const identityPath = join(stateDir, "identity", "device.json");
  let identity;
  try {
    identity = JSON.parse(await readFile(identityPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load the Gateway device identity from ${identityPath}: ${error.message}`);
  }
  for (const field of ["deviceId", "publicKeyPem", "privateKeyPem"]) {
    if (typeof identity[field] !== "string" || identity[field].length === 0) {
      throw new Error(`Gateway device identity is missing ${field}: ${identityPath}`);
    }
  }
  return identity;
}

export async function loadGatewayClient(entry) {
  const modulePath = join(dirname(entry), "plugin-sdk", "gateway-runtime.js");
  let runtime;
  try {
    runtime = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new Error(`Unable to load OpenClaw GatewayClient from ${modulePath}: ${error.message}`);
  }
  if (typeof runtime.GatewayClient !== "function") {
    throw new Error(`OpenClaw GatewayClient export is unavailable in ${modulePath}`);
  }
  return runtime.GatewayClient;
}

const READ_ONLY_METHODS = new Set([
  "workboard.cards.list", "workboard.cards.runs", "workboard.cards.stats",
  "workboard.notifications.list", "workboard.notifications.events",
  "sessions.list", "sessions.get", "skills.status",
]);

function gatewayIsLoopback(gatewayUrl) {
  const hostname = new URL(gatewayUrl).hostname;
  return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
}

function isDisconnectedError(error) {
  return /gateway not connected|socket closed|connection closed/i.test(String(error?.message ?? error));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
