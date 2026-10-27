#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
// Import the one module this HTTP client needs, never the package index: the
// index also loads the SQLite store, and Node prints an ExperimentalWarning on
// stderr whenever node:sqlite is loaded.
import { validateGovernanceManifest } from "../packages/nightshift-core/src/governance.mjs";

const baseUrl = process.env.NIGHTSHIFT_URL ?? "http://127.0.0.1:24879";
const args = process.argv.slice(2);

try {
  const result = await run(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message, ok: false }, null, 2)}\n`);
  process.exitCode = 1;
}

async function run(input) {
  const [resource, action, subject] = input;
  if (resource === "health") return api("/api/health");
  if (resource === "workflows" && action === "list") return api("/api/workflows");
  if (resource === "workflows" && ["validate", "import", "publish"].includes(action) && subject) {
    const sourceMarkdown = await readFile(resolve(subject), "utf8");
    const endpoint = action === "validate" ? "/api/workflows/validate" : action === "import" ? "/api/workflows/import" : "/api/workflows/publish";
    return api(endpoint, {
      body: JSON.stringify(action === "import" ? { publish: false, sourceMarkdown } : { sourceMarkdown }),
      method: "POST",
    });
  }
  if (resource === "projects" && action === "list") return api(`/api/instances${input.includes("--include-archived") ? "?includeArchived=1" : ""}`);
  if (resource === "projects" && action === "get" && subject) return api(`/api/instances/${encodeURIComponent(subject)}`);
  if (resource === "projects" && action === "monitor" && subject) {
    const [project, cardsResult] = await Promise.all([
      api(`/api/instances/${encodeURIComponent(subject)}`),
      api("/api/cards?refresh=1"),
    ]);
    const cards = cardsResult.cards.filter((card) => label(card, "instance") === subject);
    // A card a newer attempt of its stage and item replaced stays blocked on
    // the native board; it is not stuck (DL-1009-02, 2026-10-10).
    const superseded = supersededCards(project.instance ?? project);
    const live = cards.filter((card) => !superseded.has(card.id));
    return {
      project,
      summary: {
        active: live.filter((card) => card.status === "running").length,
        blocked: live.filter((card) => card.status === "blocked").length,
        superseded: cards.length - live.length,
        done: live.filter((card) => card.status === "done").length,
        queued: live.filter((card) => ["ready", "todo", "planned"].includes(card.status)).length,
        review: live.filter((card) => card.status === "review").length,
      },
      tasks: cards.map((card) => ({
        agentId: card.agentId ?? null,
        attempts: Array.isArray(card.metadata?.attempts) ? card.metadata.attempts.length : card.sessionKey ? 1 : 0,
        cardId: card.id,
        contentItemId: card.metadata?.automation?.contentItemId ?? label(card, "content-item"),
        links: card.links,
        runId: card.runId ?? card.metadata?.attempts?.at(-1)?.runId ?? null,
        sessionKey: card.sessionKey ?? card.metadata?.attempts?.at(-1)?.sessionKey ?? null,
        stageId: card.metadata?.automation?.stageId ?? label(card, "stage"),
        status: card.status,
        superseded: superseded.has(card.id),
        title: card.title,
        updatedAt: card.updatedAt,
      })),
    };
  }
  if (resource === "projects" && ["preflight", "create"].includes(action) && subject) {
    const project = await readJson(subject);
    await resolveWorkflow(project);
    return api(action === "preflight" ? "/api/instances/preflight" : "/api/instances", {
      body: JSON.stringify(action === "create" ? { ...project, dispatch: false, status: "paused" } : project),
      method: "POST",
    });
  }
  // How many cards of one project may run at once. Without a value, shows the
  // current limit; <n> sets the project's own (1–8); "default" returns it to
  // the Workflow's perInstance.
  // Move a project that has not started onto another release of its Workflow.
  if (resource === "projects" && action === "workflow" && subject) {
    const version = input[3];
    if (!version || version.startsWith("--")) throw new Error("projects workflow <id> <version|latest> [--reason <text>]");
    return api(`/api/instances/${encodeURIComponent(subject)}/workflow`, {
      body: JSON.stringify({ version, reason: option(input, "--reason") ?? null, actor: option(input, "--actor") ?? "Night Shift operator" }),
      method: "POST",
    });
  }
  if (resource === "projects" && action === "concurrency" && subject) {
    const value = input[3];
    if (!value || value.startsWith("--")) {
      const project = await api(`/api/instances/${encodeURIComponent(subject)}`);
      return { instanceId: subject, concurrency: (project.instance ?? project).control?.concurrency ?? null };
    }
    const perInstance = value === "default" ? null : Number(value);
    if (perInstance !== null && !Number.isSafeInteger(perInstance)) throw new Error("projects concurrency <id> <1-8|default> [--reason <text>]");
    return api(`/api/instances/${encodeURIComponent(subject)}/concurrency`, {
      body: JSON.stringify({ perInstance, reason: option(input, "--reason") ?? null, actor: option(input, "--actor") ?? "Night Shift operator" }),
      method: "POST",
    });
  }
  // Queue order. priority <id> [<n>|first|last|default]: higher goes first,
  // equal priorities keep arrival order. order <id> <id> …: those projects go
  // ahead of every other, in that order. queue: the current order.
  if (resource === "projects" && action === "priority" && subject) {
    const value = input[3];
    if (!value || value.startsWith("--")) {
      const project = await api(`/api/instances/${encodeURIComponent(subject)}`);
      const control = (project.instance ?? project).control ?? {};
      return { instanceId: subject, priority: control.priority ?? null, queue: control.queue ?? null };
    }
    const priority = ["first", "last", "default"].includes(value) ? value : Number(value);
    if (typeof priority === "number" && !Number.isSafeInteger(priority)) throw new Error("projects priority <id> <n|first|last|default> [--reason <text>]");
    return api(`/api/instances/${encodeURIComponent(subject)}/priority`, {
      body: JSON.stringify({ priority, reason: option(input, "--reason") ?? null, actor: option(input, "--actor") ?? "Night Shift operator" }),
      method: "POST",
    });
  }
  if (resource === "projects" && action === "order") {
    const instanceIds = [];
    for (let index = 2; index < input.length && !input[index].startsWith("--"); index++) instanceIds.push(input[index]);
    if (instanceIds.length === 0) throw new Error("projects order <id> [<id> …] [--reason <text>]");
    return api("/api/queue/order", {
      body: JSON.stringify({ instanceIds, reason: option(input, "--reason") ?? null, actor: option(input, "--actor") ?? "Night Shift operator" }),
      method: "POST",
    });
  }
  if (resource === "projects" && action === "queue") {
    const result = await api("/api/instances");
    return (result.instances ?? []).filter((entry) => entry.status === "active")
      .map((entry) => ({ id: entry.id, name: entry.name, createdAt: entry.createdAt, priority: entry.control?.priority ?? null,
        queue: entry.control?.queue ?? null, concurrency: entry.control?.concurrency?.effective ?? null }))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((entry, index) => ({ order: index + 1, ...entry }));
  }
  if (resource === "projects" && action === "start" && subject) {
    return api(`/api/instances/${encodeURIComponent(subject)}/start`, { body: "{}", method: "POST" });
  }
  if (resource === "projects" && action === "pause" && subject) {
    return api(`/api/instances/${encodeURIComponent(subject)}/pause`, { body: "{}", method: "POST" });
  }
  if (resource === "projects" && ["archive", "restore"].includes(action) && subject) {
    return api(`/api/instances/${encodeURIComponent(subject)}/${action}`, {
      body: JSON.stringify({ actor: option(input, "--actor") ?? "Night Shift operator", reason: option(input, "--reason") ?? `${action} requested by operator` }),
      method: "POST",
    });
  }
  if (resource === "storage" && action === "retention") {
    if (!input.includes("--apply")) return api("/api/storage/retention");
    return api("/api/storage/retention", { body: JSON.stringify({ actor: option(input, "--actor") ?? "Night Shift operator" }), method: "POST" });
  }
  if (resource === "governance" && action === "audit") {
    return api(`/api/governance/audit${input.includes("--refresh") ? "?refresh=1" : ""}`);
  }
  if (resource === "governance" && ["archive", "restore"].includes(action) && subject) {
    const manifest = await readJson(subject);
    const [instancesResult, cardsResult] = await Promise.all([
      api("/api/instances?includeArchived=1"),
      api("/api/cards?refresh=1&includeArchived=1"),
    ]);
    const plan = validateGovernanceManifest(manifest, { cards: cardsResult.cards, instances: instancesResult.instances });
    if (!input.includes("--apply")) return { action, apply: false, plan };
    const actor = option(input, "--actor") ?? "Night Shift governance";
    const reason = option(input, "--reason") ?? manifest.reason ?? `Governance ${action}`;
    const results = [];
    for (const project of plan) {
      if (action === "archive" && project.alreadyArchived) {
        results.push({ id: project.id, status: "archived", reused: true });
        continue;
      }
      if (action === "restore" && !project.alreadyArchived) {
        results.push({ id: project.id, status: project.status, reused: true });
        continue;
      }
      results.push(await api(`/api/instances/${encodeURIComponent(project.id)}/${action}`, {
        body: JSON.stringify({ actor, reason }),
        method: "POST",
      }));
    }
    return { action, apply: true, plan, results };
  }
  if (resource === "projects" && action === "inputs" && subject) {
    const file = option(input, "--file");
    if (!file) throw new Error("projects inputs requires --file <json>");
    const inputs = await readJson(file);
    return api(`/api/instances/${encodeURIComponent(subject)}/inputs`, {
      body: JSON.stringify({ inputs }),
      method: "PATCH",
    });
  }
  // Who hears when the project finishes: --to is a Feishu group (oc_…) or a
  // person's own chat (user:ou_…); --by is the requester's open_id (ou_…).
  if (resource === "projects" && action === "collaboration" && subject) {
    const file = option(input, "--file");
    const collaboration = file
      ? await readJson(file)
      : Object.fromEntries(Object.entries({
          sourceChatId: option(input, "--to"),
          createdByOpenId: option(input, "--by"),
        }).filter(([, value]) => value));
    if (Object.keys(collaboration).length === 0) {
      throw new Error("projects collaboration requires --to <oc_…|user:ou_…> [--by <ou_…>] or --file <json>");
    }
    return api(`/api/instances/${encodeURIComponent(subject)}/collaboration`, {
      body: JSON.stringify({ collaboration }),
      method: "PATCH",
    });
  }
  // 需要你: cards that stopped and wait on a person.
  if (resource === "decisions" && action === "list") {
    const params = new URLSearchParams();
    const instanceId = option(input, "--project");
    if (instanceId) params.set("instanceId", instanceId);
    params.set("status", option(input, "--status") ?? "open");
    return api(`/api/decisions?${params}`);
  }
  if (resource === "decisions" && action === "get" && subject) return api(`/api/decisions/${encodeURIComponent(subject)}`);
  if (resource === "decisions" && action === "decide" && subject) {
    const optionId = option(input, "--option");
    if (!optionId) throw new Error("decisions decide requires --option <retry|skip|pause|…>");
    return api(`/api/decisions/${encodeURIComponent(subject)}`, {
      body: JSON.stringify({
        optionId,
        note: option(input, "--note") ?? undefined,
        actor: option(input, "--actor") ?? "Night Shift operator",
        applyToGroup: input.includes("--apply-to-group"),
      }),
      method: "POST",
    });
  }
  if (resource === "operations" && ["reserve", "checkpoint"].includes(action) && subject) {
    if (action === "reserve") {
      const requestHash = option(input, "--request-hash");
      if (!/^[a-f0-9]{64}$/i.test(requestHash ?? "")) throw new Error("--request-hash must be a SHA-256 hex digest");
      return api(`/api/cards/${encodeURIComponent(subject)}/operations/reserve`, {
        body: JSON.stringify({ requestHash: requestHash.toLowerCase() }),
        method: "POST",
      });
    }
    const status = option(input, "--status");
    if (!status) throw new Error("--status is required");
    return api(`/api/cards/${encodeURIComponent(subject)}/operations/checkpoint`, {
      body: JSON.stringify({
        status,
        externalTaskId: option(input, "--external-task-id"),
        checkpoint: jsonOption(input, "--checkpoint-json"),
        result: jsonOption(input, "--result-json"),
      }),
      method: "POST",
    });
  }
  if (resource === "cards" && action === "list") {
    const status = option(input, "--status");
    return api(`/api/cards${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  }
  if (resource === "cards" && action === "session" && subject) {
    const runId = option(input, "--run-id");
    return api(`/api/cards/${encodeURIComponent(subject)}/session${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`);
  }
  if (resource === "cards" && action === "retry" && subject) {
    return api(`/api/cards/${encodeURIComponent(subject)}/retry`, {
      method: "POST",
      body: JSON.stringify({ actor: option(input, "--actor") ?? "V", note: option(input, "--note") ?? option(input, "--evidence") ?? null,
        allowNewOperation: input.includes("--allow-new-operation") }),
    });
  }
  if (resource === "cards" && ["approve", "changes", "reject"].includes(action) && subject) {
    const card = await findCard(subject);
    const automation = card.metadata?.automation ?? {};
    const instanceId = automation.instanceId ?? label(card, "instance");
    const contentItemId = automation.contentItemId ?? label(card, "content-item");
    const stageId = automation.stageId ?? label(card, "stage");
    const actor = option(input, "--actor") ?? "Night Shift operator";
    const evidence = option(input, "--evidence");
    if (!evidence) throw new Error("--evidence is required for a card decision or retry");
    const approval = automation.approval ?? {};
    const endpointAction = action === "changes" ? "request-changes" : action;
    return api(`/api/cards/${encodeURIComponent(subject)}/${endpointAction}`, {
      body: JSON.stringify({ actor, contentItemId, effect: approval.effect, evidence, instanceId, scope: approval.scope, stageId }),
      method: "POST",
    });
  }
  throw new Error("Usage: nightshiftctl health | workflows list|validate|import|publish | projects list|get|monitor|preflight|create|start|pause|archive|restore | projects concurrency <id> [<1-8>|default] [--reason <text>] | projects workflow <id> <version|latest> [--reason <text>] | projects priority <id> [<n>|first|last|default] [--reason <text>] | projects order <id> [<id> …] [--reason <text>] | projects queue | projects inputs <id> --file <json> | projects collaboration <id> --to <oc_…|user:ou_…> [--by <ou_…>] | decisions list [--project <id>] [--status open|decided] | decisions get <id> | decisions decide <id> --option <id> [--note <text>] [--apply-to-group] | governance audit [--refresh] | governance archive|restore <manifest.json> [--apply] | storage retention [--apply] | operations reserve|checkpoint <card-id> | cards list|session|approve|changes|reject|retry | cards retry <card-id> [--actor V] [--note <text>] [--allow-new-operation]");
}

async function resolveWorkflow(project) {
  if (project.workflowSha256) return project;
  if (!project.workflow) throw new Error("Project requires workflowSha256 or workflow=<id>@<version>");
  const split = project.workflow.lastIndexOf("@");
  const id = split > 0 ? project.workflow.slice(0, split) : project.workflow;
  const version = split > 0 ? project.workflow.slice(split + 1) : null;
  const result = await api("/api/workflows");
  const matches = result.workflows.filter((entry) => entry.workflowId === id && (!version || entry.version === version));
  if (matches.length === 0) throw new Error(`No published Workflow matches ${project.workflow}`);
  project.workflowSha256 = matches[0].workflowSha256;
  delete project.workflow;
  return project;
}

async function findCard(id) {
  const result = await api("/api/cards?refresh=1");
  const card = result.cards.find((entry) => entry.id === id);
  if (!card) throw new Error(`Unknown native Workboard card ${id}`);
  return card;
}

async function api(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const issues = Array.isArray(body.issues) ? body.issues.map((issue) => `${issue.path}: ${issue.message}`) : [];
    throw new Error([body.error ?? `Night Shift API returned HTTP ${response.status}`, ...issues].join("\n- "));
  }
  return body;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

function jsonOption(input, name) {
  const value = option(input, name);
  if (value === null) return undefined;
  return JSON.parse(value);
}

function option(input, name) {
  const index = input.indexOf(name);
  return index >= 0 ? input[index + 1] : null;
}

function label(card, prefix) {
  return card.labels?.find((entry) => entry.startsWith(`${prefix}:`))?.slice(prefix.length + 1) ?? null;
}

function supersededCards(project) {
  const runs = [
    ...(project.stageRuns ?? []).map((run) => ({ ...run, contentItemId: null })),
    ...(project.contentItemRuns ?? []),
  ];
  const key = (run) => `${run.stageId}:${run.contentItemId ?? "project"}`;
  const latest = new Map();
  for (const run of runs) latest.set(key(run), Math.max(latest.get(key(run)) ?? 0, run.attempt ?? 1));
  return new Set(runs.filter((run) => run.cardId && (run.attempt ?? 1) < latest.get(key(run))).map((run) => run.cardId));
}
