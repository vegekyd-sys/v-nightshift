// Workflow composition is declarative. No business-specific result names or
// executable expressions are interpreted by the engine.
export function durationMs(value) {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(String(value));
  const duration = match ? Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]] : NaN;
  return Number.isSafeInteger(duration) ? duration : NaN;
}
const object = value => value && typeof value === "object" && !Array.isArray(value);
const scalar = value => value === null || ["string", "boolean"].includes(typeof value) || (typeof value === "number" && Number.isFinite(value));
const pathPattern = /^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)*$/;
export function factAt(value, path) {
  if (!pathPattern.test(path) || path.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part))) return undefined;
  for (const part of path.split(".")) {
    if (!object(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
export function matchesFact(outputs, condition) {
  const value = factAt(outputs, condition.output);
  return value !== undefined && scalar(value) && Object.is(value, condition.equals);
}
export function validateCallContracts(spec) {
  const issues = [];
  const fail = (path, message) => issues.push({ code: "workflow.call.invalid", path, message });
  for (const [i, stage] of (spec.stages ?? []).entries()) {
    const path = `spec.stages[${i}]`;
    if (!stage || typeof stage !== "object") continue;
    if (stage.actor !== "workflow") {
      if (stage.call !== undefined || stage.repeat !== undefined) fail(path, "call/repeat require actor: workflow");
      continue;
    }
    if (!object(stage.call) || !/^[a-f0-9]{64}$/.test(stage.call.workflow ?? "")) fail(`${path}.call.workflow`, "call.workflow must pin a published Workflow SHA-256 (never latest)");
    if (object(stage.call) && Object.keys(stage.call).some(key => !["workflow", "inputs", "maxOperations"].includes(key))) fail(path, "Unknown call option");
    if (!object(stage.call?.inputs)) fail(`${path}.call.inputs`, "Explicit input bindings are required");
    for (const [key, binding] of Object.entries(stage.call?.inputs ?? {})) {
      if (["nightshift", "authorizationScope", "governance", "__proto__", "constructor", "prototype"].includes(key)) fail(path, `Reserved input cannot be rebound: ${key}`);
      if (object(binding) && !(Object.keys(binding).length === 1 && Object.hasOwn(binding, "value")) && (Object.keys(binding).some(key => !["from", "default"].includes(key)) || typeof binding.from !== "string" || !/^(input|item|previous)\.[a-zA-Z0-9_.-]+$/.test(binding.from))) fail(path, `Invalid binding for ${key}: use a literal or {from: input|item|previous.path}`);
      if (!object(binding) && !scalar(binding) && !Array.isArray(binding)) fail(path, `Invalid binding: ${key}`);
    }
    if (stage.skills?.length || stage.skill || stage.sideEffects?.length || stage.approval || stage.releaseAt || stage.waitUntil) fail(path, "Workflow calls do not execute skills/effects/approval/timed release; declare these in the called stages");
    if (!Number.isFinite(durationMs(stage.timeout)) || durationMs(stage.timeout) <= 0) fail(path, "Calls require a positive duration timeout");
    if (stage.call?.maxOperations !== undefined && (!Number.isSafeInteger(stage.call.maxOperations) || stage.call.maxOperations < 0)) fail(path, "call.maxOperations must be a nonnegative integer (omitted = no external calls)");
    if (stage.repeat !== undefined) {
      const repeat = stage.repeat;
      if (!object(repeat) || Object.keys(repeat).some(key => !["until", "while", "maxIterations", "maxDuration", "maxOperations"].includes(key))) fail(path, "Unknown repeat option");
      for (const key of ["until", "while"]) {
        const condition = repeat?.[key];
        if (!object(condition) || !pathPattern.test(condition.output ?? "") || !Object.hasOwn(condition, "equals") || !scalar(condition.equals) || Object.keys(condition).some(k => !["output", "equals"].includes(k))) fail(path, `repeat.${key} requires {output: path, equals: scalar}`);
      }
      if (!Number.isSafeInteger(repeat?.maxIterations) || repeat.maxIterations < 1 || repeat.maxIterations > 1000) fail(path, "maxIterations must be 1..1000");
      if (!(durationMs(repeat?.maxDuration) > 0)) fail(path, "maxDuration must be a positive duration");
      if (!Number.isSafeInteger(repeat?.maxOperations) || repeat.maxOperations < 0) fail(path, "maxOperations must be a nonnegative integer, not a monetary budget");
    }
  }
  if (spec.limits !== undefined) {
    if (!object(spec.limits) || Object.keys(spec.limits).some(key => !["maxOperations", "maxDuration"].includes(key))) fail("spec.limits", "Supported limits: maxOperations, maxDuration (not currency)");
    if (spec.limits?.maxOperations !== undefined && (!Number.isSafeInteger(spec.limits.maxOperations) || spec.limits.maxOperations < 0)) fail("spec.limits", "maxOperations must be nonnegative");
    if (spec.limits?.maxDuration !== undefined && !(durationMs(spec.limits.maxDuration) > 0)) fail("spec.limits", "maxDuration must be a positive duration");
  }
  if (spec.outputs !== undefined) {
    if (!object(spec.outputs) || !Object.keys(spec.outputs).length) fail("spec.outputs", "Workflow exports must be a nonempty mapping");
    for (const [name, source] of Object.entries(spec.outputs ?? {})) {
      const stage = spec.stages?.find(stage => stage.id === source?.stage);
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) || !stage || (stage.scope ?? "project") !== "project" || !(stage.outputs ?? []).includes(source?.output)) fail(`spec.outputs.${name}`, "Export must name a declared project-stage output (use a project aggregation stage for per-item outputs)");
    }
  }
  return issues;
}
export function validateCallReleases(release, store, depth = 0) {
  if (depth > 8) throw new Error("Workflow call nesting exceeds 8");
  for (const stage of release.spec.stages) {
    if (stage.actor !== "workflow") continue;
    const child = store.getRelease(stage.call.workflow)?.manifest;
    if (!child) throw new Error(`Unknown pinned called Workflow ${stage.call.workflow}`);
    if (!child.spec.outputs || !Object.keys(child.spec.outputs).length) throw new Error("Called Workflow must declare spec.outputs");
    for (const name of stage.outputs ?? []) if (!Object.hasOwn(child.spec.outputs, name)) throw new Error(`Called Workflow does not export ${name}`);
    for (const condition of [stage.repeat?.until, stage.repeat?.while].filter(Boolean)) {
      if (!Object.hasOwn(child.spec.outputs, condition.output.split(".")[0])) throw new Error(`Unknown called output ${condition.output}`);
    }
    validateCallReleases(child, store, depth + 1);
  }
}
