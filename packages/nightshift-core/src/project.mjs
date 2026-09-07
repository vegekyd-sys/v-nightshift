import { stageEnabled } from "./workflow.mjs";

export function validateProjectRequest(release, project) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/.test(project?.id ?? "")) {
    throw new Error("Project id must be 1-31 characters using letters, numbers, dots, underscores, or hyphens");
  }
  if (typeof project.name !== "string" || !project.name.trim()) {
    throw new Error("Project name is required");
  }
  if (!release?.metadata?.workflowSha256) {
    throw new Error(`Unknown workflow release ${project.workflowSha256 ?? ""}`.trim());
  }
  const inputs = project.inputs ?? {};
  for (const [name, contract] of Object.entries(release.spec.inputs ?? {})) {
    const value = inputs[name];
    if (contract.required && (value === undefined || value === null || value === "")) {
      throw new Error(`Required project input is missing: ${name}`);
    }
    if (value === undefined || value === null) continue;
    if (!inputMatchesType(value, contract.type)) {
      throw new Error(`Project input ${name} must be ${contract.type}`);
    }
    if (Array.isArray(contract.enum) && !contract.enum.some((entry) => sameValue(entry, value))) {
      throw new Error(`Project input ${name} must be one of: ${contract.enum.join(", ")}`);
    }
    if (contract.type === "object" && Array.isArray(contract.requiredProperties)) {
      const missing = contract.requiredProperties.filter((property) => missingValue(value[property]));
      if (missing.length > 0) {
        throw new Error(`Project input ${name} is missing required properties: ${missing.join(", ")}`);
      }
    }
  }
  const roles = new Set(
    (release.spec.stages ?? [])
      .filter((stage) => stage.actor === "agent" && stageEnabled(stage, inputs))
      .map((stage) => stage.agentRole ?? release.spec.ownerAgentRole),
  );
  for (const role of roles) {
    if (typeof project.agentBindings?.[role] !== "string" || !project.agentBindings[role].trim()) {
      throw new Error(`Agent binding is required for role ${role}`);
    }
  }
  return project;
}

function missingValue(value) {
  return value === undefined || value === null || value === "";
}

export function requiredSkillsByRole(release, inputs = {}) {
  const result = new Map();
  const defaultRole = release?.spec?.ownerAgentRole;
  for (const stage of release?.spec?.stages ?? []) {
    if (stage.actor !== "agent" || !stageEnabled(stage, inputs)) continue;
    const role = stage.agentRole ?? defaultRole;
    if (!role) continue;
    const required = result.get(role) ?? new Set();
    for (const skill of stage.skills ?? []) required.add(skill);
    for (const strategy of Object.values(stage.routeStrategies ?? {})) {
      for (const skill of strategy.skills ?? []) required.add(skill);
    }
    result.set(role, required);
  }
  return Object.fromEntries(
    [...result.entries()].map(([role, skills]) => [role, [...skills].sort()]),
  );
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inputMatchesType(value, type) {
  if (!type) return true;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && !Array.isArray(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
