import { runSchedulerPass } from "../../../packages/nightshift-core/src/scheduler-pass.mjs";
import { tickWithFaultProjection } from "../../../packages/nightshift-core/src/scheduler-state.mjs";
import { createCompletionUrlChecker } from "./completion-url.mjs";
import { SchedulerCircuit } from "./scheduler-circuit.mjs";
import { HumanAttemptController, humanCompletionEvidence, publicHumanAttempt, evidenceHash } from "../../../packages/nightshift-core/src/human-attempt.mjs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublicAuth, requiresPublicAuth, verifyPublicAuth, resolveOperatorIdentity } from "./public-auth.mjs";
import { resolveCardDecisionContext } from "./decision-context.mjs";
import {
  deliverableArtifactPaths,
  findNightShiftExternalOperation,
  humanStageHandoff,
  NightShiftRuntime,
  NightShiftStore,
  normalizeArtifactPath,
  normalizeDeliverablesManifest,
  normalizeStageHandoff,
  presentStageHandoff,
  redactSensitiveInputs,
  requiredSkillsByRole,
  resolveNightShiftCardContext,
  resolveNightShiftOperationKeys,
  stageHandoffPath,
  validateDeclaredCompletion,
  validateExecutionEvidence,
  validateProjectRequest,
  WorkboardGatewayAdapter,
} from "../../../packages/nightshift-core/src/index.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const appRoot = resolve(here, "..");
const distRoot = resolve(appRoot, "dist");
const port = Number(process.env.NIGHTSHIFT_PORT ?? 24880);
const host = process.env.NIGHTSHIFT_HOST ?? "127.0.0.1";
const dataDir = resolve(process.env.NIGHTSHIFT_DATA_DIR ?? resolve(appRoot, "../../../tmp/nightshift"));
const workflowPath = resolve(
  process.env.NIGHTSHIFT_WORKFLOW_PATH ??
    resolve(appRoot, "../../examples/workflows/xingqing-content-delivery.workflow.md"),
);
const board = process.env.NIGHTSHIFT_BOARD ?? "nightshift-lab";
const publicHost = process.env.NIGHTSHIFT_PUBLIC_HOST ?? "";
const publicBaseUrl = process.env.NIGHTSHIFT_PUBLIC_BASE_URL ?? "";
const schedulerDispatchMaxStarts = positiveInteger(process.env.NIGHTSHIFT_DISPATCH_MAX_STARTS_PER_PASS, 36, 36);
const dispatchMaxStartsPerInstance = positiveInteger(process.env.NIGHTSHIFT_DISPATCH_MAX_STARTS_PER_INSTANCE, 8, 8);
const dispatchStartBurst = positiveInteger(process.env.NIGHTSHIFT_DISPATCH_START_BURST, 3, 8);
const dispatchStartIntervalMs = positiveInteger(process.env.NIGHTSHIFT_DISPATCH_START_INTERVAL_MS, 15_000, 60_000);
const schedulerMaxWorkboardActive = positiveInteger(process.env.NIGHTSHIFT_MAX_WORKBOARD_ACTIVE, 36, 36);
const schedulerFailureCooldownMs = positiveInteger(process.env.NIGHTSHIFT_SCHEDULER_FAILURE_COOLDOWN_MS, 300_000, 3_600_000);
const publicAuth = await loadPublicAuth(process.env.NIGHTSHIFT_BASIC_AUTH_FILE);
await mkdir(dataDir, { recursive: true });
const store = new NightShiftStore(join(dataDir, "nightshift.sqlite"));
const workboard = new WorkboardGatewayAdapter({
  board,
  startBurst: dispatchStartBurst,
  startIntervalMs: dispatchStartIntervalMs,
});
const runtime = new NightShiftRuntime({
  board,
  completionValidator: validateCompletion,
  dispatchMaxStarts: dispatchMaxStartsPerInstance,
  maxWorkboardActive: schedulerMaxWorkboardActive,
  store,
  workboard,
});
const humanAttempts = new HumanAttemptController({ store, workboard, validateCompletion });
const checkCompletionUrl = createCompletionUrlChecker();
let cardCache = [];
let cardsUpdatedAt = null;
let cardRefreshPromise = null;
let lastSchedulerAt = null;
let schedulerStartedAt = null;
let lastSchedulerDurationMs = null;
let lastSchedulerError = null;
let schedulerPromise = null;
const schedulerCircuit = new SchedulerCircuit({ cooldownMs: schedulerFailureCooldownMs, startWithProbe: true });
let tickQueue = Promise.resolve();
let shuttingDown = false;
const contentManifestHashes = new Map();

await ensureWorkflow();
await ensureSeedInstance();
const schedulerTimer = setInterval(() => {
  runScheduler();
}, 30000);
schedulerTimer.unref();
const initialSchedulerTimer = setTimeout(() => runScheduler(), 1000);
initialSchedulerTimer.unref();

const server = createServer(async (request, response) => {
  try {
    if (requiresPublicAuth(request, publicHost) && !verifyPublicAuth(request.headers.authorization, publicAuth)) {
      response.writeHead(401, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="Night Shift", charset="UTF-8"',
      });
      response.end("Authentication required");
      return;
    }
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    json(response, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Night Shift Workboard listening on http://${host}:${port}`);
});

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    const circuit = schedulerCircuit.snapshot();
    json(response, 200, {
      board,
      cardsUpdatedAt,
      lastSchedulerAt,
      lastSchedulerError,
      schedulerStartedAt,
      schedulerRunning: Boolean(schedulerPromise),
      lastSchedulerDurationMs,
      schedulerDispatchMaxStarts,
      dispatchMaxStartsPerInstance,
      dispatchStartBurst,
      dispatchStartIntervalMs,
      schedulerMaxWorkboardActive,
      schedulerFailureCooldownMs,
      schedulerCircuitOpen: circuit.open,
      schedulerCircuitOpenUntil: circuit.openUntil,
      schedulerCircuitProbeRequired: circuit.probeRequired,
      schedulerCircuitReason: circuit.reason,
      ok: Boolean(lastSchedulerAt) && !lastSchedulerError && Date.now() - Date.parse(lastSchedulerAt) < 90000,
      service: "nightshift-workboard",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    if (url.searchParams.get("refresh") === "1") await refreshCards();
    const instances = store.listInstances().filter((instance) => instance.status !== "archived").map((instance) => ({
      ...instance,
      contentItems: store.listContentItems(instance.id),
      contentItemRuns: store.listContentItemRuns(instance.id),
      stageRuns: store.listStageRuns(instance.id),
    }));
    json(response, 200, {
      board,
      cards: visibleCards(cardCache, instances).map(withCardLinks),
      cardsUpdatedAt,
      events: store.listEvents(null, 80),
      instances: instances.map(withInstanceLinks),
      links: dashboardLinks(),
      workflows: store.listReleases().map(withWorkflowLinks),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/workflows") {
    json(response, 200, {
      workflows: store.listReleases().map((release) => ({
        name: release.name,
        publishedAt: release.publishedAt,
        version: release.version,
        workflowId: release.workflowId,
        workflowSha256: release.workflowSha256,
        links: workflowLinks(release),
      })),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/instances") {
    json(response, 200, {
      instances: store.listInstances().filter((instance) => instance.status !== "archived").map((instance) => withInstanceLinks({
        ...instance,
        contentItemCount: store.listContentItems(instance.id).length,
        contentItemRuns: store.listContentItemRuns(instance.id),
        stageRuns: store.listStageRuns(instance.id),
      })),
    });
    return;
  }
  const instanceReadMatch = url.pathname.match(/^\/api\/instances\/([^/]+)$/);
  if (request.method === "GET" && instanceReadMatch) {
    const instanceId = decodeURIComponent(instanceReadMatch[1]);
    const instance = store.getInstance(instanceId);
    if (!instance) {
      json(response, 404, { error: "Project not found" });
      return;
    }
    json(response, 200, {
      ...withInstanceLinks(instance),
      contentItems: store.listContentItems(instanceId),
      contentItemRuns: store.listContentItemRuns(instanceId),
      stageRuns: store.listStageRuns(instanceId),
    });
    return;
  }
  if (request.method === "DELETE" && instanceReadMatch) {
    const instanceId = decodeURIComponent(instanceReadMatch[1]);
    const instance = store.getInstance(instanceId);
    if (!instance || instance.status === "archived") {
      json(response, 404, { error: "Project not found" });
      return;
    }
    const projectCards = cardCache.filter((card) => cardInstanceId(card) === instanceId);
    const running = projectCards.filter((card) => card.status === "running");
    if (running.length > 0) {
      json(response, 409, { error: `项目仍有 ${running.length} 个 Agent 正在工作，请等待完成或先暂停项目` });
      return;
    }
    for (const card of projectCards.filter((entry) => !["done", "cancelled"].includes(entry.status))) {
      await workboard.moveCard(card.id, "cancelled");
    }
    const archived = store.archiveInstance(instanceId);
    refreshCards().catch((error) => {
      lastSchedulerError = error.message;
    });
    json(response, 200, { id: archived.id, status: archived.status });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/cards") {
    const cards = url.searchParams.get("refresh") === "1" ? await refreshCards() : cardCache;
    const status = url.searchParams.get("status");
    const instances = store.listInstances().filter((instance) => instance.status !== "archived");
    const filtered = visibleCards(cards, instances);
    json(response, 200, { cards: (status ? filtered.filter((card) => card.status === status) : filtered).map(withCardLinks) });
    return;
  }
  const stageHandoffMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/stages\/([^/]+)\/handoff$/);
  if (request.method === "GET" && stageHandoffMatch) {
    const instanceId = decodeURIComponent(stageHandoffMatch[1]);
    const stageId = decodeURIComponent(stageHandoffMatch[2]);
    const contentItemId = url.searchParams.get("contentItemId");
    const instance = store.getInstance(instanceId);
    if (!instance) {
      json(response, 404, { error: "Project not found" });
      return;
    }
    const release = store.getRelease(instance.workflowSha256)?.manifest;
    if (!release?.spec?.stages?.some((entry) => entry.id === stageId)) {
      json(response, 404, { error: "Workflow stage not found" });
      return;
    }
    const runs = contentItemId ? store.listContentItemRuns(instanceId) : store.listStageRuns(instanceId);
    const run = runs.filter((entry) => entry.stageId === stageId && (contentItemId ? entry.contentItemId === contentItemId : true)).at(-1);
    const manifest = await loadStageHandoff({ contentItemId, instance, release, stageId });
    json(response, 200, presentStageHandoff({ completed: run?.status === "done", manifest, release, stageId }));
    return;
  }
  const cardSessionMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/session$/);
  if (request.method === "GET" && cardSessionMatch) {
    const cardId = decodeURIComponent(cardSessionMatch[1]);
    const card = cardCache.find((entry) => entry.id === cardId) ?? (await refreshCards()).find((entry) => entry.id === cardId);
    if (!card) {
      json(response, 404, { error: "Workboard card not found" });
      return;
    }
    const attempts = nativeCardAttempts(card);
    const requestedRunId = url.searchParams.get("runId");
    const attempt = requestedRunId
      ? attempts.find((entry) => entry.runId === requestedRunId)
      : attempts.at(-1);
    if (!attempt?.sessionKey) {
      json(response, 404, { error: "This Workboard card has no Agent Session" });
      return;
    }
    // Native Workboard retries reuse the same OpenClaw session. A large history
    // can exceed the Gateway CLI response timeout before we apply the attempt
    // time-range filter, so keep the RPC window bounded to recent run traffic.
    const result = await workboard.getSession(attempt.sessionKey, { limit: 80 });
    const nextAttempt = attempts.find((entry) => Number(entry.startedAt) > Number(attempt.startedAt));
    const rangeStart = Number(attempt.startedAt || 0) - 5000;
    const rangeEnd = Number(attempt.endedAt || nextAttempt?.startedAt || Number.POSITIVE_INFINITY) + 5000;
    const messages = (result.messages ?? [])
      .filter((message) => !message.timestamp || (Number(message.timestamp) >= rangeStart && Number(message.timestamp) <= rangeEnd))
      .map(presentSessionMessage);
    json(response, 200, {
      attempt: presentAttempt(attempt),
      cardId,
      messages,
      runId: attempt.runId,
      sessionKey: attempt.sessionKey,
    });
    return;
  }
  const deliverablesMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/deliverables$/);
  if (request.method === "GET" && deliverablesMatch) {
    const instanceId = decodeURIComponent(deliverablesMatch[1]);
    try {
      const manifest = await loadDeliverables(instanceId);
      json(response, 200, await presentDeliverables(manifest));
    } catch (error) {
      if (error.code === "ENOENT") json(response, 404, { error: "No delivery package has been published for this project" });
      else throw error;
    }
    return;
  }
  const itemDeliverablesMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/content-items\/([^/]+)\/deliverables$/);
  if (request.method === "GET" && itemDeliverablesMatch) {
    const instanceId = decodeURIComponent(itemDeliverablesMatch[1]);
    const contentItemId = decodeURIComponent(itemDeliverablesMatch[2]);
    try {
      const manifest = await loadDeliverables(instanceId, contentItemId);
      json(response, 200, await presentDeliverables(manifest, contentItemId));
    } catch (error) {
      if (error.code === "ENOENT") json(response, 404, { error: "No delivery package has been published for this video task" });
      else throw error;
    }
    return;
  }
  const artifactMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/artifacts\/(.+)$/);
  if ((request.method === "GET" || request.method === "HEAD") && artifactMatch) {
    const instanceId = decodeURIComponent(artifactMatch[1]);
    const relativePath = decodeURIComponent(artifactMatch[2]);
    await serveDeliverableArtifact(request, response, instanceId, relativePath);
    return;
  }
  const itemArtifactMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/content-items\/([^/]+)\/artifacts\/(.+)$/);
  if ((request.method === "GET" || request.method === "HEAD") && itemArtifactMatch) {
    await serveDeliverableArtifact(
      request,
      response,
      decodeURIComponent(itemArtifactMatch[1]),
      decodeURIComponent(itemArtifactMatch[3]),
      decodeURIComponent(itemArtifactMatch[2]),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/workflows/validate") {
    const body = await bodyJson(request);
    const result = runtime.validate(body.sourceMarkdown ?? body.sourceYaml ?? "");
    json(response, 200, { issues: result.issues, ok: result.ok });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/workflows/draft") {
    const body = await bodyJson(request);
    json(response, 200, runtime.saveDraft(body.sourceMarkdown ?? body.sourceYaml ?? ""));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/workflows/publish") {
    const body = await bodyJson(request);
    json(response, 200, withWorkflowLinks(runtime.publish(body.sourceMarkdown ?? body.sourceYaml ?? "")));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/workflows/import") {
    const body = await bodyJson(request);
    const source = body.sourceMarkdown ?? body.sourceYaml ?? "";
    const validation = runtime.validate(source);
    if (!validation.ok) {
      json(response, 422, { error: "Workflow validation failed", issues: validation.issues });
      return;
    }
    const draft = runtime.saveDraft(source);
    const release = body.publish === false ? null : withWorkflowLinks(runtime.publish(source));
    json(response, release ? 201 : 200, { draft, release });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/instances/preflight") {
    const body = await bodyJson(request);
    const release = store.getRelease(body.workflowSha256);
    try {
      validateProjectRequest(release?.manifest, body);
      const preflight = await preflightProjectSkills(release.manifest, body);
      json(response, preflight.ok ? 200 : 422, preflight.ok ? preflight : { ...preflight, error: "Required Night Shift Skills are unavailable" });
    } catch (error) {
      json(response, 422, { error: error.message, ok: false });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/instances") {
    const body = await bodyJson(request);
    const release = store.getRelease(body.workflowSha256);
    validateProjectRequest(release?.manifest, body);
    const preflight = await preflightProjectSkills(release.manifest, body);
    if (!preflight.ok) {
      json(response, 422, { ...preflight, error: "Required Night Shift Skills are unavailable" });
      return;
    }
    if (body.automaticDispatch !== undefined && typeof body.automaticDispatch !== "boolean") throw new Error("automaticDispatch must be a boolean");
    const created = await startInstance(body);
    if (body.automaticDispatch === false) store.setInstanceControl(created.id, { automaticDispatch: false });
    let initialSchedule = null;
    let initialScheduleError = null;
    if (created.status === "active") {
      try {
        const scheduled = await serializedTick(created.id, { dispatch: body.dispatch !== false });
        initialSchedule = {
          actionCount: scheduled.actions.length,
          cardIds: scheduled.applied.map((entry) => entry.card?.id).filter(Boolean),
          dispatched: body.dispatch !== false && store.getInstanceControl(created.id).automaticDispatch,
        };
        await refreshCards();
      } catch (error) {
        initialScheduleError = error.message;
      }
    }
    json(response, 201, {
      ...store.getInstance(created.id),
      initialSchedule,
      initialScheduleError,
      links: projectLinks(created.id),
      preflight,
    });
    return;
  }
  const instanceInputMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/inputs$/);
  const instanceLifecycleMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/(start|pause)$/);
  if (request.method === "POST" && instanceLifecycleMatch) {
    const instanceId = decodeURIComponent(instanceLifecycleMatch[1]);
    const instance = store.getInstance(instanceId);
    if (!instance) {
      json(response, 404, { error: "Project not found" });
      return;
    }
    if (instanceLifecycleMatch[2] === "pause") {
      json(response, 200, store.updateInstanceStatus(instanceId, "paused"));
      return;
    }
    store.updateInstanceStatus(instanceId, "active");
    const result = await serializedTick(instanceId, { dispatch: true, dryRun: false });
    await refreshCards();
    json(response, 200, { instance: store.getInstance(instanceId), schedule: result });
    return;
  }
  if (request.method === "PATCH" && instanceInputMatch) {
    const body = await bodyJson(request);
    const updated = runtime.updateInstanceInputs(
      decodeURIComponent(instanceInputMatch[1]),
      body.inputs ?? {},
    );
    await writeProjectInputsSnapshot(updated);
    json(response, 200, updated);
    return;
  }
  const contentItemsMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/content-items$/);
  if (request.method === "PUT" && contentItemsMatch) {
    const body = await bodyJson(request);
    json(response, 200, {
      contentItems: runtime.setContentItems(
        decodeURIComponent(contentItemsMatch[1]),
        body.contentItems ?? [],
      ),
    });
    return;
  }
  const tickMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/tick$/);
  if (request.method === "POST" && tickMatch) {
    const body = await bodyJson(request);
    const result =
      await serializedTick(decodeURIComponent(tickMatch[1]), {
        dispatch: body.dispatch === true,
        dryRun: body.dryRun === true,
      });
    if (!body.dryRun) await refreshCards();
    json(
      response,
      200,
      result,
    );
    return;
  }
  const operationMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/operations\/(reserve|checkpoint)$/);
  if (request.method === "POST" && operationMatch) {
    const cardId = decodeURIComponent(operationMatch[1]);
    const card = cardCache.find((entry) => entry.id === cardId) ?? (await refreshCards()).find((entry) => entry.id === cardId);
    if (!card) {
      json(response, 404, { error: "Workboard card not found" });
      return;
    }
    const coordinates = resolveNightShiftCardContext({ card });
    const instance = coordinates.instanceId ? store.getInstance(coordinates.instanceId) : null;
    const release = instance ? store.getRelease(instance.workflowSha256)?.manifest : null;
    if (!instance || !release) {
      json(response, 422, { error: "Card is not linked to a pinned Night Shift project" });
      return;
    }
    const context = resolveNightShiftCardContext({ card, release });
    if (context.sideEffects.length === 0) {
      json(response, 422, { error: "Card does not declare an external side effect" });
      return;
    }
    const contentItem = context.contentItemId
      ? store.listContentItems(instance.id).find((entry) => entry.id === context.contentItemId)
      : null;
    if (context.contentItemId && !contentItem) {
      json(response, 422, { error: "Card references an unknown Night Shift content item" });
      return;
    }
    const operationKeys = resolveNightShiftOperationKeys({ card, release, instance, contentItem });
    const existingOperation = findNightShiftExternalOperation({
      card,
      candidateIdempotencyKeys: operationKeys.candidateIdempotencyKeys,
      operations: store.listExternalOperations(instance.id),
    });
    const idempotencyKey = existingOperation?.idempotencyKey ?? operationKeys.preferredIdempotencyKey;
    const body = await bodyJson(request);
    if (operationMatch[2] === "reserve") {
      if (!/^[a-f0-9]{64}$/i.test(body.requestHash ?? "")) {
        json(response, 422, { error: "requestHash must be a SHA-256 hex digest" });
        return;
      }
      json(response, 200, store.reserveExternalOperation({
        idempotencyKey,
        instanceId: context.instanceId,
        contentItemId: context.contentItemId,
        stageId: context.stageId,
        ownerCardId: cardId,
        requestHash: body.requestHash.toLowerCase(),
      }));
      return;
    }
    const operation = store.getExternalOperation(idempotencyKey);
    if (!operation || operation.ownerCardId !== cardId) {
      json(response, 409, { error: "Reserve this external operation before checkpointing it" });
      return;
    }
    json(response, 200, store.checkpointExternalOperation(idempotencyKey, {
      status: body.status,
      externalTaskId: body.externalTaskId,
      checkpoint: body.checkpoint,
      result: body.result,
    }));
    return;
  }
  const decisionMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/(approve|request-changes|reject)$/);
  if (request.method === "POST" && url.pathname === "/api/cards/bulk/approve") {
    const body = await bodyJson(request);
    const cardIds = [...new Set(Array.isArray(body.cardIds) ? body.cardIds : [])];
    if (cardIds.length === 0 || cardIds.length > 100 || cardIds.some((id) => typeof id !== "string" || !id.trim())) {
      json(response, 422, { error: "cardIds must contain between 1 and 100 card IDs" });
      return;
    }
    const cards = await refreshCards();
    const decisions = cardIds.map((cardId) => {
      const card = cards.find((entry) => entry.id === cardId);
      if (!card) throw new Error(`Workboard card not found: ${cardId}`);
      if (card.status !== "review") throw new Error(`Card is not waiting for review: ${cardId}`);
      return { card, input: decisionInput({ body, card }) };
    });
    const results = [];
    for (const decision of decisions) {
      try {
        const result = await runtime.approve(decision.input);
        await recordHumanStageHandoff(decision.input);
        results.push({ cardId: decision.card.id, ok: true, status: result.status });
      } catch (error) {
        results.push({ cardId: decision.card.id, error: error.message, ok: false });
      }
    }
    await refreshCards();
    const failed = results.filter((entry) => !entry.ok);
    json(response, failed.length ? 207 : 200, { approved: results.length - failed.length, failed: failed.length, ok: failed.length === 0, results });
    return;
  }
  if (request.method === "POST" && decisionMatch) {
    const body = await bodyJson(request);
    const cardId = decodeURIComponent(decisionMatch[1]);
    const card = cardCache.find((entry) => entry.id === cardId) ?? (await refreshCards()).find((entry) => entry.id === cardId);
    if (!card) {
      json(response, 404, { error: "Workboard card not found" });
      return;
    }
    const input = decisionInput({ body, card });
    const result = decisionMatch[2] === "approve"
      ? await runtime.approve(input)
      : decisionMatch[2] === "request-changes"
        ? await runtime.requestChanges(input)
        : await runtime.reject(input);
    if (decisionMatch[2] === "approve") await recordHumanStageHandoff(input);
    await refreshCards();
    json(response, 200, result);
    return;
  }
  const controlMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/dispatch-control$/);
  if (request.method === "POST" && controlMatch) {
    const instanceId = decodeURIComponent(controlMatch[1]);
    const body = await bodyJson(request);
    const actor = operatorIdentity(request, body);
    if (!store.getInstance(instanceId) || typeof body.automaticDispatch !== "boolean") throw new Error("Project and automaticDispatch boolean are required");
    const result = await serializedOperation(async () => {
      const control = store.setInstanceControl(instanceId, { automaticDispatch: body.automaticDispatch });
      store.appendEvent({ instanceId, type: "dispatch.control.changed", payload: { actor, automaticDispatch: body.automaticDispatch } });
      return control;
    });
    json(response, 200, result);
    return;
  }
  const takeoverMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/cards\/([^/]+)\/human-(takeover|complete)$/);
  if (request.method === "POST" && takeoverMatch) {
    const body = await bodyJson(request);
    const input = { instanceId: decodeURIComponent(takeoverMatch[1]), cardId: decodeURIComponent(takeoverMatch[2]), actor: operatorIdentity(request, body), reason: body.reason };
    const result = await serializedOperation(() => takeoverMatch[3] === "takeover" ? humanAttempts.takeover(input) : humanAttempts.complete(input));
    if (takeoverMatch[3] === "complete") await serializedTick(input.instanceId, { dispatch: false });
    await refreshCards();
    json(response, 200, result);
    return;
  }
  const scheduleRetryMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/retry-dispatch$/);
  if (request.method === "POST" && scheduleRetryMatch) {
    const body = await bodyJson(request);
    const instanceId = decodeURIComponent(scheduleRetryMatch[1]);
    const actor = operatorIdentity(request, body);
    if (!store.getInstanceControl(instanceId).automaticDispatch) throw new Error("Automatic dispatch is disabled for this project");
    store.appendEvent({ instanceId, type: "dispatch.retry.requested", payload: { actor } });
    const result = await serializedTick(instanceId, { dispatch: true });
    await refreshCards();
    json(response, 200, result);
    return;
  }
  const retryMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryMatch) {
    const body = await bodyJson(request);
    const result = await runtime.retry({ ...body, cardId: decodeURIComponent(retryMatch[1]) });
    await refreshCards();
    json(response, 200, result);
    return;
  }
  json(response, 404, { error: "Not found" });
}

function operatorIdentity(request, body) {
  return resolveOperatorIdentity({ authorization: request.headers.authorization, remoteAddress: request.socket.remoteAddress, actor: body.actor, auth: publicAuth });
}

function decisionInput({ body, card }) {
  const baseInput = resolveCardDecisionContext({ body, card });
  const instance = baseInput.instanceId ? store.getInstance(baseInput.instanceId) : null;
  const release = instance ? store.getRelease(instance.workflowSha256)?.manifest : null;
  return resolveCardDecisionContext({ body, card, instance, release });
}

async function ensureWorkflow() {
  const source = await readFile(workflowPath, "utf8");
  runtime.saveDraft(source);
  runtime.publish(source);
}

async function ensureSeedInstance() {
  const seedPath = process.env.NIGHTSHIFT_SEED_INSTANCE_PATH;
  if (!seedPath || store.listInstances().length > 0) return;
  const seed = JSON.parse(await readFile(resolve(seedPath), "utf8"));
  const release = store.listReleases()[0];
  await startInstance({ ...seed, workflowSha256: release.workflowSha256 });
}

function runScheduler() {
  if (schedulerPromise) return schedulerPromise;
  const circuitDecision = schedulerCircuit.beforePass();
  if (!circuitDecision.run) return Promise.resolve({ skipped: "scheduler-circuit-open", ...circuitDecision });
  schedulerPromise = (async () => {
    schedulerStartedAt = new Date().toISOString();
    const started = Date.now();
    // One serialized round shares one authoritative board snapshot. API mutations
    // cannot interleave a takeover with a later tick using an older snapshot.
    const result = await serializedOperation(() => runSchedulerPass({
      dispatchMaxStarts: schedulerDispatchMaxStarts,
      dispatchEnabled: circuitDecision.dispatch,
      store, runtime, workboard, refreshCards, syncContentItemsManifest,
    }));
    lastSchedulerAt = new Date().toISOString();
    lastSchedulerDurationMs = Date.now() - started;
    lastSchedulerError = result.warnings.length ? result.warnings.join("; ") : null;
    schedulerCircuit.recordPass(result.warnings, { probe: circuitDecision.probe });
  })().catch((error) => {
    lastSchedulerAt = new Date().toISOString();
    lastSchedulerError = error.message;
    schedulerCircuit.recordFailure(error.message);
    console.error(`Night Shift scheduler failed: ${error.message}`);
  }).finally(() => {
    schedulerPromise = null;
  });
  return schedulerPromise;
}

async function startInstance(instance) {
  assertInstanceId(instance.id);
  const instanceDir = resolve(dataDir, "instances", instance.id);
  await mkdir(instanceDir, { recursive: true });
  const prepared = {
    ...instance,
    inputs: {
      ...(instance.inputs ?? {}),
      nightshift: {
        instanceDir,
        contentItemsManifestPath: join(instanceDir, "content-items.json"),
        projectInputsPath: join(instanceDir, "project-inputs.json"),
      },
    },
  };
  await writeProjectInputsSnapshot(prepared);
  return runtime.startInstance(prepared);
}

async function writeProjectInputsSnapshot(instance) {
  const snapshotPath = instance.inputs?.nightshift?.projectInputsPath;
  if (!snapshotPath) return;
  await mkdir(dirname(snapshotPath), { recursive: true });
  const temporaryPath = `${snapshotPath}.tmp`;
  const snapshot = {
    version: 1,
    instanceId: instance.id,
    inputs: redactSensitiveInputs(instance.inputs ?? {}),
  };
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, snapshotPath);
}

async function preflightProjectSkills(release, project) {
  const agents = [];
  for (const [role, requiredSkills] of Object.entries(requiredSkillsByRole(release, project.inputs ?? {}))) {
    const agentId = project.agentBindings?.[role];
    const status = await workboard.getSkillsStatus(agentId);
    const available = new Set(
      (status.skills ?? [])
        .filter((skill) => skill.eligible === true && skill.disabled !== true)
        .map((skill) => skill.name),
    );
    agents.push({
      agentId,
      missingSkills: requiredSkills.filter((skill) => !available.has(skill)),
      requiredSkills,
      role,
    });
  }
  return {
    agents,
    ok: agents.every((entry) => entry.missingSkills.length === 0),
    workflowSha256: release.metadata.workflowSha256,
  };
}

async function syncContentItemsManifest(instance) {
  const manifestPath = join(dataDir, "instances", instance.id, "content-items.json");
  let source;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const digest = createHash("sha256").update(source).digest("hex");
  if (contentManifestHashes.get(instance.id) === digest) return;
  const parsed = JSON.parse(source);
  runtime.setContentItems(instance.id, Array.isArray(parsed) ? parsed : parsed.contentItems);
  contentManifestHashes.set(instance.id, digest);
}

function serializedOperation(operation) {
  const run = tickQueue.catch(() => undefined).then(operation);
  tickQueue = run.catch(() => undefined);
  return run;
}

function serializedTick(instanceId, options) {
  return serializedOperation(() => tickWithFaultProjection({ instanceId, options, runtime, store, workboard }));
}

function positiveInteger(value, fallback, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

async function refreshCards() {
  if (cardRefreshPromise) return cardRefreshPromise;
  cardRefreshPromise = workboard.listCards().then((cards) => {
    cardCache = cards;
    cardsUpdatedAt = new Date().toISOString();
    return cards;
  }).finally(() => {
    cardRefreshPromise = null;
  });
  return cardRefreshPromise;
}

async function bodyJson(request) {
  let value = "";
  for await (const chunk of request) {
    value += chunk;
    if (value.length > 1024 * 1024) throw new Error("Request body is too large");
  }
  return value ? JSON.parse(value) : {};
}

async function loadDeliverables(instanceId, contentItemId = null) {
  assertInstanceId(instanceId);
  if (contentItemId) assertInstanceId(contentItemId);
  const manifestPath = contentItemId
    ? resolve(dataDir, "instances", instanceId, "content-items", contentItemId, "deliverables.json")
    : resolve(dataDir, "instances", instanceId, "deliverables.json");
  const source = JSON.parse(await readFile(manifestPath, "utf8"));
  return normalizeDeliverablesManifest(source, { instanceId, contentItemId });
}

async function validateCompletion({ card, contentItemId, instance, release, stageId, submittedAttempt }) {
  const stage = release?.spec?.stages?.find((entry) => entry.id === stageId);
  const evidence = {};
  const human = humanCompletionEvidence({ store, card, instance, stageId, contentItemId, submittedAttempt });
  if (human) evidence.humanAttempt = human;
  if (stage?.actor === "agent" && !human) {
    const attempt = nativeCardAttempts(card).at(-1);
    if (!attempt?.sessionKey || !attempt.runId) throw new Error("Agent completion requires an auditable Workboard Session and runId");
    const result = await workboard.getSession(attempt.sessionKey, { limit: 120 });
    const rangeStart = Number(attempt.startedAt || 0) - 5000;
    const rangeEnd = Number(attempt.endedAt || Number.POSITIVE_INFINITY) + 5000;
    const messages = (result.messages ?? []).filter((message) =>
      !message.timestamp || (Number(message.timestamp) >= rangeStart && Number(message.timestamp) <= rangeEnd));
    evidence.execution = validateExecutionEvidence({
      cardId: card.id,
      messages,
      requiredSkills: card.metadata?.automation?.skills ?? [],
    });
    evidence.sessionKey = attempt.sessionKey;
    evidence.runId = attempt.runId;
  }
  if ((stage?.sideEffects ?? []).length > 0) {
    const contentItem = contentItemId
      ? store.listContentItems(instance.id).find((entry) => entry.id === contentItemId)
      : null;
    const operationKeys = resolveNightShiftOperationKeys({ card, release, instance, contentItem });
    const operation = findNightShiftExternalOperation({
      card,
      candidateIdempotencyKeys: operationKeys.candidateIdempotencyKeys,
      operations: store.listExternalOperations(instance.id),
    });
    if (!operation || operation.ownerCardId !== card.id || operation.status !== "succeeded") {
      throw new Error("External side effect has no succeeded Night Shift operation checkpoint");
    }
    evidence.externalOperation = {
      externalTaskId: operation.externalTaskId,
      idempotencyKey: operation.idempotencyKey,
      requestHash: operation.requestHash,
      status: operation.status,
    };
  }
  let handoff = null;
  if (release?.spec?.handoff?.version === 1) {
    const manifest = await loadStageHandoff({ contentItemId, instance, release, stageId, required: true });
    handoff = normalizeStageHandoff(manifest, { contentItemId, instanceId: instance.id, release, stageId });
  }
  if (release?.spec?.completion?.mode === "strict-v1") {
    evidence.outputs = (await validateDeclaredCompletion({
      checkUrl: checkCompletionUrl,
      instanceCreatedAt: instance.createdAt,
      loadArtifact: async (artifact) => {
        const loaded = await loadInstanceArtifact({ artifact, contentItemId, instance, hash: Boolean(human) });
        if (human) (evidence.artifacts ??= []).push({ artifact, sha256: loaded.sha256 });
        return loaded;
      },
      manifest: handoff,
      stage,
    })).output;
  }
  if (handoff) evidence.handoff = handoff;
  if (!stage?.outputs?.includes("deliveryManifest")) return checkedCompletionEvidence(card, evidence);
  if (!contentItemId) throw new Error("deliveryManifest completion requires a content item");
  const manifest = await loadDeliverables(instance.id, contentItemId);
  if (!manifest.video.sha256) throw new Error("deliveryManifest video.sha256 is required");
  for (const relativePath of deliverableArtifactPaths(manifest)) {
    const filePath = await resolveDeclaredArtifact(manifest, relativePath, contentItemId);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`Declared artifact is not a file: ${relativePath}`);
  }
  const videoPath = await resolveDeclaredArtifact(manifest, manifest.video.path, contentItemId);
  const actualSha = await sha256File(videoPath);
  if (actualSha !== manifest.video.sha256) throw new Error("deliveryManifest video.sha256 does not match the file");
  const contentItem = store.listContentItems(instance.id).find((entry) => entry.id === contentItemId);
  if (contentItem?.route === "SCENE_EDIT") evidence.duplicateCheck = await validateDuplicateCheck(manifest, contentItemId);
  evidence.deliveryManifest = { sha256: actualSha, videoPath: manifest.video.path };
  return checkedCompletionEvidence(card, evidence);
}

function checkedCompletionEvidence(card, evidence) {
  const attempt = store.getHumanAttempt(card.id);
  if (attempt?.evidenceSha256 && attempt.evidenceSha256 !== evidenceHash(evidence)) {
    throw new Error("Validated human completion evidence changed");
  }
  return evidence;
}

async function validateDuplicateCheck(manifest, contentItemId) {
  const declared = manifest.qc.duplicateCheck;
  if (!declared?.reportPath) throw new Error("SCENE_EDIT completion requires qc.duplicateCheck.reportPath");
  const reportPath = await resolveDeclaredArtifact(manifest, declared.reportPath, contentItemId);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (declared.status !== "passed" || report.status !== "passed") {
    throw new Error("SCENE_EDIT temporal duplicate check did not pass");
  }
  for (const field of ["threshold", "maxDuplicateRatio", "duplicateRatio"]) {
    if (!Number.isFinite(Number(declared[field])) || Number(declared[field]) !== Number(report[field])) {
      throw new Error(`Duplicate check ${field} does not match its report`);
    }
  }
  if (!declared.method || declared.method !== report.method) throw new Error("Duplicate check method does not match its report");
  if (!Number.isInteger(declared.comparedPairs) || declared.comparedPairs < 1 || declared.comparedPairs !== report.comparedPairs) {
    throw new Error("Duplicate check must report at least one real comparison");
  }
  if (declared.duplicateRatio > declared.maxDuplicateRatio) throw new Error("SCENE_EDIT duplicate ratio exceeds the allowed maximum");
  return {
    comparedPairs: declared.comparedPairs,
    duplicateRatio: declared.duplicateRatio,
    maxDuplicateRatio: declared.maxDuplicateRatio,
    method: declared.method,
    reportPath: declared.reportPath,
    status: declared.status,
  };
}

async function loadInstanceArtifact({ artifact, contentItemId = null, instance, hash = false }) {
  const normalizedPath = normalizeArtifactPath(artifact);
  const configuredRoot = instance.inputs?.nightshift?.instanceDir ?? resolve(dataDir, "instances", instance.id);
  const instanceRoot = await realpath(configuredRoot);
  const roots = contentItemId ? [resolve(instanceRoot, "content-items", contentItemId), instanceRoot] : [instanceRoot];
  let candidate = null;
  for (const root of roots) {
    try {
      const resolved = await realpath(resolve(root, normalizedPath));
      if (resolved.startsWith(`${instanceRoot}${sep}`)) { candidate = resolved; break; }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!candidate) throw new Error(`Completion artifact not found: ${normalizedPath}`);
  const info = await stat(candidate);
  if (!info.isFile()) throw new Error("Completion artifact is not a file");
  const sha256 = hash ? await sha256File(candidate) : undefined;
  const extension = extname(candidate).toLowerCase();
  if (extension === ".json") return { exists: true, json: JSON.parse(await readFile(candidate, "utf8")), mtimeMs: info.mtimeMs, sha256 };
  if ([".md", ".markdown", ".txt", ".yaml", ".yml"].includes(extension)) return { exists: true, mtimeMs: info.mtimeMs, text: await readFile(candidate, "utf8"), sha256 };
  return { exists: true, mtimeMs: info.mtimeMs, sha256 };
}

async function loadStageHandoff({ contentItemId = null, instance, release, required = false, stageId }) {
  const instanceDir = instance.inputs?.nightshift?.instanceDir ?? resolve(dataDir, "instances", instance.id);
  const manifestPath = stageHandoffPath({ instanceDir, contentItemId, release, stageId });
  try {
    const source = JSON.parse(await readFile(manifestPath, "utf8"));
    return normalizeStageHandoff(source, { contentItemId, instanceId: instance.id, release, stageId });
  } catch (error) {
    if (error.code === "ENOENT" && !required) return null;
    if (error.code === "ENOENT") throw new Error(`Stage handoff is required: ${stageId}`);
    throw error;
  }
}

async function recordHumanStageHandoff({ actor, cardId, contentItemId = null, evidence, instanceId, stageId }) {
  const instance = store.getInstance(instanceId);
  const release = instance ? store.getRelease(instance.workflowSha256)?.manifest : null;
  const stage = release?.spec?.stages?.find((entry) => entry.id === stageId);
  if (!instance || !release || stage?.actor !== "human" || release.spec?.handoff?.version !== 1) return;
  const instanceDir = instance.inputs?.nightshift?.instanceDir ?? resolve(dataDir, "instances", instance.id);
  const manifestPath = stageHandoffPath({ instanceDir, contentItemId, release, stageId });
  const manifest = humanStageHandoff({
    actor,
    approvalArtifact: `workboard-approval:${cardId}`,
    contentItemId,
    evidence,
    instanceDir,
    instanceId,
    release,
    stageId,
  });
  await mkdir(dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, manifestPath);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function presentDeliverables(manifest, contentItemId = null) {
  const base = contentItemId
    ? `/api/instances/${encodeURIComponent(manifest.instanceId)}/content-items/${encodeURIComponent(contentItemId)}`
    : `/api/instances/${encodeURIComponent(manifest.instanceId)}`;
  const artifactUrl = (path) => path
    ? `${base}/artifacts/${path.split("/").map(encodeURIComponent).join("/")}`
    : null;
  return {
    ...manifest,
    proposal: {
      ...manifest.proposal,
      summary: await readArtifactText(manifest, manifest.proposal.summaryPath, contentItemId),
      summaryUrl: artifactUrl(manifest.proposal.summaryPath),
    },
    video: {
      ...manifest.video,
      url: artifactUrl(manifest.video.path),
      posterUrl: artifactUrl(manifest.video.posterPath),
    },
    qc: {
      ...manifest.qc,
      report: await readArtifactText(manifest, manifest.qc.reportPath, contentItemId),
      reportUrl: artifactUrl(manifest.qc.reportPath),
    },
  };
}

async function readArtifactText(manifest, relativePath, contentItemId = null) {
  if (!relativePath) return null;
  const filePath = await resolveDeclaredArtifact(manifest, relativePath, contentItemId);
  const content = await readFile(filePath, "utf8");
  return content.slice(0, 24000);
}

async function serveDeliverableArtifact(request, response, instanceId, requestedPath, contentItemId = null) {
  let manifest;
  try {
    manifest = await loadDeliverables(instanceId, contentItemId);
  } catch (error) {
    if (error.code === "ENOENT") {
      json(response, 404, { error: "Delivery package not found" });
      return;
    }
    throw error;
  }
  let relativePath;
  try {
    relativePath = normalizeArtifactPath(requestedPath);
  } catch {
    json(response, 404, { error: "Artifact not found" });
    return;
  }
  if (!deliverableArtifactPaths(manifest).has(relativePath)) {
    json(response, 404, { error: "Artifact is not part of the published delivery package" });
    return;
  }
  let filePath;
  let info;
  try {
    filePath = await resolveDeclaredArtifact(manifest, relativePath, contentItemId);
    info = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      json(response, 404, { error: "Artifact not found" });
      return;
    }
    throw error;
  }
  if (!info.isFile()) {
    json(response, 404, { error: "Artifact not found" });
    return;
  }
  const range = parseByteRange(request.headers.range, info.size);
  if (range === false) {
    response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
    "Content-Disposition": "inline",
    "Content-Length": Math.max(0, end - start + 1),
    "Content-Type": contentType(filePath),
    "X-Content-Type-Options": "nosniff",
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(response);
}

async function resolveDeclaredArtifact(manifest, relativePath, contentItemId = null) {
  const normalizedPath = normalizeArtifactPath(relativePath);
  if (!deliverableArtifactPaths(manifest).has(normalizedPath)) {
    throw new Error("Artifact is not declared in the delivery manifest");
  }
  const instanceRoot = await realpath(contentItemId
    ? resolve(dataDir, "instances", manifest.instanceId, "content-items", contentItemId)
    : resolve(dataDir, "instances", manifest.instanceId));
  const candidate = await realpath(resolve(instanceRoot, normalizedPath));
  if (!candidate.startsWith(`${instanceRoot}${sep}`)) {
    throw new Error("Artifact escaped the instance directory");
  }
  return candidate;
}

function assertInstanceId(instanceId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(instanceId)) {
    throw new Error("Invalid instance id");
  }
}

function nativeCardAttempts(card) {
  const attempts = Array.isArray(card.metadata?.attempts) ? card.metadata.attempts : [];
  const candidates = attempts.length > 0 ? attempts : [card.execution ?? card];
  return candidates
    .filter((attempt) => attempt?.sessionKey)
    .map((attempt, index) => ({
      endedAt: finiteTimestamp(attempt.endedAt),
      engine: cleanText(attempt.engine ?? "openclaw", 120),
      error: attempt.error ? cleanText(attempt.error, 12000) : null,
      index: index + 1,
      model: cleanText(attempt.model ?? "default", 120),
      runId: cleanText(attempt.runId ?? card.runId ?? "", 500),
      sessionKey: cleanText(attempt.sessionKey ?? card.sessionKey, 1000),
      startedAt: finiteTimestamp(attempt.startedAt),
      status: cleanText(attempt.status ?? card.status ?? "unknown", 80),
    }))
    .sort((left, right) => Number(left.startedAt ?? 0) - Number(right.startedAt ?? 0));
}

function presentAttempt(attempt) {
  return {
    endedAt: attempt.endedAt,
    engine: attempt.engine,
    error: attempt.error,
    index: attempt.index,
    model: attempt.model,
    runId: attempt.runId,
    startedAt: attempt.startedAt,
    status: attempt.status,
  };
}

function presentSessionMessage(message) {
  return {
    content: redactSessionValue(message.content, "content"),
    isError: message.isError === true,
    model: cleanText(message.model ?? "", 120) || null,
    provider: cleanText(message.provider ?? "", 120) || null,
    role: cleanText(message.role ?? "unknown", 80),
    stopReason: cleanText(message.stopReason ?? "", 120) || null,
    timestamp: finiteTimestamp(message.timestamp),
    toolName: cleanText(message.toolName ?? "", 160) || null,
    usage: redactSessionValue(message.usage ?? null, "usage"),
  };
}

function redactSessionValue(value, key = "") {
  if (/(authorization|cookie|credential|password|secret|token|api.?key)/i.test(key)) return "[redacted]";
  if (typeof value === "string") return cleanText(value, 20000)
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(["']?(?:[a-z0-9_.-]*(?:token|secret|password|api.?key)[a-z0-9_.-]*)["']?\s*[:=]\s*["'])[^"']+(["'])/gi, "$1[redacted]$2")
    .replace(/((?:claim\s+token|[a-z0-9_.-]*(?:token|secret|password|api.?key)[a-z0-9_.-]*)\s*[:=]\s*)[^\s,;}\]]+/gi, "$1[redacted]")
    .replace(/((?:claim\s+)?token(?:\s+(?:is|was|used|value(?:\s+is)?))?\s*(?:[:=]\s*)?[`"']?)[a-z0-9._~+/=…-]{8,}([`"']?)/gi, "$1[redacted]$2");
  if (Array.isArray(value)) return value.map((entry) => redactSessionValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactSessionValue(child, childKey)]));
  }
  return value;
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, maxLength);
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return false;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start == null && end == null) return false;
  if (start == null) {
    const suffixLength = Math.min(end, size);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    end = end == null ? size - 1 : Math.min(end, size - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) return false;
  return { start, end };
}

function dashboardLinks() {
  return {
    home: dashboardUrl(),
    liveBoard: dashboardUrl({ view: "board" }),
    projects: dashboardUrl({ view: "projects" }),
    workflows: dashboardUrl({ view: "workflows" }),
  };
}

function workflowLinks(release) {
  return {
    workflow: dashboardUrl({
      view: "workflows",
      workflow: release.workflowId ?? release.metadata?.id,
      release: release.workflowSha256 ?? release.metadata?.workflowSha256,
    }),
  };
}

function projectLinks(instanceId) {
  return {
    project: dashboardUrl({ view: "workflows", project: instanceId }),
  };
}

function cardLinks(cardId) {
  return {
    task: dashboardUrl({ view: "board", card: cardId }),
  };
}

function withWorkflowLinks(release) {
  return { ...release, links: workflowLinks(release) };
}

function withInstanceLinks(instance) {
  return { ...instance, control: store.getInstanceControl(instance.id), links: projectLinks(instance.id) };
}

function withCardLinks(card) {
  return { ...card, humanAttempt: publicHumanAttempt(store.getHumanAttempt(card.id)), links: cardLinks(card.id) };
}

function cardInstanceId(card) {
  return card.metadata?.automation?.instanceId ??
    (card.labels ?? []).find((entry) => entry.startsWith("instance:"))?.slice("instance:".length) ??
    null;
}

function visibleCards(cards, instances) {
  const archived = new Set(
    store.listInstances()
      .filter((instance) => instance.status === "archived")
      .map((instance) => instance.id),
  );
  const visible = new Set(instances.map((instance) => instance.id));
  return cards.filter((card) => {
    const instanceId = cardInstanceId(card);
    return !instanceId || visible.has(instanceId) || !archived.has(instanceId);
  });
}

function dashboardUrl(parameters = {}) {
  const origin = publicBaseUrl || (publicHost ? `https://${publicHost}` : `http://${host}:${port}`);
  const url = new URL("/", origin);
  for (const [key, value] of Object.entries(parameters)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(distRoot, normalize(relative));
  const safe = candidate.startsWith(distRoot) ? candidate : resolve(distRoot, "index.html");
  let filePath = safe;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) filePath = resolve(distRoot, "index.html");
  } catch {
    filePath = resolve(distRoot, "index.html");
  }
  const content = await readFile(filePath);
  response.writeHead(200, {
    "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    "Content-Type": contentType(filePath),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

function json(response, status, value) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function contentType(path) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webm": "video/webm",
  }[extname(path)] ?? "application/octet-stream";
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(schedulerTimer);
  clearTimeout(initialSchedulerTimer);
  let finished = false;
  let forceTimer;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(forceTimer);
    store.close();
    process.exit(0);
  };
  forceTimer = setTimeout(() => {
    server.closeAllConnections?.();
    finish();
  }, 5000);
  forceTimer.unref();
  server.close(finish);
  server.closeIdleConnections?.();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
