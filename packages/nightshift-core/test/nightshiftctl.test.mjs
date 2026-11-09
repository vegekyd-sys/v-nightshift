import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

test("operations authorize-recovery sends a bounded explicit request to the official card endpoint", async t => {
  let observed;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    observed = { url: req.url, method: req.method, body: JSON.parse(body) };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "one-permit", additionalOperations: 1 }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { stdout } = await execFileAsync(process.execPath, ["scripts/nightshiftctl.mjs", "operations", "authorize-recovery", "retry-card", "--failed-operation", "failed-key", "--request-hash", "b".repeat(64), "--reason", "fix shape", "--authorization", "existing budget approval", "--evidence", "supplier response", "--actor", "V"], { cwd: root, env: { ...process.env, NIGHTSHIFT_URL: `http://127.0.0.1:${server.address().port}` } });
  assert.equal(JSON.parse(stdout).additionalOperations, 1);
  assert.equal(observed.url, "/api/cards/retry-card/operations/authorize-recovery");
  assert.equal(observed.body.failedOperationKey, "failed-key");
  assert.equal(observed.body.actor, "V");
  assert.equal(observed.body.authorization, "existing budget approval");
});

// nightshiftctl is an HTTP client of the Night Shift service. Operators and
// agents parse its output, so stderr must stay empty on success. It used to
// load the SQLite store through the package index and print Node's
// "SQLite is an experimental feature" warning on every run.
test("nightshiftctl prints only the API result, with no runtime warning on stderr", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/api/health" ? { ok: true, schedulerRunning: true } : { error: "not found" }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const { NODE_OPTIONS, NODE_NO_WARNINGS, ...env } = process.env;
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/nightshiftctl.mjs", "health"], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, NIGHTSHIFT_URL: `http://127.0.0.1:${server.address().port}` },
    });
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { ok: true, schedulerRunning: true });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

// V, 2026-11-09: an agent's exec environment carries the Gateway's egress proxy
// (HTTP_PROXY/HTTPS_PROXY with NODE_USE_ENV_PROXY=1, and OpenClaw clears
// NO_PROXY on purpose). Node's fetch then sent every call to the loopback engine
// through the proxy, which refuses loopback: every Night Shift card's
// `operations reserve` printed "fetch failed". Agents went looking for the right
// NIGHTSHIFT_URL with `grep -r` over ~/.openclaw (37 GB read, Gateway stalls).
test("nightshiftctl reaches a loopback engine even when the environment routes HTTP through a proxy", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/api/health" ? { ok: true } : { error: "not found" }));
  });
  // A proxy that refuses everything, like the egress proxy does for loopback targets.
  const proxied = [];
  const proxy = createServer((request, response) => { proxied.push(request.url); response.statusCode = 403; response.end("loopback denied"); });
  proxy.on("connect", (request, socket) => { proxied.push(request.url); socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
  await Promise.all([server, proxy].map((s) => new Promise((resolveListen) => s.listen(0, "127.0.0.1", resolveListen))));
  try {
    const { NODE_OPTIONS, NODE_NO_WARNINGS, NO_PROXY, no_proxy, ...env } = process.env;
    const proxyUrl = `http://user:pass@127.0.0.1:${proxy.address().port}`;
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/nightshiftctl.mjs", "health"], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, NIGHTSHIFT_URL: `http://127.0.0.1:${server.address().port}`, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, NODE_USE_ENV_PROXY: "1" },
    });
    assert.deepEqual(JSON.parse(stdout), { ok: true });
    assert.deepEqual(proxied, [], "the loopback call went through the proxy");
    assert.equal(stderr, "");
  } finally {
    await Promise.all([server, proxy].map((s) => new Promise((resolveClose) => s.close(resolveClose))));
  }
});

// V reports progress from `projects monitor`. A card a fresh attempt replaced
// stays blocked on the native board; counting it as blocked told V five videos
// were stuck in a project that had delivered all 24 (DL-1009-02, 2026-10-10).
test("projects monitor does not count a replaced card as blocked", async () => {
  const project = {
    id: "DL-1009-02",
    stageRuns: [],
    contentItemRuns: [
      { stageId: "produce", contentItemId: "pt-01", attempt: 1, cardId: "old-01", status: "blocked" },
      { stageId: "produce", contentItemId: "pt-01", attempt: 2, cardId: "new-01", status: "done" },
      { stageId: "produce", contentItemId: "pt-02", attempt: 1, cardId: "stuck-02", status: "blocked" },
    ],
  };
  const card = (id, status, item) => ({ id, status, labels: ["instance:DL-1009-02", "stage:produce", `content-item:${item}`] });
  const cards = [card("old-01", "blocked", "pt-01"), card("new-01", "done", "pt-01"), card("stuck-02", "blocked", "pt-02")];
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/api/instances/DL-1009-02")) return response.end(JSON.stringify(project));
    if (request.url.startsWith("/api/cards")) return response.end(JSON.stringify({ cards }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/nightshiftctl.mjs", "projects", "monitor", "DL-1009-02"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NIGHTSHIFT_URL: `http://127.0.0.1:${server.address().port}` },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.summary.blocked, 1, "only pt-02 is stuck");
    assert.equal(result.summary.superseded, 1);
    assert.equal(result.tasks.find((task) => task.cardId === "old-01").superseded, true);
    assert.equal(result.tasks.find((task) => task.cardId === "stuck-02").superseded, false);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("projects monitor includes linked call contexts without unrelated business projects", async () => {
  const project = { id: "ROOT", stageRuns: [], calls: [{ childId: "WFC-a" }, { childId: "WFC-b" }] };
  const card = (id, instance, status) => ({ id, status, labels: [`instance:${instance}`, "stage:verify"] });
  const cards = [card("controller", "ROOT", "review"), card("first", "WFC-a", "done"), card("second", "WFC-b", "running"), card("private-other", "OTHER", "running")];
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url.startsWith("/api/cards") ? { cards } : project));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/nightshiftctl.mjs", "projects", "monitor", "ROOT"], { cwd: root, env: { ...process.env, NIGHTSHIFT_URL: `http://127.0.0.1:${server.address().port}` } });
    const result = JSON.parse(stdout);
    assert.equal(result.tasks.length, 3);
    assert.equal(result.summary.active, 1);
    assert.equal(result.tasks.find(task => task.cardId === "second").executionInstanceId, "WFC-b");
    assert.equal(result.tasks.some(task => task.cardId === "private-other"), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// Every Live Board operation has a command, and V's commands read one project
// or one card instead of the whole board (about 250 MB on V, 2026-11-04).
test("the new commands call their endpoints and read only what they need", async (t) => {
  const seen = [];
  const card = { id: "c1", status: "review", labels: ["instance:P1", "stage:review", "content-item:i1"], metadata: { automation: { instanceId: "P1" } } };
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    seen.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null });
    if (request.url.startsWith("/api/instances/P1/artifacts/")) {
      response.setHeader("content-type", "video/mp4");
      return response.end(Buffer.alloc(16));
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/cards/c1") return response.end(JSON.stringify({ card }));
    if (request.url.startsWith("/api/workflows?")) return response.end(JSON.stringify({ workflows: [
      { workflowId: "wf", version: "2.0.0", workflowSha256: "b".repeat(64) },
      { workflowId: "wf", version: "1.0.0", workflowSha256: "a".repeat(64), retired: { reason: "old" } },
    ] }));
    if (request.url.endsWith("/source")) return response.end(JSON.stringify({ sourceMarkdown: "# wf" }));
    response.end(JSON.stringify({ ok: true, cards: [] }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const ctl = (...args) => execFileAsync(process.execPath, ["scripts/nightshiftctl.mjs", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, NIGHTSHIFT_URL: `http://127.0.0.1:${server.address().port}` } });
  const last = () => seen.at(-1);

  await ctl("workflows", "retire", "wf@1.0.0", "--reason", "测试用完", "--actor", "V");
  assert.deepEqual(last(), { method: "POST", url: "/api/workflows/retire", body: { workflow: "wf@1.0.0", reason: "测试用完", actor: "V" } });
  await ctl("workflows", "restore", "wf", "--actor", "V");
  assert.equal(last().url, "/api/workflows/restore");
  assert.match(JSON.parse((await ctl("workflows", "source", "wf")).stdout).sourceMarkdown, /# wf/);
  assert.equal(last().url, `/api/workflows/${"b".repeat(64)}/source`, "an id means its newest release");
  await ctl("projects", "dispatch", "P1", "off", "--actor", "V");
  assert.deepEqual(last(), { method: "POST", url: "/api/instances/P1/dispatch-control", body: { automaticDispatch: false, actor: "V" } });
  await ctl("projects", "retry-dispatch", "P1", "--actor", "V");
  assert.equal(last().url, "/api/instances/P1/retry-dispatch");
  await ctl("projects", "tick", "P1", "--dispatch");
  assert.deepEqual(last().body, { dispatch: true, dryRun: false });
  await ctl("projects", "handoff", "P1", "review", "--item", "i1");
  assert.equal(last().url, "/api/instances/P1/stages/review/handoff?contentItemId=i1");
  await ctl("projects", "deliverables", "P1", "--item", "i1");
  assert.equal(last().url, "/api/instances/P1/content-items/i1/deliverables");
  await assert.rejects(ctl("projects", "artifact", "P1", "final/a.mp4"), /save it with --out/);

  seen.length = 0;
  await ctl("projects", "monitor", "P1");
  assert.ok(seen.some((entry) => entry.url === "/api/cards?project=P1"));
  assert.ok(seen.every((entry) => !entry.url.includes("refresh=1")), "no whole-board read");
  seen.length = 0;
  await ctl("cards", "takeover", "c1", "--reason", "手动做", "--actor", "V");
  assert.deepEqual(seen.map((entry) => entry.url), ["/api/cards/c1", "/api/instances/P1/cards/c1/human-takeover"]);
  await ctl("cards", "approve", "c1", "--evidence", "看过了", "--actor", "V");
  assert.ok(seen.every((entry) => !entry.url.startsWith("/api/cards?")), "a card decision reads that card only");
  await ctl("cards", "approve-all", "c1", "c2", "--evidence", "看过了", "--actor", "V");
  assert.deepEqual(last(), { method: "POST", url: "/api/cards/bulk/approve", body: { cardIds: ["c1", "c2"], evidence: "看过了", actor: "V" } });
});
