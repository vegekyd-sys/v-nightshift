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

test("calls authorize-time-recovery passes explicit absolute deadlines, not a rolling timeout", async t => {
  let observed;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    observed = { url: req.url, body: JSON.parse(body) };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "time-permit" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const expected = "2030-01-01T01:00:00Z", until = "2030-01-01T01:30:00Z";
  await execFileAsync(process.execPath, ["scripts/nightshiftctl.mjs", "calls", "authorize-time-recovery", "call-id", "--expected-deadline", expected, "--until", until, "--reason", "repair", "--authorization", "existing scope", "--evidence", "readback", "--actor", "V"], { cwd: root, env: { ...process.env, NIGHTSHIFT_URL: `http://127.0.0.1:${server.address().port}` } });
  assert.equal(observed.url, "/api/calls/call-id/authorize-time-recovery");
  assert.equal(observed.body.expectedDeadline, Date.parse(expected));
  assert.equal(observed.body.deadline, Date.parse(until));
  assert.equal(observed.body.actor, "V");
});

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
