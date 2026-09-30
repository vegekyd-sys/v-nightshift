import assert from "node:assert/strict";
import test from "node:test";
import { PersistentGatewayRpcClient } from "../src/persistent-gateway-rpc-client.mjs";

test("reuses one Gateway client for RPC and forwards Workboard change events", async () => {
  const requests = [];
  let constructed = 0;
  let clientOptions;
  class FakeGatewayClient {
    constructor(options) {
      constructed += 1;
      clientOptions = options;
    }
    start() {
      queueMicrotask(() => clientOptions.onHelloOk({}));
    }
    async request(method, params) {
      requests.push({ method, params });
      return { ok: true };
    }
    async stopAndWait() {}
  }
  const client = new PersistentGatewayRpcClient({
    entry: "/opt/openclaw/dist/index.js",
    gatewayClientLoader: async () => FakeGatewayClient,
    gatewayUrl: "ws://127.0.0.1:22793",
    token: "not-printed",
  });
  const events = [];
  client.onEvent((event) => events.push(event));

  await client.request("workboard.cards.list", { boardId: "nightshift" });
  await client.request("workboard.cards.list", { boardId: "nightshift" });
  clientOptions.onEvent({ event: "workboard.changed", payload: { revision: 2 } });

  assert.equal(constructed, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(events.filter((event) => !event.event.startsWith("nightshift.gateway.")), [{ event: "workboard.changed", payload: { revision: 2 } }]);
  await client.close();
});


test("does not replay an ambiguous mutation after a socket disconnect", async () => {
  let options, calls = 0;
  class Fake {
    constructor(o) { options = o; }
    start() { queueMicrotask(() => options.onHelloOk({})); }
    async request() { calls++; throw new Error("socket closed after commit"); }
    stop() {}
  }
  const client = new PersistentGatewayRpcClient({entry: "/opt/dist/index.js", gatewayUrl: "ws://localhost:1", token: "test", gatewayClientLoader: async () => Fake});
  await assert.rejects(client.request("workboard.cards.create", {}), /socket closed/);
  assert.equal(calls, 1);
  await client.close();
});

test("reports the Gateway going away and which Gateway process it came back as", async () => {
  let options;
  class Fake {
    constructor(o) { options = o; }
    start() { queueMicrotask(() => options.onHelloOk({ server: { bootId: "boot-a" } })); }
    async request() { return { ok: true }; }
    async stopAndWait() { options.onClose?.(); }
  }
  const client = new PersistentGatewayRpcClient({entry: "/opt/dist/index.js", gatewayUrl: "ws://localhost:1", token: "test", gatewayClientLoader: async () => Fake});
  const events = [];
  client.onEvent((event) => events.push(event));
  await client.request("workboard.cards.list", {});
  assert.equal(client.bootId, "boot-a");
  options.onEvent({ event: "shutdown", payload: { reason: "gateway restarting", restartExpectedMs: 1500 } });
  options.onClose();
  options.onHelloOk({ server: { bootId: "boot-b" } });
  assert.deepEqual(events.map((event) => [event.event, event.payload?.bootId ?? event.payload?.reason]), [
    ["nightshift.gateway.connected", "boot-a"],
    ["shutdown", "gateway restarting"],
    ["nightshift.gateway.disconnected", "boot-a"],
    ["nightshift.gateway.connected", "boot-b"],
    ["nightshift.gateway.reconnected", "boot-b"],
  ]);
  events.length = 0;
  await client.close();
  assert.deepEqual(events, [], "closing our own connection is not the Gateway going away");
});
