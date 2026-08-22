import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import YAML from "yaml";

const ACTORS = new Set(["agent", "human", "system", "timer"]);
const GUARDED_SIDE_EFFECTS = new Set([
  "destructive",
  "external-publication",
  "paid-production",
  "permission-change",
]);
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export class WorkflowValidationError extends Error {
  constructor(issues) {
    super(`Workflow validation failed with ${issues.length} issue(s)`);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

export async function loadWorkflow(filePath) {
  const source = await readFile(filePath, "utf8");
  return parseWorkflow(source, filePath);
}

export function parseWorkflow(source, sourceName = "workflow.yaml") {
  let document;
  try {
    document = YAML.parse(source);
  } catch (error) {
    throw new WorkflowValidationError([
      issue("yaml.invalid", sourceName, error.message),
    ]);
  }
  return document;
}

export function validateWorkflow(document) {
  const issues = [];
  if (!isObject(document)) {
    return [issue("workflow.invalid", "$", "Workflow must be an object")];
  }

  if (document.apiVersion !== "nightshift.versa.ai/v1alpha1") {
    issues.push(
      issue(
        "apiVersion.unsupported",
        "apiVersion",
        "Expected nightshift.versa.ai/v1alpha1",
      ),
    );
  }
  if (document.kind !== "Workflow") {
    issues.push(issue("kind.invalid", "kind", "Expected Workflow"));
  }

  const metadata = document.metadata;
  if (!isObject(metadata)) {
    issues.push(issue("metadata.required", "metadata", "metadata is required"));
  } else {
    validateIdentifier(metadata.id, "metadata.id", issues);
    requiredString(metadata.version, "metadata.version", issues);
    requiredString(metadata.name, "metadata.name", issues);
  }

  const spec = document.spec;
  if (!isObject(spec)) {
    issues.push(issue("spec.required", "spec", "spec is required"));
    return issues;
  }
  validateIdentifier(spec.ownerAgentRole, "spec.ownerAgentRole", issues);

  const stages = Array.isArray(spec.stages) ? spec.stages : [];
  if (stages.length === 0) {
    issues.push(
      issue("stages.required", "spec.stages", "At least one stage is required"),
    );
    return issues;
  }

  const stageIds = new Set();
  for (const [index, stage] of stages.entries()) {
    const path = `spec.stages[${index}]`;
    if (!isObject(stage)) {
      issues.push(issue("stage.invalid", path, "Stage must be an object"));
      continue;
    }
    validateIdentifier(stage.id, `${path}.id`, issues);
    if (typeof stage.id === "string") {
      if (stageIds.has(stage.id)) {
        issues.push(
          issue("stage.duplicate", `${path}.id`, `Duplicate stage id ${stage.id}`),
        );
      }
      stageIds.add(stage.id);
    }
    requiredString(stage.title, `${path}.title`, issues);
    if (!ACTORS.has(stage.actor)) {
      issues.push(
        issue(
          "stage.actor.invalid",
          `${path}.actor`,
          `actor must be one of ${[...ACTORS].join(", ")}`,
        ),
      );
    }
    const declaredSkills = stageSkills(stage);
    if (stage.actor === "agent" && declaredSkills.length === 0) {
      issues.push(
        issue(
          "stage.skill.required",
          `${path}.skills`,
          "Agent stages require at least one skill",
        ),
      );
    }
    if (
      stage.skills !== undefined &&
      (!Array.isArray(stage.skills) ||
        stage.skills.length === 0 ||
        stage.skills.some((entry) => !nonEmptyString(entry)))
    ) {
      issues.push(
        issue(
          "stage.skills.invalid",
          `${path}.skills`,
          "skills must be a non-empty array of skill names",
        ),
      );
    }
    if (
      stage.actor === "agent" &&
      (!Array.isArray(stage.completeWhen) || stage.completeWhen.length === 0)
    ) {
      issues.push(
        issue(
          "stage.completion.required",
          `${path}.completeWhen`,
          "Agent stages require machine-verifiable completion rules",
        ),
      );
    }
    if (!nonEmptyString(stage.timeout)) {
      issues.push(
        issue("stage.timeout.required", `${path}.timeout`, "timeout is required"),
      );
    }

    const sideEffects = stringArray(stage.sideEffects);
    const guarded = sideEffects.filter((value) => GUARDED_SIDE_EFFECTS.has(value));
    if (guarded.length > 0 && !isObject(stage.approval)) {
      issues.push(
        issue(
          "stage.approval.required",
          `${path}.approval`,
          `Approval is required for ${guarded.join(", ")}`,
        ),
      );
    }
    if (sideEffects.length > 0) {
      if (!isObject(stage.retry)) {
        issues.push(
          issue(
            "stage.retry.required",
            `${path}.retry`,
            "Side-effect stages require retry policy",
          ),
        );
      } else if (!nonEmptyString(stage.retry.idempotencyKey)) {
        issues.push(
          issue(
            "stage.idempotency.required",
            `${path}.retry.idempotencyKey`,
            "Side-effect stages require an idempotency key",
          ),
        );
      }
    }
    if (isObject(stage.retry)) {
      if (!Number.isInteger(stage.retry.maxAttempts) || stage.retry.maxAttempts < 1) {
        issues.push(
          issue(
            "stage.retry.maxAttempts.invalid",
            `${path}.retry.maxAttempts`,
            "maxAttempts must be a positive integer",
          ),
        );
      }
    }
  }

  const graph = buildGraph(stages);
  for (const reference of graph.references) {
    if (!stageIds.has(reference.target)) {
      issues.push(
        issue(
          "stage.reference.missing",
          reference.path,
          `Unknown stage ${reference.target}`,
        ),
      );
    }
  }
  if (graph.references.every((reference) => stageIds.has(reference.target))) {
    const cycle = findCycle(graph.dependencies);
    if (cycle) {
      issues.push(
        issue(
          "workflow.cycle",
          "spec.stages",
          `Workflow contains a cycle: ${cycle.join(" -> ")}`,
        ),
      );
    }
    for (const unreachable of findUnreachable(graph.dependencies)) {
      issues.push(
        issue(
          "stage.unreachable",
          `spec.stages.${unreachable}`,
          `Stage ${unreachable} is unreachable from a root stage`,
        ),
      );
    }
  }

  return issues;
}

export function compileWorkflow(document) {
  const issues = validateWorkflow(document);
  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }

  const normalized = normalize(document);
  const workflowSha256 = sha256(canonicalStringify(normalized));
  const graph = buildGraph(normalized.spec.stages);
  const stages = normalized.spec.stages.map((stage, order) => ({
    ...stage,
    order,
    needs: [...(graph.dependencies.get(stage.id) ?? [])],
  }));

  return {
    apiVersion: normalized.apiVersion,
    kind: "WorkflowRelease",
    metadata: {
      ...normalized.metadata,
      releaseId: `${normalized.metadata.id}@${normalized.metadata.version}+sha.${workflowSha256.slice(0, 12)}`,
      workflowSha256,
    },
    spec: {
      ...normalized.spec,
      stages,
    },
  };
}

export function canonicalStringify(value) {
  return JSON.stringify(sortValue(value));
}

export function interpolate(template, values) {
  return template.replace(/\$\{([^}]+)\}/g, (_, path) => {
    const value = path.split(".").reduce((current, key) => current?.[key], values);
    if (value === undefined || value === null) {
      throw new Error(`Missing interpolation value: ${path}`);
    }
    return String(value);
  });
}

function buildGraph(stages) {
  const dependencies = new Map();
  const references = [];
  for (const stage of stages) {
    if (!isObject(stage) || typeof stage.id !== "string") continue;
    dependencies.set(stage.id, new Set(stringArray(stage.needs)));
    for (const target of stringArray(stage.needs)) {
      references.push({ target, path: `spec.stages.${stage.id}.needs` });
    }
  }
  for (const stage of stages) {
    if (!isObject(stage) || typeof stage.id !== "string") continue;
    for (const target of stringArray(stage.next)) {
      references.push({ target, path: `spec.stages.${stage.id}.next` });
      if (dependencies.has(target)) dependencies.get(target).add(stage.id);
    }
  }
  return { dependencies, references };
}

function findCycle(dependencies) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const id of dependencies.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function findUnreachable(dependencies) {
  const roots = [...dependencies]
    .filter(([, needs]) => needs.size === 0)
    .map(([id]) => id);
  const downstream = new Map([...dependencies.keys()].map((id) => [id, []]));
  for (const [id, needs] of dependencies) {
    for (const dependency of needs) downstream.get(dependency)?.push(id);
  }
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(downstream.get(id) ?? []));
  }
  return [...dependencies.keys()].filter((id) => !seen.has(id));
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, normalize(entry)]),
  );
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function issue(code, path, message) {
  return { code, path, message };
}

function validateIdentifier(value, path, issues) {
  if (!nonEmptyString(value)) {
    issues.push(issue("identifier.required", path, "Identifier is required"));
  } else if (!ID_PATTERN.test(value)) {
    issues.push(
      issue(
        "identifier.invalid",
        path,
        "Use lowercase letters, numbers, and hyphens; start with a letter",
      ),
    );
  }
}

function requiredString(value, path, issues) {
  if (!nonEmptyString(value)) {
    issues.push(issue("string.required", path, "A non-empty string is required"));
  }
}

function stringArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string");
  if (typeof value === "string") return [value];
  return [];
}

export function stageSkills(stage) {
  if (!isObject(stage)) return [];
  const skills = stringArray(stage.skills).filter(nonEmptyString);
  if (skills.length > 0) return [...new Set(skills)];
  return nonEmptyString(stage.skill) ? [stage.skill] : [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
