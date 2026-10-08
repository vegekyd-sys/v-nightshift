import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  compileWorkflow,
  handoffManifestExample,
  humanStageHandoff,
  loadWorkflow,
  normalizeStageHandoff,
  presentStageHandoff,
  readProjectStageOutput,
  stageHandoffContract,
  stageHandoffPath,
} from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");

test("derives each stage input from only its immediate predecessors", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const plan = stageHandoffContract(release, "plan");
  assert.deepEqual(plan.inputs, [{ name: "projectInputs", sourceStage: "control-plane" }]);
  const route = stageHandoffContract(release, "route");
  assert.deepEqual(route.previous.map((entry) => entry.id), ["plan"]);
  assert.deepEqual(route.inputs.map((entry) => entry.name), ["requirementSnapshot", "planUrl", "contentItemsManifest"]);
  assert.deepEqual(route.outputs.map((entry) => entry.name), ["routeDecision"]);
  assert.deepEqual(route.next.map((entry) => entry.id), ["materials"]);
  assert.equal(presentStageHandoff({ release, stageId: "route", completed: true }).deliveryPlacement, null);
});

test("accepts the control-plane project snapshot as the root stage input", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const manifest = normalizeStageHandoff({
    version: 1,
    instanceId: "NS-ROOT",
    contentItemId: null,
    stageId: "plan",
    inputs: [{
      name: "projectInputs",
      sourceStage: "control-plane",
      summary: "Complete redacted project brief and constraints",
      artifact: "project-inputs.json",
    }],
    outputs: stageHandoffContract(release, "plan").outputs.map((entry) => ({
      ...entry,
      summary: `Recorded ${entry.name}`,
      artifact: `${entry.name}.json`,
    })),
  }, { instanceId: "NS-ROOT", release, stageId: "plan" });
  assert.equal(manifest.inputs[0].artifact, "project-inputs.json");
});

test("places the finished video only on produce output and downstream input", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  assert.equal(presentStageHandoff({ release, stageId: "produce" }).deliveryPlacement, "output");
  assert.equal(presentStageHandoff({ release, stageId: "review" }).deliveryPlacement, "input");
});

test("validates a recorded handoff against workflow input and output names", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const example = handoffManifestExample({ instanceId: "NS-1", contentItemId: "video-1", release, stageId: "route" });
  const normalized = normalizeStageHandoff(example, { instanceId: "NS-1", contentItemId: "video-1", release, stageId: "route" });
  assert.equal(normalized.outputs[0].name, "routeDecision");
  assert.throws(
    () => normalizeStageHandoff({ ...example, outputs: [] }, { instanceId: "NS-1", contentItemId: "video-1", release, stageId: "route" }),
    /do not match the workflow contract: missing route:routeDecision/,
  );
  // An extra entry the Workflow did not ask for is dropped, not fatal.
  const extra = { name: "machineQc", sourceStage: "route", summary: "extra evidence", artifact: "qc.json" };
  const withExtra = normalizeStageHandoff({ ...example, outputs: [...example.outputs, extra] }, { instanceId: "NS-1", contentItemId: "video-1", release, stageId: "route" });
  assert.deepEqual(withExtra.outputs.map((entry) => entry.name), ["routeDecision"]);
  assert.match(stageHandoffPath({ instanceDir: "/srv/nightshift/NS-1", contentItemId: "video-1", release, stageId: "route" }), /content-items\/video-1\/handoffs\/route\.json$/);
  assert.match(stageHandoffPath({ instanceDir: "/srv/nightshift/NS-1", release, stageId: "plan" }), /NS-1\/handoffs\/plan\.json$/);
});

test("exposes a recorded https publication artifact as a clickable link", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const example = handoffManifestExample({ instanceId: "NS-1", contentItemId: "video-1", release, stageId: "publish-feedback" });
  const publicUrl = example.outputs.find((entry) => entry.name === "publicUrl");
  publicUrl.artifact = "https://www.tiktok.com/@example/video/123";
  const manifest = normalizeStageHandoff(example, { instanceId: "NS-1", contentItemId: "video-1", release, stageId: "publish-feedback" });
  const presented = presentStageHandoff({ completed: true, manifest, release, stageId: "publish-feedback" });
  assert.equal(presented.outputs.find((entry) => entry.name === "publicUrl").artifactUrl, publicUrl.artifact);
  assert.equal(presented.outputs.find((entry) => entry.name === "publicationEvidence").artifactUrl, null);
});

test("records a human review as the output handed to publication", async () => {
  const release = compileWorkflow(await loadWorkflow(fixture));
  const manifest = humanStageHandoff({
    actor: "Reviewer",
    approvalArtifact: "workboard-approval:card-1",
    contentItemId: "video-1",
    evidence: "Approved after visual review",
    instanceDir: "/srv/nightshift/NS-1",
    instanceId: "NS-1",
    release,
    stageId: "review",
  });
  assert.deepEqual(manifest.inputs.map((entry) => entry.name), ["finishedAsset", "machineQc", "deliveryManifest"]);
  assert.deepEqual(manifest.outputs.map((entry) => entry.name), ["approvedAssetVersion"]);
  assert.equal(manifest.outputs[0].summary, "Approved after visual review");
  assert.equal(manifest.outputs[0].artifact, "workboard-approval:card-1");
});

test("a project stage's declared output is read through its handoff, inside the project only", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const instanceDir = await mkdtemp(join(tmpdir(), "ns-output-"));
  await mkdir(join(instanceDir, "handoffs"));
  await mkdir(join(instanceDir, "deliver-page"));
  await writeFile(join(instanceDir, "deliver-page", "delivery-page.json"), JSON.stringify({ published: true, url: "https://x/deliver/?m=1" }));
  const handoff = (artifact) => writeFile(join(instanceDir, "handoffs", "deliver-page.json"), JSON.stringify({
    version: 1, instanceId: "DL-1", contentItemId: null, stageId: "deliver-page", inputs: [],
    outputs: [{ name: "deliveryPage", sourceStage: "deliver-page", summary: "s", artifact }],
  }));
  const read = (output = "deliveryPage") => readProjectStageOutput({ instanceDir, stageId: "deliver-page", output });

  await handoff("deliver-page/delivery-page.json");
  assert.deepEqual(await read(), { published: true, url: "https://x/deliver/?m=1" });
  assert.equal(await read("other"), null, "an output the handoff does not list");
  await handoff(join(instanceDir, "deliver-page", "delivery-page.json"));
  assert.equal((await read()).url, "https://x/deliver/?m=1", "an absolute path inside the project");
  await handoff("../../etc/hosts");
  assert.equal(await read(), null, "never outside the project");
  await handoff("deliver-page/missing.json");
  assert.equal(await read(), null);
  assert.equal(await readProjectStageOutput({ instanceDir, stageId: "never-ran", output: "x" }), null);
});
