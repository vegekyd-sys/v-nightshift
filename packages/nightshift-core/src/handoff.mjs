import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function stageHandoffContract(release, stageId) {
  const stages = release?.spec?.stages ?? [];
  const stage = stages.find((entry) => entry.id === stageId);
  if (!stage) throw new Error(`Unknown workflow stage ${stageId}`);
  const previous = (stage.needs ?? []).map((id) => {
    const source = stages.find((entry) => entry.id === id);
    if (!source) throw new Error(`Unknown upstream stage ${id}`);
    return { id: source.id, title: source.title, outputs: [...(source.outputs ?? [])] };
  });
  const next = stages
    .filter((entry) => (entry.needs ?? []).includes(stage.id))
    .map((entry) => ({ id: entry.id, title: entry.title }));
  const inputs = previous.length > 0
    ? previous.flatMap((source) => source.outputs.map((name) => ({ name, sourceStage: source.id })))
    : [{ name: "projectInputs", sourceStage: "control-plane" }];
  return {
    stage: { id: stage.id, title: stage.title, scope: stage.scope },
    previous,
    next,
    inputs,
    outputs: (stage.outputs ?? []).map((name) => ({ name, sourceStage: stage.id })),
  };
}

export function stageHandoffPath({ instanceDir, contentItemId = null, release, stageId }) {
  const contract = stageHandoffContract(release, stageId);
  const root = contract.stage.scope === "content-item"
    ? join(instanceDir, "content-items", requiredContentItemId(contentItemId))
    : instanceDir;
  return join(root, "handoffs", `${stageId}.json`);
}

export function normalizeStageHandoff(input, { contentItemId = null, instanceId, release, stageId }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Stage handoff must be an object");
  if (input.version !== 1) throw new Error("Unsupported stage handoff version");
  if (input.instanceId !== instanceId) throw new Error("Stage handoff instance mismatch");
  if (input.stageId !== stageId) throw new Error("Stage handoff stage mismatch");
  if ((input.contentItemId ?? null) !== (contentItemId ?? null)) throw new Error("Stage handoff content item mismatch");
  const contract = stageHandoffContract(release, stageId);
  const inputs = normalizeEntries(input.inputs, "input");
  const outputs = normalizeEntries(input.outputs, "output");
  return {
    version: 1,
    instanceId,
    contentItemId: contentItemId ?? null,
    stageId,
    inputs: declaredEntries(inputs, contract.inputs, "input"),
    outputs: declaredEntries(outputs, contract.outputs, "output"),
  };
}

export function presentStageHandoff({ completed = false, manifest = null, release, stageId }) {
  const contract = stageHandoffContract(release, stageId);
  const recordedInputs = new Map((manifest?.inputs ?? []).map((entry) => [entryKey(entry), entry]));
  const recordedOutputs = new Map((manifest?.outputs ?? []).map((entry) => [entryKey(entry), entry]));
  const inputs = contract.inputs.map((entry) => presentEntry(entry, recordedInputs.get(entryKey(entry)), true));
  const outputs = contract.outputs.map((entry) => presentEntry(entry, recordedOutputs.get(entryKey(entry)), completed));
  const inputNames = new Set(inputs.map((entry) => entry.name));
  const outputNames = new Set(outputs.map((entry) => entry.name));
  const deliveryPlacement = outputNames.has("finishedAsset") || outputNames.has("deliveryManifest")
    ? "output"
    : inputNames.has("finishedAsset") || inputNames.has("approvedAssetVersion")
      ? "input"
      : null;
  return {
    ...contract,
    inputs,
    outputs,
    recorded: Boolean(manifest),
    deliveryPlacement,
  };
}

export function handoffManifestExample({ contentItemId = null, instanceId, release, stageId }) {
  const contract = stageHandoffContract(release, stageId);
  const entry = (value) => ({ ...value, summary: "concise evidence-backed summary", artifact: "relative/path-or-url" });
  return {
    version: 1,
    instanceId,
    contentItemId: contentItemId ?? null,
    stageId,
    inputs: contract.inputs.map(entry),
    outputs: contract.outputs.map(entry),
  };
}

export function humanStageHandoff({
  actor,
  approvalArtifact,
  contentItemId = null,
  evidence,
  instanceDir,
  instanceId,
  release,
  stageId,
}) {
  const contract = stageHandoffContract(release, stageId);
  return normalizeStageHandoff({
    version: 1,
    instanceId,
    contentItemId,
    stageId,
    inputs: contract.inputs.map((entry) => ({
      ...entry,
      summary: `Received from ${entry.sourceStage}`,
      artifact: stageHandoffPath({ instanceDir, contentItemId, release, stageId: entry.sourceStage }),
    })),
    outputs: contract.outputs.map((entry) => ({
      ...entry,
      summary: evidence || `Approved by ${actor || "Workboard operator"}`,
      artifact: approvalArtifact,
    })),
  }, { contentItemId, instanceId, release, stageId });
}

export function handoffArtifactRoot(path) {
  return dirname(dirname(path));
}

function normalizeEntries(value, kind) {
  if (!Array.isArray(value)) throw new Error(`Stage handoff ${kind}s must be an array`);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Stage handoff ${kind} must be an object`);
    const name = clean(entry.name);
    const sourceStage = clean(entry.sourceStage);
    const summary = clean(entry.summary);
    const artifact = clean(entry.artifact);
    if (!name || !sourceStage || !summary) throw new Error(`Stage handoff ${kind} requires name, sourceStage, and summary`);
    if (!artifact) throw new Error(`Stage handoff ${kind} requires an artifact reference`);
    return { name, sourceStage, summary, artifact };
  });
}

function presentEntry(expected, recorded, complete) {
  return {
    ...expected,
    summary: recorded?.summary ?? null,
    artifact: recorded?.artifact ?? null,
    artifactUrl: safeExternalUrl(recorded?.artifact),
    status: recorded ? "recorded" : complete ? "completed-unregistered" : "expected",
  };
}

function safeExternalUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// Every declared entry must be recorded; anything extra the agent chose to
// hand over is dropped rather than failing the card, so a Stage is judged on
// what the Workflow asks for, not on matching its list word for word.
function declaredEntries(actual, expected, kind) {
  const recorded = new Map(actual.map((entry) => [entryKey(entry), entry]));
  const missing = expected.filter((entry) => !recorded.has(entryKey(entry))).map(entryKey);
  if (missing.length > 0) {
    throw new Error(`Stage handoff ${kind}s do not match the workflow contract: missing ${missing.join(", ")}`);
  }
  return expected.map((entry) => recorded.get(entryKey(entry)));
}

function entryKey(entry) {
  return `${entry.sourceStage}:${entry.name}`;
}

function clean(value) {
  return typeof value === "string" ? value.trim().slice(0, 4000) : "";
}

function requiredContentItemId(value) {
  if (!value) throw new Error("Content item stage handoff requires contentItemId");
  return value;
}

// The JSON a project stage recorded for one of its outputs: its handoff names
// the artifact, which must lie inside the project. Null when the stage has not
// written it, the handoff does not list it, or it cannot be read.
export async function readProjectStageOutput({ instanceDir, stageId, output }) {
  try {
    const handoff = JSON.parse(await readFile(join(instanceDir, "handoffs", `${stageId}.json`), "utf8"));
    const entry = (handoff?.outputs ?? []).find((candidate) => candidate?.name === output);
    if (typeof entry?.artifact !== "string" || entry.artifact.length === 0) return null;
    const path = isAbsolute(entry.artifact) ? resolve(entry.artifact) : resolve(instanceDir, entry.artifact);
    const inside = relative(resolve(instanceDir), path);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
