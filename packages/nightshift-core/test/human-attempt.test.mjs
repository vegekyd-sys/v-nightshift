import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NightShiftRuntime, NightShiftStore } from "../src/index.mjs";
import { HumanAttemptController, humanCompletionEvidence, evidenceHash } from "../src/human-attempt.mjs";
import { validateDeclaredCompletion } from "../src/completion.mjs";
import { handoffManifestExample, normalizeStageHandoff } from "../src/handoff.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nightshift-human-"));
  const store = new NightShiftStore(join(root, "state.sqlite"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const cards = [];
  let failClaimResponse = false;
  let failCompleteResponse = false;
  const workboard = {
    listCards: async () => structuredClone(cards),
    applyPlan: async (actions) => actions.map((action) => {
      const card = { ...action.card, id: `card-${cards.length}` };
      cards.push(card);
      return { action, card, status: "created" };
    }),
    moveCard: async (id, status) => Object.assign(cards.find((card) => card.id === id), { status }),
    call: async (method, params) => {
      assert.equal(method, "workboard.cards.claim");
      const card = cards.find((entry) => entry.id === params.id);
      if (card.status !== "ready" || card.metadata?.claim) throw new Error("already claimed");
      card.status = "running";
      card.metadata = { ...card.metadata, claim: { ownerId: params.ownerId } };
      if (failClaimResponse) { failClaimResponse = false; throw new Error("Lost claim response"); }
      return { card, token: params.token };
    },
    completeCard: async (id, input) => {
      const card = cards.find((entry) => entry.id === id);
      assert.equal(input.ownerId, card.metadata.claim.ownerId);
      card.status = "done";
      delete card.metadata.claim;
      if (failCompleteResponse) { failCompleteResponse = false; throw new Error("Lost completion response"); }
      return card;
    },
  };
  const validateCompletion = async (context) => {
    const human = humanCompletionEvidence({ ...context, store });
    if (!human) throw new Error("Missing native Session");
    const manifest = normalizeStageHandoff(JSON.parse(await readFile(join(root, "handoff.json"), "utf8")), {
      instanceId: context.instance.id, release: context.release, stageId: context.stageId,
    });
    const output = await validateDeclaredCompletion({ manifest,
      stage: context.release.spec.stages.find((stage) => stage.id === context.stageId),
      checkUrl: async () => true,
      loadArtifact: async (path) => ({ exists: true, json: JSON.parse(await readFile(join(root, path), "utf8")) }),
    });
    const evidence = { human, manifest, output };
    const saved = store.getHumanAttempt(context.card.id);
    if (saved.evidenceSha256 && saved.evidenceSha256 !== evidenceHash(evidence)) throw new Error("Evidence changed");
    return evidence;
  };
  const runtime = new NightShiftRuntime({ store, workboard, completionValidator: validateCompletion });
  const source = await readFile(new URL("../../../examples/workflows/xingqing-content-delivery.workflow.md", import.meta.url), "utf8");
  const release = runtime.publish(source);
  runtime.startInstance({ id: "A", workflowSha256: release.workflowSha256, agentBindings: { "content-operator": "main" },
    contentItems: [{ id: "one", title: "One", route: "AI_GENERATE" }] });
  await runtime.tick("A");
  const cardId = cards[0].id;
  cards.push({ id: "other", status: "ready", labels: ["instance:B", "stage:plan"], metadata: { attempts: [] } });
  const sentinel = structuredClone(cards[1]);
  const controller = new HumanAttemptController({ store, workboard, validateCompletion });
  const input = { instanceId: "A", cardId, actor: "operator", reason: "Native dispatch unavailable" };
  const writeOutputs = async () => {
    const manifest = handoffManifestExample({ instanceId: "A", release: release.manifest, stageId: "plan" });
    for (const output of manifest.outputs) output.artifact = output.name === "planUrl" ? "https://example.test/plan" : `${output.name}.json`;
    await writeFile(join(root, "handoff.json"), JSON.stringify(manifest));
    await writeFile(join(root, "requirementSnapshot.json"), JSON.stringify({ traceable: true }));
    await writeFile(join(root, "contentItemsManifest.json"), JSON.stringify({ items: [{ id: "one", title: "One" }] }));
  };
  return { root, store, cards, sentinel, runtime, controller, input, writeOutputs,
    loseClaimResponse: () => { failClaimResponse = true; }, loseCompleteResponse: () => { failCompleteResponse = true; } };
}

test("controlled human takeover preserves card identity, validates real handoff files and creates only scoped downstream", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.controller.takeover(f.input), /Disable/);
  f.store.setInstanceControl("A", { automaticDispatch: false });
  const attempt = await f.controller.takeover(f.input);
  assert.equal(attempt.token, undefined);
  assert.equal(f.cards[0].sessionKey, undefined);
  await assert.rejects(f.controller.complete(f.input), /ENOENT/);
  assert.equal(f.cards[0].status, "running");
  await f.writeOutputs();
  await f.controller.complete(f.input);
  await f.runtime.tick("A", { dispatch: true });
  assert.equal(f.cards[0].status, "done");
  assert.equal(f.store.getHumanAttempt(f.input.cardId).status, "done");
  assert.equal(f.cards.filter((card) => card.labels.includes("stage:route")).length, 1);
  assert.deepEqual(f.cards.find((card) => card.id === "other"), f.sentinel);
  assert.ok(!JSON.stringify(f.store.listEvents("A")).includes(f.store.getHumanAttempt(f.input.cardId).token));
});

test("lost claim and completion responses can be retried without another card or execution", async (t) => {
  const f = await fixture(t);
  f.store.setInstanceControl("A", { automaticDispatch: false });
  f.loseClaimResponse();
  await assert.rejects(f.controller.takeover(f.input), /Lost claim/);
  const id = f.store.getHumanAttempt(f.input.cardId).id;
  await f.controller.takeover(f.input);
  await f.writeOutputs();
  f.loseCompleteResponse();
  await assert.rejects(f.controller.complete(f.input), /Lost completion/);
  await f.controller.complete(f.input);
  assert.equal(f.store.getHumanAttempt(f.input.cardId).id, id);
  assert.equal(f.store.getHumanAttempt(f.input.cardId).status, "done");
  assert.equal(f.cards.length, 2);
});

test("foreign cards, unsubmitted moves and different operators cannot bypass the human audit gate", async (t) => {
  const f = await fixture(t);
  f.store.setInstanceControl("A", { automaticDispatch: false });
  await assert.rejects(f.controller.takeover({ ...f.input, cardId: "other" }), /belong/);
  await f.controller.takeover(f.input);
  await assert.rejects(f.controller.complete({ ...f.input, actor: "someone else" }), /owned/);
  f.cards[0].status = "done";
  await f.writeOutputs();
  await f.runtime.reconcile("A");
  assert.equal(f.cards[0].status, "blocked");
  assert.deepEqual(f.cards.find((card) => card.id === "other"), f.sentinel);
});

test("changing validated output evidence prevents replay of a previous human completion", async (t) => {
  const f = await fixture(t);
  f.store.setInstanceControl("A", { automaticDispatch: false });
  await f.controller.takeover(f.input);
  await f.writeOutputs();
  await f.controller.complete(f.input);
  await writeFile(join(f.root, "requirementSnapshot.json"), JSON.stringify({ traceable: true, altered: true }));
  await assert.rejects(f.controller.complete(f.input), /Evidence changed/);
});
