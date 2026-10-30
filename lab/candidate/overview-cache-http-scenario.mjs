// The overview is served from its cache only while nothing it reads changed:
// a project write, a card move, or a forced refresh must rebuild it.
import assert from "node:assert/strict";

export async function runHttpScenario({ baseUrl, workboard }) {
  async function overview(query = "") {
    const r = await fetch(`${baseUrl}/api/overview?scope=all${query}`);
    assert.equal(r.status, 200);
    return { timing: r.headers.get("server-timing"), body: await r.json() };
  }
  async function post(url, body) {
    const r = await fetch(`${baseUrl}/api${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status >= 300) assert.fail(`${url}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  }
  const steps = [];
  const built = (o) => /desc="built"/.test(o.timing);
  const cached = (o) => /desc="cached"/.test(o.timing);
  let first = await overview();
  first = await overview();
  const repeat = await overview();
  assert(cached(repeat), `an unchanged board is served from the cache: ${repeat.timing}`);
  assert.deepEqual(repeat.body, first.body);
  steps.push({ unchanged: repeat.timing });

  const flow = JSON.stringify({ apiVersion: "nightshift.versa.ai/v1alpha1", kind: "Workflow", metadata: { id: "overview-cache-fixture", version: "1.0.0", name: "overview-cache-fixture" }, spec: { ownerAgentRole: "operator", completion: { mode: "strict-v1" }, handoff: { version: 1 }, stages: [{ id: "review", title: "Synthetic review", actor: "human", timeout: "1h" }] } });
  const release = await post("/workflows/publish", { sourceYaml: flow });
  await post("/instances", { id: "NS-OVERVIEW-CACHE-1030", name: "Overview cache acceptance", workflowSha256: release.workflowSha256, inputs: {}, agentBindings: {}, status: "active", dispatch: false });
  const afterCreate = await overview();
  assert(built(afterCreate), `a new project rebuilds: ${afterCreate.timing}`);
  assert(afterCreate.body.instances.some((instance) => instance.id === "NS-OVERVIEW-CACHE-1030"));
  steps.push({ projectCreated: afterCreate.timing });

  await post("/instances/NS-OVERVIEW-CACHE-1030/tick", { dispatch: false });
  const afterTick = await overview("&refresh=1");
  const cardId = afterTick.body.instances.find((instance) => instance.id === "NS-OVERVIEW-CACHE-1030").stageRuns[0]?.cardId;
  assert(cardId, "the tick created the review card");
  const before = afterTick.body.cards.find((card) => card.id === cardId);
  assert(before, "the forced refresh read the new card");
  const cachedAgain = await overview();
  assert(cached(cachedAgain), `cached until something changes: ${cachedAgain.timing}`);

  const title = `${before.title} (renamed)`;
  await workboard.updateCard(cardId, { title });
  const moved = await overview("&refresh=1");
  assert(built(moved), `a forced refresh always rebuilds: ${moved.timing}`);
  assert.equal(moved.body.cards.find((card) => card.id === cardId).title, title);
  assert.notEqual(moved.body.cardsUpdatedAt, cachedAgain.body.cardsUpdatedAt, "a changed card advances cardsUpdatedAt");
  const afterMove = await overview();
  assert(cached(afterMove), `the rebuilt body is reused: ${afterMove.timing}`);
  assert.equal(afterMove.body.cards.find((card) => card.id === cardId).title, title);
  steps.push({ cardMoved: moved.timing, reused: afterMove.timing });

  const timing = await fetch(`${baseUrl}/api/client-timing`, { method: "POST", body: JSON.stringify({ freshPaint: 812, htmlTtfb: 120, view: "workflows", phone: true }) });
  assert.equal(timing.status, 204);
  const bad = await fetch(`${baseUrl}/api/client-timing`, { method: "POST", body: JSON.stringify({ htmlTtfb: 1 }) });
  assert.equal(bad.status, 400);
  steps.push({ clientTiming: [timing.status, bad.status] });
  return { ok: true, steps };
}
