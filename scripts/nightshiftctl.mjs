#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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
  if (resource === "projects" && action === "list") return api("/api/instances");
  if (resource === "projects" && action === "get" && subject) return api(`/api/instances/${encodeURIComponent(subject)}`);
  if (resource === "projects" && action === "monitor" && subject) {
    const [project, cardsResult] = await Promise.all([
      api(`/api/instances/${encodeURIComponent(subject)}`),
      api("/api/cards?refresh=1"),
    ]);
    const cards = cardsResult.cards.filter((card) => label(card, "instance") === subject);
    return {
      project,
      summary: {
        active: cards.filter((card) => card.status === "running").length,
        blocked: cards.filter((card) => card.status === "blocked").length,
        done: cards.filter((card) => card.status === "done").length,
        queued: cards.filter((card) => ["ready", "todo", "planned"].includes(card.status)).length,
        review: cards.filter((card) => card.status === "review").length,
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
  if (resource === "projects" && action === "start" && subject) {
    return api(`/api/instances/${encodeURIComponent(subject)}/start`, { body: "{}", method: "POST" });
  }
  if (resource === "projects" && action === "pause" && subject) {
    return api(`/api/instances/${encodeURIComponent(subject)}/pause`, { body: "{}", method: "POST" });
  }
  if (resource === "cards" && action === "list") {
    const status = option(input, "--status");
    return api(`/api/cards${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  }
  if (resource === "cards" && action === "session" && subject) {
    const runId = option(input, "--run-id");
    return api(`/api/cards/${encodeURIComponent(subject)}/session${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`);
  }
  if (resource === "cards" && ["approve", "changes", "reject", "retry"].includes(action) && subject) {
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
  throw new Error("Usage: nightshiftctl health | workflows list|validate|import|publish | projects list|get|monitor|preflight|create|start|pause | cards list|session|approve|changes|reject|retry");
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
  if (!response.ok) throw new Error(body.error ?? `Night Shift API returned HTTP ${response.status}`);
  return body;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

function option(input, name) {
  const index = input.indexOf(name);
  return index >= 0 ? input[index + 1] : null;
}

function label(card, prefix) {
  return card.labels?.find((entry) => entry.startsWith(`${prefix}:`))?.slice(prefix.length + 1) ?? null;
}
