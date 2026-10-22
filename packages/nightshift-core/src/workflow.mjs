import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { resolveReleaseAt } from "./release-schedule.mjs";
import { CARD_LABEL_MAX } from "./content-items.mjs";

// What the native Workboard refuses on a card and Night Shift cannot shorten for
// it: ids written into labels (each label at most CARD_LABEL_MAX characters) and
// the card's Skill list (at most 20 names of at most 80). A Workflow that breaks
// one would publish and then stop at its first card; it is refused here instead.
const WORKBOARD_SKILLS_MAX = 20;
const WORKBOARD_SKILL_NAME_MAX = 80;
function labelFits(prefix, value) {
  return `${prefix}${value}`.length <= CARD_LABEL_MAX;
}

const ACTORS = new Set(["agent", "human", "system", "timer"]);
const STAGE_SCOPES = new Set(["project", "content-item"]);
const ROUTE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
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
  if (/^---\s*$/m.test(source) && /^##\s+(?:STAGE|STEP)\s+/m.test(source)) {
    return parseWorkflowMarkdown(source, sourceName);
  }
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

export function parseWorkflowMarkdown(source, sourceName = "workflow.md") {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(source);
  if (!frontmatter) {
    throw new WorkflowValidationError([
      issue("markdown.frontmatter.required", sourceName, "workflow.md requires YAML frontmatter"),
    ]);
  }
  let document;
  try {
    document = YAML.parse(frontmatter[1]);
  } catch (error) {
    throw new WorkflowValidationError([
      issue("markdown.frontmatter.invalid", sourceName, error.message),
    ]);
  }
  if (!isObject(document)) document = {};
  if (!isObject(document.spec)) document.spec = {};
  const body = source.slice(frontmatter[0].length);
  const headingPattern = /^##\s+(?:STAGE|STEP)\s+([a-z][a-z0-9-]*)\s*(?:｜|\||:|—|-)\s*(.+?)\s*$/gm;
  const headings = [...body.matchAll(headingPattern)];
  if (headings.length === 0) {
    throw new WorkflowValidationError([
      issue("markdown.stages.required", sourceName, "workflow.md requires at least one ## STAGE id | title section"),
    ]);
  }
  document.spec.stages = headings.map((heading, index) => {
    const sectionStart = heading.index + heading[0].length;
    const sectionEnd = headings[index + 1]?.index ?? body.length;
    const section = body.slice(sectionStart, sectionEnd);
    const block = /```stage\s*\r?\n([\s\S]*?)\r?\n```/.exec(section);
    if (!block) {
      throw new WorkflowValidationError([
        issue("markdown.stage.block.required", `stage.${heading[1]}`, `Stage ${heading[1]} requires a fenced stage block`),
      ]);
    }
    let config;
    try {
      config = YAML.parse(block[1]);
    } catch (error) {
      throw new WorkflowValidationError([
        issue("markdown.stage.block.invalid", `stage.${heading[1]}`, error.message),
      ]);
    }
    if (!isObject(config)) config = {};
    const goal = /###\s+Goal\s*\r?\n([\s\S]*?)(?=\r?\n(?:###\s+|```stage)|$)/i.exec(section)?.[1]?.trim();
    return {
      ...config,
      id: heading[1],
      title: heading[2].trim(),
      description: config.description ?? goal,
    };
  });
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
    if (typeof metadata.id === "string" && !labelFits("workflow:", metadata.id)) {
      issues.push(issue("metadata.id.label", "metadata.id", `Workflow id must be ${CARD_LABEL_MAX - "workflow:".length} characters or fewer so its Workboard label fits within ${CARD_LABEL_MAX}`));
    }
    requiredString(metadata.version, "metadata.version", issues);
    requiredString(metadata.name, "metadata.name", issues);
  }

  const spec = document.spec;
  if (!isObject(spec)) {
    issues.push(issue("spec.required", "spec", "spec is required"));
    return issues;
  }
  validateIdentifier(spec.ownerAgentRole, "spec.ownerAgentRole", issues);
  validateCommandList(spec.requiredCommands, "spec.requiredCommands", issues);
  validateNotificationContract(spec.notifications, issues, Array.isArray(spec.stages) ? spec.stages : []);
  const contentRoutes = validateContentItemContract(spec.contentItems, issues);
  validateInputContracts(spec.inputs, issues);
  if (spec.completion !== undefined && (!isObject(spec.completion) || spec.completion.mode !== "strict-v1")) {
    issues.push(issue("completion.mode.invalid", "spec.completion.mode", "completion.mode must be strict-v1"));
  }
  // Declared in every Workflow and never enforced. Every project now shares one
  // first-come queue, so a per-Workflow count of projects has nothing to mean;
  // refusing it stops authors copying it forward.
  if (isObject(spec.concurrency) && spec.concurrency.maxActiveInstances !== undefined) {
    issues.push(issue("concurrency.maxActiveInstances.removed", "spec.concurrency.maxActiveInstances",
      "maxActiveInstances is not supported: every project shares one first-come queue. Remove it; perInstance still limits one project"));
  }

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
    const scope = stage.scope ?? "project";
    if (!STAGE_SCOPES.has(scope)) {
      issues.push(
        issue(
          "stage.scope.invalid",
          `${path}.scope`,
          `scope must be one of ${[...STAGE_SCOPES].join(", ")}`,
        ),
      );
    }
    if (scope === "content-item" && !isObject(spec.contentItems)) {
      issues.push(
        issue(
          "stage.contentItems.required",
          `${path}.scope`,
          "content-item stages require spec.contentItems",
        ),
      );
    }
    validateReleaseAt(stage, path, issues);
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
    const routeSkills = routeStrategySkills(stage);
    if (stage.actor === "agent" && declaredSkills.length === 0 && routeSkills.length === 0) {
      issues.push(
        issue(
          "stage.skill.required",
          `${path}.skills`,
          "Agent stages require at least one skill",
        ),
      );
    }
    if (stage.routeStrategies !== undefined) {
      if (scope !== "content-item" || !isObject(stage.routeStrategies)) {
        issues.push(
          issue(
            "stage.routeStrategies.invalid",
            `${path}.routeStrategies`,
            "routeStrategies is only valid as an object on content-item stages",
          ),
        );
      } else {
        for (const [route, strategy] of Object.entries(stage.routeStrategies)) {
          if (!contentRoutes.has(route)) {
            issues.push(issue("stage.route.invalid", `${path}.routeStrategies.${route}`, `Unknown route ${route}`));
          }
          if (!isObject(strategy) || stageSkills(strategy).length === 0) {
            issues.push(issue("stage.routeSkills.required", `${path}.routeStrategies.${route}.skills`, "Each route strategy requires skills"));
          }
        }
      }
    }
    if (typeof stage.id === "string" && !labelFits("stage:", stage.id)) {
      issues.push(issue("stage.id.label", `${path}.id`, `Stage id must be ${CARD_LABEL_MAX - "stage:".length} characters or fewer so its Workboard label fits within ${CARD_LABEL_MAX}`));
    }
    for (const route of [null, ...Object.keys(isObject(stage.routeStrategies) ? stage.routeStrategies : {})]) {
      const cardSkills = stageSkills(stage, route);
      if (cardSkills.length > WORKBOARD_SKILLS_MAX) {
        issues.push(issue("stage.skills.workboard", `${path}${route ? `.routeStrategies.${route}` : ""}.skills`, `A card carries at most ${WORKBOARD_SKILLS_MAX} Skills; this stage gives ${cardSkills.length}`));
      }
      for (const name of cardSkills.filter((entry) => entry.length > WORKBOARD_SKILL_NAME_MAX)) {
        issues.push(issue("stage.skill.name", `${path}.skills`, `Skill name ${name.slice(0, 40)}… is over ${WORKBOARD_SKILL_NAME_MAX} characters`));
      }
    }
    validateCommandList(stage.requiredCommands, `${path}.requiredCommands`, issues);
    for (const [route, strategy] of Object.entries(isObject(stage.routeStrategies) ? stage.routeStrategies : {})) {
      if (isObject(strategy)) validateCommandList(strategy.requiredCommands, `${path}.routeStrategies.${route}.requiredCommands`, issues);
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
    if (stage.resourceLock !== undefined && !nonEmptyString(stage.resourceLock)) {
      issues.push(issue("stage.resourceLock.invalid", `${path}.resourceLock`, "resourceLock must be a non-empty interpolation string"));
    }
    validateStageCondition(stage.when, `${path}.when`, spec.inputs, issues);

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
    if (isObject(stage.approval?.bindings)) {
      validateApprovalBindings(stage.approval.bindings, `${path}.approval.bindings`, issues);
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
    if (stage.outputContracts !== undefined) validateOutputContracts(stage, path, issues);
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

// A timed release that fails to parse must be a publish-time error, not a
// stage that quietly runs immediately. Both spellings are checked; `waitUntil`
// is the older name for the absolute form.
function validateReleaseAt(stage, path, issues) {
  const spec = stage.releaseAt ?? stage.waitUntil ?? null;
  if (spec === null || spec === undefined) return;
  const field = stage.releaseAt !== undefined ? "releaseAt" : "waitUntil";
  // Only agent and system cards enter the dispatch scope, and that scope is the
  // only thing that promotes a held card. A human stage with a release time
  // would wait in `scheduled` forever, so refuse it here rather than ship a card
  // nobody can release.
  if (stage.actor === "human") {
    issues.push(issue("stage.releaseAt.actor", `${path}.${field}`,
      `${field} is only supported on agent and system stages`));
    return;
  }
  if (typeof spec === "string") {
    if (!spec.trim()) {
      issues.push(issue("stage.releaseAt.invalid", `${path}.${field}`, `${field} must not be empty`));
    }
    return;
  }
  if (!isObject(spec)) {
    issues.push(issue("stage.releaseAt.invalid", `${path}.${field}`,
      `${field} must be a timestamp expression or an object with dailyAt and timezone`));
    return;
  }
  // A literal recurring release can be checked now. One built from an
  // expression can only be checked when a project supplies the value.
  try {
    resolveReleaseAt(spec, { instance: { inputs: {} }, contentItem: {}, now: Date.now() });
  } catch (error) {
    if (!containsExpression(spec)) {
      issues.push(issue("stage.releaseAt.invalid", `${path}.${field}`, error.message));
    }
  }
}

function containsExpression(spec) {
  return Object.values(spec).some((value) => typeof value === "string" && value.includes("${"));
}

function validateOutputContracts(stage, path, issues) {
  if (!isObject(stage.outputContracts)) {
    issues.push(issue("stage.outputContracts.invalid", `${path}.outputContracts`, "outputContracts must be an object"));
    return;
  }
  const outputs = new Set(stringArray(stage.outputs));
  for (const [name, contract] of Object.entries(stage.outputContracts)) {
    if (!outputs.has(name)) issues.push(issue("stage.outputContracts.output.unknown", `${path}.outputContracts.${name}`, `Unknown output ${name}`));
    if (!isObject(contract) || !["json", "https-url", "file", "text"].includes(contract.type)) {
      issues.push(issue("stage.outputContracts.type.invalid", `${path}.outputContracts.${name}.type`, "Output contract type must be json, https-url, file, or text"));
      continue;
    }
    if (contract.allowedHosts !== undefined && (!Array.isArray(contract.allowedHosts) || contract.allowedHosts.length === 0 || contract.allowedHosts.some((entry) => !nonEmptyString(entry)))) {
      issues.push(issue("stage.outputContracts.allowedHosts.invalid", `${path}.outputContracts.${name}.allowedHosts`, "allowedHosts must be a non-empty string array"));
    }
    for (const field of ["equals", "matches"]) {
      if (contract[field] !== undefined && !isObject(contract[field])) issues.push(issue(`stage.outputContracts.${field}.invalid`, `${path}.outputContracts.${name}.${field}`, `${field} must be an object`));
    }
  }
}

function validateInputContracts(inputs, issues) {
  if (inputs === undefined) return;
  if (!isObject(inputs)) {
    issues.push(issue("inputs.invalid", "spec.inputs", "inputs must be an object"));
    return;
  }
  const types = new Set(["array", "boolean", "number", "object", "string"]);
  for (const [name, contract] of Object.entries(inputs)) {
    const path = `spec.inputs.${name}`;
    if (!isObject(contract)) {
      issues.push(issue("input.contract.invalid", path, "input contract must be an object"));
      continue;
    }
    if (contract.type !== undefined && !types.has(contract.type)) {
      issues.push(issue("input.type.invalid", `${path}.type`, "input type is unsupported"));
    }
    if (contract.required !== undefined && typeof contract.required !== "boolean") {
      issues.push(issue("input.required.invalid", `${path}.required`, "required must be boolean"));
    }
    if (contract.requiredProperties !== undefined) {
      if (contract.type !== "object" || !validStringArray(contract.requiredProperties)) {
        issues.push(issue("input.requiredProperties.invalid", `${path}.requiredProperties`, "requiredProperties requires an object input and a non-empty string array"));
      }
    }
    if (contract.enum !== undefined) {
      if (!Array.isArray(contract.enum) || contract.enum.length === 0 || contract.enum.some((entry) => !isScalar(entry))) {
        issues.push(issue("input.enum.invalid", `${path}.enum`, "enum must be a non-empty array of scalar values"));
      } else if (contract.type && contract.enum.some((entry) => !inputValueMatchesType(entry, contract.type))) {
        issues.push(issue("input.enum.type.invalid", `${path}.enum`, "every enum value must match the input type"));
      }
    }
  }
}

function validateStageCondition(condition, path, inputs, issues) {
  if (condition === undefined) return;
  if (!isObject(condition)) {
    issues.push(issue("stage.when.invalid", path, "when must be an object"));
    return;
  }
  if (!nonEmptyString(condition.input)) {
    issues.push(issue("stage.when.input.required", `${path}.input`, "when.input is required"));
  } else if (!isObject(inputs?.[condition.input])) {
    issues.push(issue("stage.when.input.unknown", `${path}.input`, `Unknown workflow input ${condition.input}`));
  }
  const operators = ["equals", "notEquals"].filter((operator) => condition[operator] !== undefined);
  if (operators.length !== 1 || !isScalar(condition[operators[0]])) {
    issues.push(issue("stage.when.operator.invalid", path, "when requires exactly one scalar equals or notEquals value"));
  }
}

function validateApprovalBindings(bindings, path, issues) {
  for (const [name, binding] of Object.entries(bindings)) {
    const bindingPath = `${path}.${name}`;
    if (!isObject(binding) || !nonEmptyString(binding.source)) {
      issues.push(issue("approval.binding.invalid", bindingPath, "approval binding requires a source"));
      continue;
    }
    if (!binding.source.startsWith("input.") || /(secret|token|password|credential|api.?key)/i.test(binding.source)) {
      issues.push(issue("approval.binding.source.invalid", `${bindingPath}.source`, "approval bindings must reference a non-secret project input"));
    }
    if (binding.requiredFields !== undefined && !validStringArray(binding.requiredFields)) {
      issues.push(issue("approval.binding.requiredFields.invalid", `${bindingPath}.requiredFields`, "requiredFields must be a non-empty string array"));
    }
  }
}

function validStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
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

// Who hears when a project needs review or finishes. `to` is the Feishu target
// used when the project itself records no creator chat: a group (oc_…) or a
// person's own chat (user:ou_…). Projects created by a schedule rather than a
// person rely on it.
// needsYou: someone must act (a stop or a review). Without it, whoever hears
// instanceCompleted hears needsYou too.
const NOTIFICATION_EVENTS = new Set(["instanceCompleted", "needsYou"]);
const FEISHU_NOTIFY_TARGET = /^(oc_[A-Za-z0-9_-]+|user:ou_[A-Za-z0-9_-]+)$/;

function validateNotificationContract(notifications, issues, stages = []) {
  if (notifications === undefined) return;
  if (!isObject(notifications)) {
    issues.push(issue("notifications.invalid", "spec.notifications", "notifications must be an object"));
    return;
  }
  for (const [name, value] of Object.entries(notifications)) {
    const path = `spec.notifications.${name}`;
    // reviewRequested was declared by earlier workflows; it is accepted and
    // ignored until review cards are carried over.
    if (!NOTIFICATION_EVENTS.has(name) && name !== "reviewRequested") {
      issues.push(issue("notifications.event.invalid", path, `Unsupported notification event ${name}`));
      continue;
    }
    if (!isObject(value) || typeof value.enabled !== "boolean") {
      issues.push(issue("notifications.event.config.invalid", path, "Notification config requires enabled: true|false"));
      continue;
    }
    if (value.to !== undefined && (typeof value.to !== "string" || !FEISHU_NOTIFY_TARGET.test(value.to))) {
      issues.push(issue("notifications.to.invalid", `${path}.to`, "to must be a Feishu group (oc_…) or a person (user:ou_…)"));
    }
    if (value.link !== undefined) validateNotificationLink(value.link, `${path}.link`, stages, issues);
  }
}

// A link on the card: { label, stage, output } names one output of a project
// stage whose JSON carries an https `url` (a delivery page). The engine reads
// it when the card is sent; without it the card links the board.
function validateNotificationLink(link, path, stages, issues) {
  const invalid = (where, message) => issues.push(issue("notifications.link.invalid", where, message));
  if (!isObject(link)) return invalid(path, "link must be { label, stage, output }");
  if (typeof link.label !== "string" || link.label.trim() === "" || [...link.label].length > 12) {
    invalid(`${path}.label`, "label must be a short button text (at most 12 characters)");
  }
  const stage = stages.find((entry) => entry?.id === link.stage);
  if (!stage || (stage.scope ?? "project") !== "project") {
    return invalid(`${path}.stage`, "stage must name a project-scope stage");
  }
  if (!stringArray(stage.outputs).includes(link.output)) invalid(`${path}.output`, `output must be one of the outputs of ${stage.id}`);
}

function issue(code, path, message) {
  return { code, path, message };
}

const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A required command is a bare executable name resolved through PATH on the
// worker host; paths and shell fragments are rejected so the preflight cannot
// be pointed at arbitrary files.
function validateCommandList(value, path, issues) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !COMMAND_PATTERN.test(entry))) {
    issues.push(issue("requiredCommands.invalid", path, "requiredCommands must be a non-empty array of bare executable names"));
  }
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

export function stageSkills(stage, route = null) {
  if (!isObject(stage)) return [];
  const routed = route && isObject(stage.routeStrategies?.[route])
    ? stringArray(stage.routeStrategies[route].skills).filter(nonEmptyString)
    : [];
  const skills = stringArray(stage.skills).filter(nonEmptyString);
  const fallback = nonEmptyString(stage.skill) ? [stage.skill] : [];
  return [...new Set([...skills, ...fallback, ...routed])];
}

export function stageEnabled(stage, inputs = {}) {
  const condition = stage?.when;
  if (!isObject(condition)) return true;
  const actual = inputs?.[condition.input];
  if (condition.equals !== undefined) return sameValue(actual, condition.equals);
  if (condition.notEquals !== undefined) return !sameValue(actual, condition.notEquals);
  return true;
}

function routeStrategySkills(stage) {
  if (!isObject(stage?.routeStrategies)) return [];
  return Object.values(stage.routeStrategies).flatMap((strategy) => stageSkills(strategy));
}

function validateContentItemContract(contract, issues) {
  const allowed = new Set();
  if (contract === undefined) return allowed;
  if (!isObject(contract)) {
    issues.push(issue("contentItems.invalid", "spec.contentItems", "contentItems must be an object"));
    return allowed;
  }
  const routes = stringArray(contract.routes);
  if (routes.length === 0) {
    issues.push(issue("contentItems.routes.required", "spec.contentItems.routes", "At least one content route is required"));
  }
  for (const route of routes) {
    if (!ROUTE_PATTERN.test(route)) issues.push(issue("contentItems.route.invalid", "spec.contentItems.routes", `Route ${route} must use uppercase letters, numbers, and underscores`));
    else if (!labelFits("route:", route)) issues.push(issue("contentItems.route.label", "spec.contentItems.routes", `Route ${route} must be ${CARD_LABEL_MAX - "route:".length} characters or fewer so its Workboard label fits within ${CARD_LABEL_MAX}`));
    if (allowed.has(route)) issues.push(issue("contentItems.route.duplicate", "spec.contentItems.routes", `Duplicate route ${route}`));
    allowed.add(route);
  }
  if (!Number.isInteger(contract.maxItems) || contract.maxItems < 1 || contract.maxItems > 100) {
    issues.push(issue("contentItems.maxItems.invalid", "spec.contentItems.maxItems", "maxItems must be an integer from 1 to 100"));
  }
  return allowed;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function inputValueMatchesType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function isScalar(value) {
  return value === null || ["boolean", "number", "string"].includes(typeof value);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
