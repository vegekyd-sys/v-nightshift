// The operator commands added for V on 2026-11-04, against a real Gateway:
// skipping an item blocks its card on the native board, a project's cards are
// read without the whole board, and a Workflow retires only once nothing
// unfinished uses it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ctlPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/nightshiftctl.mjs");

export async function runHttpScenario({ baseUrl, workboard }) {
  const call = async (method, url, body) => {
    const r = await fetch(`${baseUrl}/api${url}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ok = async (method, url, body) => {
    const r = await call(method, url, body);
    if (r.status >= 300) assert.fail(`${method} ${url}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const ctl = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [ctlPath, ...args], { env: { ...process.env, NIGHTSHIFT_URL: baseUrl } })).stdout);
  const steps = {};
  const flow = (stageTitle) => JSON.stringify({ apiVersion: "nightshift.versa.ai/v1alpha1", kind: "Workflow",
    metadata: { id: "operator-commands-fixture", version: "1.0.0", name: "operator-commands-fixture" },
    spec: { ownerAgentRole: "operator", contentItems: { routes: ["CHECK"], maxItems: 10 }, completion: { mode: "strict-v1" }, handoff: { version: 1 },
      stages: [{ id: "item-review", title: stageTitle, actor: "human", scope: "content-item", timeout: "1h" }] } });

  const release = await ok("POST", "/workflows/publish", { sourceYaml: flow("Item review") });
  const republish = await call("POST", "/workflows/publish", { sourceYaml: flow("Item review, changed") });
  assert.equal(republish.status, 409);
  assert.match(republish.body.error, /raise metadata\.version/);
  steps.republish = republish.status;

  const project = "NS-OPERATOR-COMMANDS-1104";
  await ok("POST", "/instances", { id: project, name: "Operator commands", workflowSha256: release.workflowSha256, inputs: {}, agentBindings: {}, status: "active", dispatch: false });
  await ok("PUT", `/instances/${project}/content-items`, { contentItems: [{ id: "keep", title: "Keep", route: "CHECK" }, { id: "drop", title: "Drop", route: "CHECK" }] });
  await ok("POST", `/instances/${project}/tick`, { dispatch: false });

  const scoped = await ok("GET", `/cards?project=${project}`);
  const itemCard = (id) => scoped.cards.find((card) => card.labels.includes(`content-item:${id}`));
  assert.ok(itemCard("keep") && itemCard("drop"), `both item cards on the board: ${JSON.stringify(scoped.cards.map((card) => [card.id, card.status]))}`);
  assert.ok(scoped.cards.every((card) => card.labels.includes(`instance:${project}`)), "only this project's cards");
  steps.scopedCards = scoped.cards.map((card) => card.status);

  const monitor = await ctl("projects", "monitor", project);
  assert.equal(monitor.tasks.length, scoped.cards.length);

  const skipped = await ctl("projects", "skip-item", project, "drop", "--reason", "duplicate", "--actor", "V");
  assert.deepEqual(skipped.blockedCardIds, [itemCard("drop").id]);
  const dropped = (await ok("GET", `/cards?project=${project}`)).cards.find((card) => card.id === itemCard("drop").id);
  assert.equal(dropped.status, "blocked", "the native board holds the skipped item's card");
  const kept = await ctl("cards", "get", itemCard("keep").id);
  assert.notEqual(kept.card.status, "blocked", "the other item is untouched");
  steps.skip = { dropped: dropped.status, kept: kept.card.status };

  assert.equal((await ctl("projects", "dispatch", project, "off", "--actor", "V")).automaticDispatch, false);
  assert.equal((await ctl("projects", "dispatch", project, "on", "--actor", "V")).automaticDispatch, true);

  const busy = await call("POST", "/workflows/retire", { workflow: "operator-commands-fixture", reason: "test", actor: "V" });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, new RegExp(project));
  steps.retireWhileUsed = busy.status;

  await ok("POST", `/instances/${project}/archive`, { actor: "V", reason: "operator commands acceptance" });
  const retired = await ctl("workflows", "retire", "operator-commands-fixture", "--reason", "测试用完", "--actor", "V");
  assert.equal(retired.retired.length, 1);
  assert.equal((await ctl("workflows", "list")).workflows.some((entry) => entry.workflowId === "operator-commands-fixture"), false);
  assert.ok((await ctl("workflows", "list", "--include-retired")).workflows.find((entry) => entry.workflowId === "operator-commands-fixture").retired);
  const refused = await call("POST", "/instances", { id: `${project}-2`, workflowSha256: release.workflowSha256, inputs: {}, agentBindings: {}, dispatch: false });
  assert.equal(refused.status, 409);
  const overview = await ok("GET", "/overview?scope=all");
  assert.ok(overview.workflows.find((entry) => entry.workflowSha256 === release.workflowSha256).retired, "the board learns it is retired");
  await ctl("workflows", "restore", "operator-commands-fixture", "--actor", "V");
  assert.equal((await ctl("workflows", "list")).workflows.some((entry) => entry.workflowId === "operator-commands-fixture"), true);
  steps.retire = { refusedNewProject: refused.status, restored: true };
  void workboard;
  return { ok: true, steps };
}
