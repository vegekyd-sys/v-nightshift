import { publicCallSummary } from "../../../packages/nightshift-core/src/workflow-calls.mjs";
import { activeCardCount, derivedWarmupMaxCards, warmupAdmission } from "./active-card-count.mjs";
import { DispatchHoldLedger, dispatchHoldReason } from "./dispatch-hold-ledger.mjs";
import { buildOverview } from "./overview.mjs";
import { createContentItemsManifestSync } from "./content-items-manifest.mjs";
import { runSchedulerPass, instanceCardIds, visibleCardIds } from "../../../packages/nightshift-core/src/scheduler-pass.mjs";
import { tickWithFaultProjection } from "../../../packages/nightshift-core/src/scheduler-state.mjs";
import { createCompletionUrlChecker } from "./completion-url.mjs";
import { SchedulerCircuit } from "./scheduler-circuit.mjs";
import { createAgentDbPressureProbe } from "./agent-db-pressure-probe.mjs";
import { createHostPressureProbe } from "./host-pressure-probe.mjs";
import { DispatchPressureGuard } from "./dispatch-pressure-guard.mjs";
import { WorkboardChangeScheduler } from "./workboard-change-scheduler.mjs";
import { GatewayRestartHold, isGatewayRestartError } from "../../../packages/nightshift-core/src/gateway-restart-hold.mjs";
import { createSessionReader } from "./session-reader.mjs";
import { HumanAttemptController, humanCompletionEvidence, publicHumanAttempt, evidenceHash } from "../../../packages/nightshift-core/src/human-attempt.mjs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublicAuth, requiresPublicAuth, verifyPublicAuth, resolveOperatorIdentity } from "./public-auth.mjs";
import { resolveCardDecisionContext } from "./decision-context.mjs";
import { sendJson } from "./http-json.mjs";
import {
  NeedsYouTracker,
  buildNeedsYou,
  CARD_LABEL_MAX,
  cardIsStartable,
  deliverableArtifactPaths,
  auditNightShiftGovernance,
  findNightShiftExternalOperation,
  humanStageHandoff,
  NightShiftNotificationCoordinator,
  readProjectStageOutput,
  NightShiftRuntime,
  NightShiftStore,
  OpenClawFeishuNotificationSender,
  runRetention,
  artifactFromHandoffDirectory,
  instanceRelativeArtifactPath,
  normalizeArtifactPath,
  normalizeProjectGovernance,
  PRIORITY_MAX,
  PRIORITY_MIN,
  PROJECT_CONCURRENCY_MAX,
  projectConcurrencyLimit,
  projectPriority,
  normalizeDeliverablesManifest,
  deliverablesFromHandoffs,
  normalizeStageHandoff,
  presentStageHandoff,
  redactSensitiveInputs,
  missingCommands,
  requiredCommands,
  requiredSkillsByRole,
  resolveNightShiftCardContext,
  resolveNightShiftOperationKeys,
  stageHandoffPath,
  validateDeclaredCompletion,
  validateExternalOperationCompletion,
  validateExecutionEvidence,
  validateProjectRequest,
  contentItemsManifestIssues,
  writesContentItemsManifest,
  WorkboardGatewayAdapter,
} from "../../../packages/nightshift-core/src/index.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const appRoot = resolve(here, "..");
const distRoot = resolve(appRoot, "dist");
// The delivery page template (apps/nightshift-dashboard/delivery): a static
// page this server only hosts, under /deliver/ and without login. What it
// shows comes from a manifest the Agent uploads to the CDN (?m=<URL>).
const deliverRoot = resolve(distRoot, "deliver");
const DELIVER_SOURCES = "https://cdn.makaron.app https://sdyrtztrjgmmpnirswxt.supabase.co https://orywxdeppjtwckzqehpr.supabase.co";
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
// Feishu cards to the person a project belongs to (see packages/nightshift-core/src/notifications.mjs).
const notificationsEnabled = process.env.NIGHTSHIFT_FEISHU_NOTIFICATIONS === "1";
const schedulerDispatchMaxStarts = positiveInteger(process.env.NIGHTSHIFT_DISPATCH_MAX_STARTS_PER_PASS, 36, 36);
const dispatchMaxStartsPerInstance = positiveInteger(process.env.NIGHTSHIFT_DISPATCH_MAX_STARTS_PER_INSTANCE, 8, 8);
const dispatchStartBurst = positiveInteger(process.env.NIGHTSHIFT_DISPATCH_START_BURST, 3, 8);
const dispatchStartIntervalMs = positiveInteger(process.env.NIGHTSHIFT_DISPATCH_START_INTERVAL_MS, 15_000, 60_000);
const schedulerMaxWorkboardActive = positiveInteger(process.env.NIGHTSHIFT_MAX_WORKBOARD_ACTIVE, 36, 36);
const schedulerFailureCooldownMs = positiveInteger(process.env.NIGHTSHIFT_SCHEDULER_FAILURE_COOLDOWN_MS, 300_000, 3_600_000);
const schedulerEventDebounceMs = positiveInteger(process.env.NIGHTSHIFT_SCHEDULER_EVENT_DEBOUNCE_MS, 100, 10_000);
const schedulerEventMinIntervalMs = positiveInteger(process.env.NIGHTSHIFT_SCHEDULER_EVENT_MIN_INTERVAL_MS, 5_000, 30_000);
const schedulerRepairIntervalMs = positiveInteger(process.env.NIGHTSHIFT_SCHEDULER_REPAIR_INTERVAL_MS, 300_000, 3_600_000);
const gatewayCapacityProbeIntervalMs = positiveInteger(process.env.NIGHTSHIFT_GATEWAY_CAPACITY_PROBE_INTERVAL_MS, 5_000, 300_000);
const gatewayGreenLatencyMs = positiveInteger(process.env.NIGHTSHIFT_GATEWAY_GREEN_LATENCY_MS, 250, 10_000);
const gatewayRedLatencyMs = positiveInteger(process.env.NIGHTSHIFT_GATEWAY_RED_LATENCY_MS, 1_000, 30_000);
const dispatchInitialMaxActive = positiveInteger(process.env.NIGHTSHIFT_DISPATCH_INITIAL_MAX_ACTIVE, 3, schedulerMaxWorkboardActive);
// How many cards one project may run while no other project waits for a start;
// 0 keeps every project at its own limit (orchestrator.mjs projectIdleConcurrencyLimit).
const idleProjectConcurrency = process.env.NIGHTSHIFT_IDLE_PROJECT_CONCURRENCY === "0"
  ? 0 : positiveInteger(process.env.NIGHTSHIFT_IDLE_PROJECT_CONCURRENCY, PROJECT_CONCURRENCY_MAX, PROJECT_CONCURRENCY_MAX);
// Elastic admission knobs. Interactive slots are Worker sessions never handed to
// Night Shift; the memory reserve is host RAM kept free before a new job starts.
const reservedInteractiveSlots = positiveInteger(process.env.NIGHTSHIFT_RESERVED_INTERACTIVE_SLOTS, 9, 128);
// Workers, not Session slots, are what an interactive turn actually needs.
const reservedInteractiveWorkers = positiveInteger(process.env.NIGHTSHIFT_RESERVED_INTERACTIVE_WORKERS, 3, 64);
const hostMemoryReserveMiB = positiveInteger(process.env.NIGHTSHIFT_HOST_MEMORY_RESERVE_MIB, 4096, 262_144);
const hostMemoryReservePercent = positiveInteger(process.env.NIGHTSHIFT_HOST_MEMORY_RESERVE_PERCENT, 40, 90);
// The Agent DB write lease, read from the Gateway journal (see agent-db-pressure-probe.mjs).
const agentDbPressureEnabled = process.env.NIGHTSHIFT_AGENT_DB_PRESSURE !== "0";
const agentDbPressureUnit = process.env.NIGHTSHIFT_GATEWAY_UNIT || "openclaw-gateway";
const agentDbPressureWindowSeconds = positiveInteger(process.env.NIGHTSHIFT_AGENT_DB_PRESSURE_WINDOW_SECONDS, 120, 900);
const agentDbSlowAdmissionYellow = positiveInteger(process.env.NIGHTSHIFT_AGENT_DB_SLOW_ADMISSION_YELLOW, 3, 1_000);
const userHarmCooldownMs = positiveInteger(process.env.NIGHTSHIFT_USER_HARM_COOLDOWN_MS, 900_000, 7_200_000);
const orphanedSessionMs = positiveInteger(process.env.NIGHTSHIFT_ORPHANED_SESSION_MS, 2_700_000, 86_400_000);
// How soon to retry after a scheduler pass fails, doubling up to the ceiling.
// New cards still in their first minutes, the heaviest on the agent database.
// At most this many at once; a start waits for one to leave its window.
const warmupWindowMs = positiveInteger(process.env.NIGHTSHIFT_WARMUP_WINDOW_MS, 90_000, 1_800_000);
// Unset, it follows the Gateway's Worker pool (active-card-count.mjs derivedWarmupMaxCards).
const warmupMaxStartsSetting = process.env.NIGHTSHIFT_WARMUP_MAX_CARDS
  ? positiveInteger(process.env.NIGHTSHIFT_WARMUP_MAX_CARDS, 3, 36) : null;
const schedulerRetryMinMs = positiveInteger(process.env.NIGHTSHIFT_SCHEDULER_RETRY_MIN_MS, 10_000, 600_000);
const schedulerRetryMaxMs = positiveInteger(process.env.NIGHTSHIFT_SCHEDULER_RETRY_MAX_MS, 120_000, 600_000);
// After the Gateway returns from a restart, Night Shift waits this long before it
// resumes the interrupted runs and dispatches again: the new process is cold.
const gatewayRestartSettleMs = positiveInteger(process.env.NIGHTSHIFT_GATEWAY_RESTART_SETTLE_MS, 60_000, 600_000);
// An explicit refresh=1 read is served from the cache when the last board read
// is younger than this. Pollers cannot turn the API into a board scan loop.
const cardRefreshMinIntervalMs = positiveInteger(process.env.NIGHTSHIFT_CARD_REFRESH_MIN_INTERVAL_MS, 30_000, 600_000);
const publicAuth = await loadPublicAuth(process.env.NIGHTSHIFT_BASIC_AUTH_FILE);
await mkdir(dataDir, { recursive: true });
const store = new NightShiftStore(join(dataDir, "nightshift.sqlite"));
const workboard = new WorkboardGatewayAdapter({
  // Recovery after a failed Gateway mutation re-reads the projects this service
  // can act on, instead of walking every archived card on the board.
  recoveryCardIds: () => visibleCardIds(store),
  board,
  startBurst: dispatchStartBurst,
  startIntervalMs: dispatchStartIntervalMs,
});
const needsYou = new NeedsYouTracker({ store });
const gatewayRestart = new GatewayRestartHold({ store, settleMs: gatewayRestartSettleMs });
const runtime = new NightShiftRuntime({
  board,
  completionValidator: validateCompletion,
  executionRoot: join(dataDir, "instances"),
  dispatchMaxStarts: dispatchMaxStartsPerInstance,
  maxWorkboardActive: schedulerMaxWorkboardActive,
  orphanedSessionMs,
  needsYou,
  store,
  workboard,
});
const readSession = createSessionReader({ getSession: (...args) => workboard.getSession(...args) });
const humanAttempts = new HumanAttemptController({ store, workboard, validateCompletion });
const checkCompletionUrl = createCompletionUrlChecker();
let cardCache = [];
let cardsUpdatedAt = null;
let cardRefreshPromise = null;
let cardRefreshScope = null;
let lastSchedulerAt = null;
let schedulerStartedAt = null;
let lastSchedulerDurationMs = null;
let lastSchedulerError = null;
let lastNotificationError = null;
let lastNotificationAt = null;
let lastSchedulerTrigger = null;
let schedulerPromise = null;
// Each project's place in its Workflow's queue, as of the last scheduler pass.
let projectQueue = new Map();
const notificationCoordinator = notificationsEnabled
  ? new NightShiftNotificationCoordinator({
      baseUrl: publicBaseUrl || `http://${host}:${port}`,
      sender: new OpenClawFeishuNotificationSender(),
      store,
      // A Workflow may put one of its outputs (a delivery page) on the card.
      readStageOutput: ({ instanceId, stageId, output }) =>
        readProjectStageOutput({ instanceDir: resolve(dataDir, "instances", instanceId), stageId, output }),
    })
  : null;
const schedulerCircuit = new SchedulerCircuit({ cooldownMs: schedulerFailureCooldownMs, startWithProbe: true });
const dispatchPressureGuard = new DispatchPressureGuard({
  greenLatencyMs: gatewayGreenLatencyMs,
  initialMaxActive: dispatchInitialMaxActive,
  maxActive: schedulerMaxWorkboardActive,
  redLatencyMs: gatewayRedLatencyMs,
  reservedInteractiveSlots,
  reservedInteractiveWorkers,
  userHarmCooldownMs,
});
const probeAgentDbPressure = createAgentDbPressureProbe({
  enabled: agentDbPressureEnabled,
  gatewayUrl: workboard.gatewayUrl,
  slowAdmissionYellow: agentDbSlowAdmissionYellow,
  unit: agentDbPressureUnit,
  windowSeconds: agentDbPressureWindowSeconds,
});
const probeHostPressure = createHostPressureProbe({
  gatewayUrl: workboard.gatewayUrl,
  reserveFloorMiB: hostMemoryReserveMiB,
  reservePercent: hostMemoryReservePercent,
});
let tickQueue = Promise.resolve();
let shuttingDown = false;
let capacityProbePromise = null;
let capacityProbeTimer = null;
let holdObservationTimer = null;
// The Worker pool size from the last probe that reported it.
let lastWorkerCapacity = null;
const dispatchHolds = new DispatchHoldLedger();
// Finished projects' working media is removed once a day (see storage-retention.mjs). V's data
// disk filled up on 2026-10-14 because nothing ever removed it.
const retentionDays = Number(process.env.NIGHTSHIFT_RETENTION_DAYS ?? 14);
const retentionHour = Number(process.env.NIGHTSHIFT_RETENTION_HOUR ?? 5);
const retentionDisabled = process.env.NIGHTSHIFT_RETENTION_DISABLED === "1";
// V's copy of a delivered final goes this many days after its project finished, once the CDN is
// seen to hold the same bytes; "0" keeps every final (storage-retention.mjs).
const retentionFinalsDays = process.env.NIGHTSHIFT_RETENTION_FINALS_DAYS === "0" ? null : Number(process.env.NIGHTSHIFT_RETENTION_FINALS_DAYS ?? 7);
const retentionCheckMs = Number(process.env.NIGHTSHIFT_RETENTION_CHECK_MS ?? 15 * 60_000);
let retentionTimer = null;
let retentionDay = null;
let retentionPromise = null;
let lastRetention = null;
const syncContentItemsManifest = createContentItemsManifestSync({
  dataDir, setContentItems: (instanceId, items) => runtime.setContentItems(instanceId, items),
});

await ensureWorkflow();
await ensureSeedInstance();
let schedulerRetryMs = 0;
const changeScheduler = new WorkboardChangeScheduler({
  debounceMs: schedulerEventDebounceMs,
  minRunIntervalMs: schedulerEventMinIntervalMs,
  onError: (error) => {
    console.error(`Night Shift event scheduler failed: ${error.message}`);
    scheduleSchedulerRetry();
  },
  repairIntervalMs: schedulerRepairIntervalMs,
  run: runScheduler,
  workboard,
});
workboard.needsFullSnapshot = true; // Recover cards committed before a prior Scheduler crash.
changeScheduler.start();
workboard.onGatewayLifecycle((event) => {
  const before = gatewayRestart.snapshot().status;
  const after = gatewayRestart.observe(event);
  if (after.status !== before) console.log(`Night Shift Gateway ${event.type}: ${before} -> ${after.status}`);
  if (after.status === "resuming") changeScheduler.enqueueAfter("gateway.resume", Math.max(0, Date.parse(after.resume.resumeAt) - Date.now()));
});
workboard.connect()
  .then(() => probeDispatchCapacity())
  .catch((error) => {
    console.error(`Night Shift persistent Gateway connection failed: ${error.message}`);
  });
capacityProbeTimer = setInterval(() => probeDispatchCapacity(), gatewayCapacityProbeIntervalMs);
capacityProbeTimer.unref?.();
holdObservationTimer = setInterval(() => observeDispatchHold(), gatewayCapacityProbeIntervalMs);
holdObservationTimer.unref?.();
retentionTimer = setInterval(() => runDailyRetention(), retentionCheckMs);
retentionTimer.unref?.();

const server = createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url, "http://localhost").pathname;
    if (request.method === "GET" && /^\/deliver(?:\/|$)/u.test(requestPath)) {
      await serveDeliverTemplate(response, requestPath);
      return;
    }
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
    // A refused Workflow says why: publish used to answer only "failed with 1
    // issue(s)", so an author could not tell what to change.
    const issues = Array.isArray(error.issues) ? error.issues : null;
    const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : issues ? 422 : 500;
    json(response, statusCode, issues ? { error: error.message, issues } : { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Night Shift Workboard listening on http://${host}:${port}`);
});

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    const circuit = schedulerCircuit.snapshot();
    const schedulerStalled = Boolean(schedulerPromise && schedulerStartedAt && Date.now() - Date.parse(schedulerStartedAt) >= 90_000);
    json(response, 200, {
      board,
      cardsUpdatedAt,
      lastSchedulerAt,
      lastSchedulerError,
      workflowFeatures: { calls: 1, boundedRepeat: 1, terminalAttempts: 1, operationRecovery: 1, descendantDecisions: 1, callTimeRecovery: 1 },
      notifications: { enabled: notificationsEnabled, lastAt: lastNotificationAt, lastError: lastNotificationError },
      schedulerStartedAt,
      schedulerRunning: Boolean(schedulerPromise),
      lastSchedulerDurationMs,
      schedulerDispatchMaxStarts,
      dispatchMaxStartsPerInstance,
      dispatchStartBurst,
      dispatchStartIntervalMs,
      schedulerMaxWorkboardActive,
      idleProjectConcurrency,
      schedulerFailureCooldownMs,
      schedulerEventDebounceMs,
      schedulerEventMinIntervalMs,
      schedulerMode: "workboard-events",
      schedulerRepairIntervalMs,
      dispatchPressure: dispatchPressureGuard.snapshot(activeCardCount(cardCache)),
      dispatchWarmup: { ...warmupAdmission(cardCache, { windowMs: warmupWindowMs, maxWarming: warmupMaxCards() }), derived: warmupMaxStartsSetting === null },
      dispatchHolds: dispatchHolds.snapshot(),
      gatewayRestart: gatewayRestart.snapshot(),
      gatewayCapacityProbeIntervalMs,
      reservedInteractiveSlots,
      reservedInteractiveWorkers,
      hostMemoryReserveMiB,
      hostMemoryReservePercent,
      cardRefreshMinIntervalMs,
      cardLabelMax: CARD_LABEL_MAX,
      schedulerRetryMs,
      lastSchedulerTrigger,
      gatewayConnected: workboard.connected,
      schedulerStalled,
      schedulerCircuitOpen: circuit.open,
      schedulerCircuitOpenUntil: circuit.openUntil,
      schedulerCircuitProbeRequired: circuit.probeRequired,
      schedulerCircuitReason: circuit.reason,
      ok: Boolean(lastSchedulerAt) && workboard.connected && !lastSchedulerError && !schedulerStalled,
      service: "nightshift-workboard",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    if (url.searchParams.get("refresh") === "1") await refreshVisibleCards();
    const instances = store.listInstances().filter((instance) => instance.status !== "archived").map((instance) => ({
      ...instance,
      contentItems: store.listContentItems(instance.id),
      contentItemRuns: store.listContentItemRuns(instance.id),
      stageRuns: store.listStageRuns(instance.id),
      // A card can read blocked while its paid provider call is still running;
      // the board needs this to tell that apart from a card waiting on a person.
      operations: store.listExternalOperations(instance.id).map((operation) => ({
        ownerCardId: operation.ownerCardId,
        status: operation.status,
        updatedAt: operation.updatedAt,
      })),
    }));
    json(response, 200, {
      board,
      cards: visibleCards(cardCache, instances).map(withCardLinks),
      cardsUpdatedAt,
      events: store.listEvents(null, 80),
      instances: instances.map(withInstanceLinks),
      links: dashboardLinks(),
      workflows: store.listReleases().map(withWorkflowLinks),
    }, { revalidate: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/overview") {
    if (url.searchParams.get("refresh") === "1") await refreshVisibleCards();
    const instances = store.listInstances().map((instance) => instance.status === "archived" ? instance : withInstanceLinks({
      ...instance,
      contentItems: store.listContentItems(instance.id),
      contentItemRuns: store.listContentItemRuns(instance.id),
      stageRuns: store.listStageRuns(instance.id),
    }));
    const visible = instances.filter((instance) => instance.status !== "archived");
    json(response, 200, {
      board,
      cardsUpdatedAt,
      // The board shows "Gateway 重启中，夜班已暂停" while this is not "up".
      gatewayRestart: gatewayRestartForBoard(gatewayRestart.snapshot()),
      ...buildOverview({
        scope: url.searchParams.get("scope") ?? "live",
        instances,
        cards: visibleCards(cardCache, visible).map(withCardLinks),
        releases: store.listReleases().map(withWorkflowLinks),
        operationsFor: (instanceId) => store.listExternalOperations(instanceId),
        skippedFor: (instanceId) => store.listSkippedContentItems(instanceId),
      }),
      // 需要你 is scope-independent: every project that is not shelved.
      needsYou: buildNeedsYou({
        store,
        instances: visible,
        cards: visibleCards(cardCache, visible),
        releases: store.listReleases(),
        pending: needsYou.pendingList(),
      }),
    }, { revalidate: true });
    return;
  }
  const fullCardMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
  if (request.method === "GET" && fullCardMatch) {
    // The overview carries a lean card; the drawer asks for the whole one.
    const cardId = decodeURIComponent(fullCardMatch[1]);
    const card = cardCache.find((entry) => entry.id === cardId) ?? (await refreshCards({ cardIds: [cardId] })).find((entry) => entry.id === cardId);
    if (!card) {
      json(response, 404, { error: "Workboard card not found" });
      return;
    }
    json(response, 200, { card: withCardLinks(card) });
    return;
  }
  const workflowSourceMatch = url.pathname.match(/^\/api\/workflows\/([a-f0-9]{64})\/source$/);
  if (request.method === "GET" && workflowSourceMatch) {
    const release = store.getRelease(workflowSourceMatch[1]);
    if (!release) {
      json(response, 404, { error: "Workflow release not found" });
      return;
    }
    json(response, 200, { workflowSha256: release.workflowSha256, sourceMarkdown: release.sourceMarkdown ?? null, sourceYaml: release.sourceYaml ?? null });
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
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    json(response, 200, {
      instances: store.listInstances().filter((instance) => includeArchived || instance.status !== "archived").map((instance) => withInstanceLinks({
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
    const archived = store.archiveInstance(instanceId, new Date(), {
      actor: operatorIdentity(request, {}),
      reason: "Archived from Live Board",
      cardCounts: countCardsByStatus(projectCards),
    });
    refreshCards({ cardIds: instanceCardIds(store, archived.id) }).catch((error) => {
      lastSchedulerError = error.message;
    });
    json(response, 200, { id: archived.id, status: archived.status });
    return;
  }
  const instanceArchiveMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/(archive|restore)$/);
  if (request.method === "POST" && instanceArchiveMatch) {
    const instanceId = decodeURIComponent(instanceArchiveMatch[1]);
    const instance = store.getInstance(instanceId);
    const action = instanceArchiveMatch[2];
    if (!instance) {
      json(response, 404, { error: "Project not found" });
      return;
    }
    const body = await bodyJson(request);
    const actor = operatorIdentity(request, body);
    if (action === "archive") {
      if (instance.status === "archived") {
        json(response, 200, { ...withInstanceLinks(instance), reused: true });
        return;
      }
      const cards = (await refreshCards({ cardIds: instanceCardIds(store, instanceId) })).filter((card) => cardInstanceId(card) === instanceId);
      const running = cards.filter((card) => card.status === "running");
      if (running.length > 0) {
        json(response, 409, { error: `项目仍有 ${running.length} 个 Agent 正在工作，不能归档` });
        return;
      }
      const archived = store.archiveInstance(instanceId, new Date(), {
        actor,
        reason: body.reason ?? "Governance archive",
        cardCounts: countCardsByStatus(cards),
      });
      json(response, 200, { ...withInstanceLinks(archived), cardCounts: countCardsByStatus(cards), softArchive: true });
      return;
    }
    if (instance.status !== "archived") {
      json(response, 409, { error: "Project is not archived" });
      return;
    }
    const restored = store.restoreInstance(instanceId, new Date(), { actor, reason: body.reason ?? "Governance restore" });
    json(response, 200, { ...withInstanceLinks(restored), dispatch: false });
    return;
  }
  if (url.pathname === "/api/storage/retention" && (request.method === "GET" || request.method === "POST")) {
    const apply = request.method === "POST";
    const actor = apply ? operatorIdentity(request, await bodyJson(request)) : null;
    try {
      json(response, 200, { ...(await storageRetention({ apply, actor })), last: lastRetention });
    } catch (error) {
      json(response, error.code === "RETENTION_BUSY" ? 409 : 500, { error: error.message });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/governance/audit") {
    const cards = url.searchParams.get("refresh") === "1" ? await refreshVisibleCards({ includeArchived: true }) : cardCache;
    json(response, 200, auditNightShiftGovernance({ cards, instances: store.listInstances() }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/cards") {
    const status = url.searchParams.get("status");
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const cards = url.searchParams.get("refresh") === "1" ? await refreshVisibleCards({ includeArchived }) : cardCache;
    const instances = store.listInstances().filter((instance) => instance.status !== "archived");
    const filtered = includeArchived ? cards : visibleCards(cards, instances);
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
    const card = cardCache.find((entry) => entry.id === cardId) ?? (await refreshCards({ cardIds: [cardId] })).find((entry) => entry.id === cardId);
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
    const result = await readSession({
      cacheKey: `${card.id}:${attempt.runId}`,
      limit: 80,
      sessionKey: attempt.sessionKey,
      terminal: card.status !== "running" || attempt.status !== "running",
    });
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
      json(response, preflight.ok ? 200 : 422, preflight.ok ? preflight : { ...preflight, error: preflightError(preflight) });
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
      json(response, 422, { ...preflight, error: preflightError(preflight) });
      return;
    }
    if (body.automaticDispatch !== undefined && typeof body.automaticDispatch !== "boolean") throw new Error("automaticDispatch must be a boolean");
    const created = await startInstance(body);
    if (body.automaticDispatch === false) store.setInstanceControl(created.id, { automaticDispatch: false });
    let initialSchedule = null;
    let initialScheduleError = null;
    if (created.status === "active") {
      try {
        const scheduled = await scheduleStartedInstance(created.id);
        initialSchedule = {
          actionCount: scheduled.actions.length,
          cardIds: scheduled.applied.map((entry) => entry.card?.id).filter(Boolean),
          dispatched: false,
          queuedForGuardedDispatch: body.dispatch !== false && store.getInstanceControl(created.id).automaticDispatch,
        };
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
    const result = await scheduleStartedInstance(instanceId);
    json(response, 200, {
      instance: store.getInstance(instanceId),
      schedule: result,
      queuedForGuardedDispatch: store.getInstanceControl(instanceId).automaticDispatch,
    });
    return;
  }
  const instanceCollaborationMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/collaboration$/);
  if (request.method === "PATCH" && instanceCollaborationMatch) {
    const body = await bodyJson(request);
    const updated = runtime.updateInstanceCollaboration(
      decodeURIComponent(instanceCollaborationMatch[1]),
      body.collaboration ?? {},
    );
    json(response, 200, updated);
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
    if (!body.dryRun) await refreshCards({ cardIds: instanceCardIds(store, decodeURIComponent(tickMatch[1])) });
    json(
      response,
      200,
      result,
    );
    return;
  }
  const callTimeRecoveryMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/authorize-time-recovery$/);
  if (request.method === "POST" && callTimeRecoveryMatch) {
    const body = await bodyJson(request);
    const result = await serializedOperation(() => runtime.authorizeCallTimeRecovery({
      callId: decodeURIComponent(callTimeRecoveryMatch[1]), actor: operatorIdentity(request, body),
      expectedDeadline: body.expectedDeadline, deadline: body.deadline,
      reason: body.reason, authorization: body.authorization, evidence: body.evidence,
    }));
    changeScheduler.enqueue("call.time-recovery");
    json(response, 200, result);
    return;
  }
  const recoveryMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/operations\/authorize-recovery$/);
  if (request.method === "POST" && recoveryMatch) {
    const body = await bodyJson(request);
    const result = await serializedOperation(() => runtime.authorizeOperationRecovery({
      cardId: decodeURIComponent(recoveryMatch[1]), actor: operatorIdentity(request, body),
      failedOperationKey: body.failedOperationKey, requestHash: body.requestHash,
      reason: body.reason, authorization: body.authorization, evidence: body.evidence,
    }));
    json(response, 200, result);
    return;
  }
  const operationMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/operations\/(reserve|checkpoint)$/);
  if (request.method === "POST" && operationMatch) {
    const cardId = decodeURIComponent(operationMatch[1]);
    const card = cardCache.find((entry) => entry.id === cardId) ?? (await refreshCards({ cardIds: [cardId] })).find((entry) => entry.id === cardId);
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
    // With its revision: a redone item's paid call is a new operation, not the
    // one its first attempt already settled (V, 2026-09-30: a redo was told its
    // video had been paid for and completed, and failed validation).
    const contentItem = context.contentItemId
      ? runtime.contentItemsWithRevisions(instance.id).find((entry) => entry.id === context.contentItemId)
      : null;
    if (context.contentItemId && !contentItem) {
      json(response, 422, { error: "Card references an unknown Night Shift content item" });
      return;
    }
    const projectRun = context.contentItemId ? null : store.listStageRuns(instance.id).find(run => run.cardId === card.id && run.stageId === context.stageId);
    const operationKeys = resolveNightShiftOperationKeys({ card, release, instance, contentItem, projectRun });
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
    const cards = await refreshCards({ cardIds });
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
    await refreshCards({ cardIds: [...new Set(cardIds.flatMap((id) => [id, ...instanceCardIds(store, cardInstanceId(cards.find((entry) => entry.id === id)) ?? "")]))] });
    const failed = results.filter((entry) => !entry.ok);
    json(response, failed.length ? 207 : 200, { approved: results.length - failed.length, failed: failed.length, ok: failed.length === 0, results });
    return;
  }
  if (request.method === "POST" && decisionMatch) {
    const body = await bodyJson(request);
    const cardId = decodeURIComponent(decisionMatch[1]);
    const card = cardCache.find((entry) => entry.id === cardId) ?? (await refreshCards({ cardIds: [cardId] })).find((entry) => entry.id === cardId);
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
    // A decision can create the next stage's cards; read the whole project.
    await refreshCards({ cardIds: [...new Set([card.id, ...instanceCardIds(store, cardInstanceId(card) ?? "")])] });
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
  // Move a project that has not started onto another release of its Workflow
  // (runtime.switchWorkflowRelease). version "latest" is the newest release.
  const workflowSwitchMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/workflow$/);
  if (request.method === "POST" && workflowSwitchMatch) {
    const instanceId = decodeURIComponent(workflowSwitchMatch[1]);
    const body = await bodyJson(request);
    const actor = operatorIdentity(request, body);
    const instance = store.getInstance(instanceId);
    if (!instance) throw new Error(`Unknown project ${instanceId}`);
    const current = store.getRelease(instance.workflowSha256);
    const candidates = store.listReleases().filter((entry) => entry.workflowId === current?.workflowId);
    const target = typeof body.workflowSha256 === "string" ? candidates.find((entry) => entry.workflowSha256 === body.workflowSha256)
      : body.version === "latest" ? candidates[0]
        : candidates.find((entry) => entry.version === body.version);
    if (!target) throw new Error("Give version (a published version of this project's Workflow, or \"latest\") or workflowSha256");
    validateProjectRequest(target.manifest, { ...instance, workflowSha256: target.workflowSha256 });
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
    const result = await serializedOperation(() => runtime.switchWorkflowRelease({
      instanceId, workflowSha256: target.workflowSha256, actor, reason,
    }));
    await writeProjectInputsSnapshot(result.instance);
    await refreshCards({ cardIds: instanceCardIds(store, instanceId) });
    if (result.instance.status === "active" && store.getInstanceControl(instanceId).automaticDispatch) changeScheduler.enqueue("workflow.switched");
    json(response, 200, { instanceId, version: target.version, workflowSha256: target.workflowSha256, cardIds: result.cardIds, unchanged: result.unchanged });
    return;
  }
  // A project's own session limit, for an operator or an Agent to raise when
  // the host is quiet and lower when it is busy. null (or "default") returns
  // the project to its Workflow's perInstance. The board-wide brakes (Agent DB
  // pressure, host memory, maxActive) still cap every start.
  const concurrencyMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/concurrency$/);
  if (request.method === "POST" && concurrencyMatch) {
    const instanceId = decodeURIComponent(concurrencyMatch[1]);
    const body = await bodyJson(request);
    const actor = operatorIdentity(request, body);
    const instance = store.getInstance(instanceId);
    if (!instance) throw new Error(`Unknown project ${instanceId}`);
    const requested = body.perInstance === "default" ? null : body.perInstance ?? null;
    if (requested !== null && (!Number.isSafeInteger(requested) || requested < 1 || requested > PROJECT_CONCURRENCY_MAX)) {
      throw new Error(`perInstance must be an integer from 1 to ${PROJECT_CONCURRENCY_MAX}, or null / "default" for the Workflow's own limit`);
    }
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
    const result = await serializedOperation(async () => {
      const before = projectConcurrency(instance);
      store.setInstanceControl(instanceId, { perInstanceLimit: requested });
      const after = projectConcurrency(instance);
      store.appendEvent({ instanceId, type: "concurrency.control.changed", payload: { actor, reason, from: before, to: after } });
      return { instanceId, concurrency: after };
    });
    if (store.getInstanceControl(instanceId).automaticDispatch) changeScheduler.enqueue("concurrency.changed");
    json(response, 200, result);
    return;
  }
  // A project's place in the queue. Higher priority takes the free starts
  // first; equal priorities (every project nobody set) keep first come, first
  // delivered. "first" and "last" place it ahead of or behind every other
  // active project; "default" (or null) returns it to arrival order.
  const priorityMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/priority$/);
  if (request.method === "POST" && priorityMatch) {
    const instanceId = decodeURIComponent(priorityMatch[1]);
    const body = await bodyJson(request);
    const actor = operatorIdentity(request, body);
    if (!store.getInstance(instanceId)) throw new Error(`Unknown project ${instanceId}`);
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
    const result = await serializedOperation(async () => {
      const others = store.listInstances().filter((entry) => entry.status === "active" && entry.id !== instanceId)
        .map((entry) => projectPriority(store, entry.id));
      const requested = body.priority === "default" || body.priority === null || body.priority === undefined ? null
        : body.priority === "first" ? Math.max(0, ...others) + 1
          : body.priority === "last" ? Math.min(0, ...others) - 1
            : body.priority;
      if (requested !== null && (!Number.isSafeInteger(requested) || requested < PRIORITY_MIN || requested > PRIORITY_MAX)) {
        throw new Error(`priority must be an integer from ${PRIORITY_MIN} to ${PRIORITY_MAX}, "first", "last", or "default"`);
      }
      const from = store.getInstanceControl(instanceId).priority;
      store.setInstanceControl(instanceId, { priority: requested });
      store.appendEvent({ instanceId, type: "queue.priority.changed", payload: { actor, reason, from, to: requested, requested: body.priority ?? null } });
      return { instanceId, priority: requested };
    });
    changeScheduler.enqueue("queue.priority.changed");
    json(response, 200, result);
    return;
  }
  // An Agent's own order: the listed projects go ahead of every other active
  // project, in the order given. Projects not listed keep their priority.
  if (request.method === "POST" && url.pathname === "/api/queue/order") {
    const body = await bodyJson(request);
    const actor = operatorIdentity(request, body);
    const ids = Array.isArray(body.instanceIds) ? body.instanceIds : [];
    if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("instanceIds must list each project once");
    for (const id of ids) if (!store.getInstance(id)) throw new Error(`Unknown project ${id}`);
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
    const result = await serializedOperation(async () => {
      const listed = new Set(ids);
      const others = store.listInstances().filter((entry) => entry.status === "active" && !listed.has(entry.id))
        .map((entry) => projectPriority(store, entry.id));
      const top = Math.max(0, ...others) + ids.length;
      if (top > PRIORITY_MAX) throw new Error(`the order would exceed priority ${PRIORITY_MAX}; reset some priorities to default first`);
      const order = ids.map((id, index) => {
        const from = store.getInstanceControl(id).priority;
        const to = top - index;
        store.setInstanceControl(id, { priority: to });
        store.appendEvent({ instanceId: id, type: "queue.priority.changed", payload: { actor, reason, from, to, order: ids } });
        return { instanceId: id, priority: to };
      });
      return { order };
    });
    changeScheduler.enqueue("queue.priority.changed");
    json(response, 200, result);
    return;
  }
  const takeoverMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/cards\/([^/]+)\/human-(takeover|complete)$/);
  if (request.method === "POST" && takeoverMatch) {
    const body = await bodyJson(request);
    const input = { instanceId: decodeURIComponent(takeoverMatch[1]), cardId: decodeURIComponent(takeoverMatch[2]), actor: operatorIdentity(request, body), reason: body.reason };
    const result = await serializedOperation(() => takeoverMatch[3] === "takeover" ? humanAttempts.takeover(input) : humanAttempts.complete(input));
    if (takeoverMatch[3] === "complete") await serializedTick(input.instanceId, { dispatch: false });
    await refreshCards({ cardIds: instanceCardIds(store, input.instanceId) });
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
    await refreshCards({ cardIds: instanceCardIds(store, instanceId) });
    json(response, 200, result);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/decisions") {
    json(response, 200, {
      decisions: store.listDecisionRequests({
        instanceId: url.searchParams.get("instanceId") || null,
        status: url.searchParams.get("status") ?? "open",
        includeDescendants: url.searchParams.get("includeDescendants") !== "false",
      }).map(decision => ({ ...decision, executionInstanceId: decision.instanceId, rootInstanceId: store.rootInstanceId(decision.instanceId) })),
    });
    return;
  }
  const decisionRequestMatch = url.pathname.match(/^\/api\/decisions\/([^/]+)$/);
  if (decisionRequestMatch && request.method === "GET") {
    const decision = store.getDecisionRequest(decodeURIComponent(decisionRequestMatch[1]));
    if (!decision) {
      json(response, 404, { error: "Decision request not found" });
      return;
    }
    json(response, 200, decision);
    return;
  }
  if (decisionRequestMatch && request.method === "POST") {
    const body = await bodyJson(request);
    try {
      // The same identity rule as takeover and dispatch control: the signed-in
      // operator on the public host, local:<name> on the loopback.
      const actor = operatorIdentity(request, body);
      const result = await serializedOperation(() => runtime.decide({
        decisionId: decodeURIComponent(decisionRequestMatch[1]),
        optionId: body.optionId,
        note: body.note ?? null,
        actor,
        applyToGroup: body.applyToGroup === true,
      }));
      if (result.affectedCardIds.length) await refreshCards({ cardIds: result.affectedCardIds });
      // A skip can leave the rest of the project ready for delivery.
      changeScheduler.enqueue("decision.decided");
      json(response, 200, result);
    } catch (error) {
      json(response, error.statusCode ?? 500, { error: error.message, errors: error.errors });
    }
    return;
  }
  const retryMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryMatch) {
    const body = await bodyJson(request);
    try {
      const actor = operatorIdentity(request, body);
      const result = await serializedOperation(() => runtime.resume({
        cardId: decodeURIComponent(retryMatch[1]), actor, note: body.note ?? body.evidence ?? null,
        allowNewOperation: body.allowNewOperation === true,
      }));
      await refreshCards({ cardIds: result.affectedCardIds });
      changeScheduler.enqueue("card.resumed");
      json(response, 200, result);
    } catch (error) {
      json(response, error.statusCode ?? 409, { error: error.message });
    }
    return;
  }
  json(response, 404, { error: "Not found" });
}

function storageRetention({ apply, actor = null }) {
  if (retentionPromise) {
    const error = new Error("Storage retention is already running");
    error.code = "RETENTION_BUSY";
    return Promise.reject(error);
  }
  retentionPromise = runRetention({ store, instancesRoot: join(dataDir, "instances"), minAgeDays: retentionDays, apply, actor, finalsMinAgeDays: retentionFinalsDays })
    .then((result) => {
      if (apply) lastRetention = { at: new Date().toISOString(), actor, projects: result.projects.length, files: result.files, bytes: result.bytes, errors: result.errors,
        finals: { projects: result.finals.projects.length, finals: result.finals.finals, bytes: result.finals.bytes, kept: result.finals.kept } };
      return result;
    })
    .finally(() => { retentionPromise = null; });
  return retentionPromise;
}

function runDailyRetention() {
  const now = new Date();
  const today = now.toDateString();
  if (retentionDisabled || shuttingDown || retentionPromise || now.getHours() !== retentionHour || retentionDay === today) return;
  storageRetention({ apply: true, actor: "nightshift-retention" })
    .then((result) => {
      retentionDay = today;
      console.log(`Night Shift storage retention removed ${result.files} files (${(result.bytes / 2 ** 30).toFixed(2)} GiB) from ${result.projects.length} finished projects, and ${result.finals.finals} delivered finals held by the CDN (${(result.finals.bytes / 2 ** 30).toFixed(2)} GiB, ${result.finals.kept} kept)${result.errors ? `; ${result.errors} failed: ${result.projects.filter((project) => project.error).map((project) => `${project.id} ${project.error}`).join("; ")}` : ""}`);
    })
    .catch((error) => console.error(`Night Shift storage retention failed: ${error.message}`));
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

function runScheduler({ trigger = "manual" } = {}) {
  if (schedulerPromise) return schedulerPromise;
  // The Gateway is restarting: nothing is dispatched or judged until it is back.
  const restartGate = gatewayRestart.gate({ connected: workboard.connected, bootId: workboard.bootId });
  if (restartGate.hold) {
    changeScheduler.enqueueAfter("gateway.resume", restartGate.retryAfterMs);
    return Promise.resolve({ skipped: "gateway-restart-hold", ...gatewayRestart.snapshot() });
  }
  if (restartGate.pickup) return resumeAfterGatewayRestart(restartGate.pickup);
  const circuitDecision = schedulerCircuit.beforePass();
  if (!circuitDecision.run) return Promise.resolve({ skipped: "scheduler-circuit-open", ...circuitDecision });
  schedulerPromise = (async () => {
    schedulerStartedAt = new Date().toISOString();
    lastSchedulerTrigger = trigger;
    const started = Date.now();
    const pressure = dispatchPressureGuard.snapshot(activeCardCount(cardCache));
    const warmup = warmupAdmission(cardCache, { windowMs: warmupWindowMs, maxWarming: warmupMaxCards() });
    const dispatchMaxStarts = Math.min(schedulerDispatchMaxStarts, pressure.availableStarts, warmup.available);
    // One serialized round shares one authoritative board snapshot. API mutations
    // cannot interleave a takeover with a later tick using an older snapshot.
    const result = await serializedOperation(() => runSchedulerPass({
      dispatchMaxStarts,
      dispatchEnabled: circuitDecision.dispatch && pressure.dispatchAllowed && dispatchMaxStarts > 0,
      idleProjectConcurrency,
      inspectSessions: trigger === "repair",
      maxWorkboardActive: pressure.targetMaxActive,
      store, runtime, workboard, refreshCards, syncContentItemsManifest,
    }));
    dispatchPressureGuard.consumeStarts(result.dispatched);
    // A project read refused mid-pass because the Gateway began suspending:
    // hold now, and do not count it against the scheduler.
    const restartWarnings = result.warnings.filter(isGatewayRestartError);
    if (restartWarnings.length) {
      holdForGateway(restartWarnings[0]);
      result.warnings = result.warnings.filter((warning) => !isGatewayRestartError(warning));
    }
    projectQueue = result.queue ?? new Map();
    schedulerRetryMs = 0;
    lastSchedulerAt = new Date().toISOString();
    lastSchedulerDurationMs = Date.now() - started;
    lastSchedulerError = result.warnings.length ? result.warnings.join("; ") : null;
    schedulerCircuit.recordPass(result.warnings, { probe: circuitDecision.probe });
    await announceTransitions();
    if (result.retryAfterMs > 0) changeScheduler.enqueueAfter("dispatch.window", result.retryAfterMs);
    // Starts held back by warm-up resume when a warming card leaves its window.
    if (warmup.retryAfterMs > 0 && pressure.availableStarts > 0) changeScheduler.enqueueAfter("dispatch.warmup", warmup.retryAfterMs);
  })().catch((error) => {
    lastSchedulerAt = new Date().toISOString();
    if (isGatewayRestartError(error)) {
      holdForGateway(error.message);
      return;
    }
    lastSchedulerError = error.message;
    schedulerCircuit.recordFailure(error.message);
    console.error(`Night Shift scheduler failed: ${error.message}`);
    scheduleSchedulerRetry();
  }).finally(() => {
    schedulerPromise = null;
  });
  return schedulerPromise;
}

// An RPC refused with "unavailable during gateway suspension|restart": the
// Gateway is going down even if its broadcast has not reached us.
function holdForGateway(message) {
  const before = gatewayRestart.snapshot().status;
  const after = gatewayRestart.observe({ type: "suspended", phase: String(message).match(/during gateway (\w+)/i)?.[1] ?? "refused" });
  if (after.status !== before) console.log(`Night Shift Gateway refused work (${String(message).slice(0, 120)}): ${before} -> ${after.status}`);
  changeScheduler.enqueueAfter("gateway.resume", gatewayRestartSettleMs);
}

function gatewayRestartForBoard(state) {
  return {
    status: state.status,
    since: state.hold?.since ?? null,
    reason: state.hold?.reason ?? null,
    resumeAt: state.resume?.resumeAt ?? null,
    last: state.last ? { from: state.last.from, to: state.last.to, resumedAt: state.last.resumedAt,
      resumed: state.last.resumed.length, handedOver: state.last.handedOver.length } : null,
  };
}

function resumeAfterGatewayRestart(window) {
  schedulerPromise = (async () => {
    schedulerStartedAt = new Date().toISOString();
    lastSchedulerTrigger = "gateway.resume";
    const outcome = await serializedOperation(() => runtime.resumeAfterGatewayRestart(window));
    gatewayRestart.complete(window, outcome);
    console.log(`Night Shift resumed after Gateway restart: ${outcome.resumed.length} resumed, ${outcome.handedOver.length} handed to a person, ${outcome.skipped.length} skipped`);
    for (const entry of outcome.skipped) console.error(`Night Shift restart pickup skipped ${entry.cardId}: ${entry.why}`);
  })().catch((error) => {
    // The Gateway is back but the pickup failed: try again shortly. The hold
    // stays, so nothing is judged in the meantime.
    lastSchedulerError = `Gateway restart pickup failed: ${error.message}`;
    console.error(`Night Shift ${lastSchedulerError}`);
  }).finally(() => {
    schedulerPromise = null;
    const state = gatewayRestart.snapshot();
    changeScheduler.enqueueAfter(state.status === "up" ? "gateway.resumed" : "gateway.resume", state.status === "up" ? 0 : schedulerRetryMinMs);
  });
  return schedulerPromise;
}

// Events stop arriving exactly when the Gateway is gone, so a failed pass must
// schedule its own retry; the repair tick is five minutes away. This pass keeps
// its own catch and never rejects, so the scheduler's onError alone was never
// reached. Both paths call this now.
// A Feishu send that fails is recorded here and retried on the next pass (up to
// five attempts). It never becomes a scheduler warning: a notification outage
// must not trip the scheduler circuit or mark Night Shift unhealthy.
async function announceTransitions() {
  if (!notificationCoordinator) return;
  try {
    const outcome = await notificationCoordinator.reconcile({
      cards: cardCache,
      instances: store.listInstances(),
      releases: store.listReleases(),
    });
    const failed = outcome.delivered.filter((entry) => !entry.ok);
    if (outcome.delivered.length > 0) lastNotificationAt = new Date().toISOString();
    lastNotificationError = failed.length ? failed.map((entry) => entry.error).join("; ").slice(0, 500) : null;
    for (const entry of failed) console.error(`Night Shift notification ${entry.id} failed: ${entry.error}`);
  } catch (error) {
    lastNotificationError = error.message;
    console.error(`Night Shift notifications failed: ${error.message}`);
  }
}

function scheduleSchedulerRetry() {
  schedulerRetryMs = Math.min(schedulerRetryMs ? schedulerRetryMs * 2 : schedulerRetryMinMs, schedulerRetryMaxMs);
  changeScheduler.enqueueAfter("scheduler.retry", schedulerRetryMs);
}

function probeDispatchCapacity() {
  if (capacityProbePromise || shuttingDown) return capacityProbePromise;
  // A probe of a restarting Gateway would read as overload and brake dispatch.
  if (gatewayRestart.snapshot().status !== "up") return;
  if (dispatchPressureGuard.lastProbe && !cardCache.some(card => cardIsStartable(card, Date.now()))) return;
  capacityProbePromise = (async () => {
    const running = activeCardCount(cardCache);
    let pressure;
    try {
      const [hostPressure, agentDbPressure] = await Promise.all([probeHostPressure(), probeAgentDbPressure()]);
      const probe = hostPressure.blocked ? {} : await workboard.probeGatewayCapacity();
      pressure = dispatchPressureGuard.recordProbe({ ...probe, hostPressure, agentDbPressure, running });
      if (Number.isSafeInteger(probe.workerPool?.workerCapacity)) lastWorkerCapacity = probe.workerPool.workerCapacity;
    } catch (error) {
      if (isGatewayRestartError(error)) {
        holdForGateway(error.message);
        return;
      }
      pressure = dispatchPressureGuard.recordProbe({ error: error.message, running });
    }
    if (pressure.dispatchAllowed && pressure.availableStarts > 0 && cardCache.some((card) => cardIsStartable(card, Date.now()))) {
      changeScheduler.enqueue("gateway.capacity");
    }
  })().finally(() => {
    capacityProbePromise = null;
  });
  return capacityProbePromise;
}

function warmupMaxCards() {
  return warmupMaxStartsSetting ?? derivedWarmupMaxCards(lastWorkerCapacity);
}

// Feeds dispatch-hold-ledger.mjs: is a card waiting to start, and what holds it.
function observeDispatchHold() {
  if (shuttingDown) return;
  const now = Date.now();
  const dispatching = new Map();
  const waiting = cardCache.some((card) => {
    if (!cardIsStartable(card, now) || (card.labels ?? []).includes("nightshift:approval")) return false;
    const instanceId = (card.labels ?? []).find((label) => label.startsWith("instance:"))?.slice("instance:".length);
    if (!instanceId) return false;
    if (!dispatching.has(instanceId)) {
      dispatching.set(instanceId, store.getInstance(instanceId)?.status === "active" && store.getInstanceControl(instanceId).automaticDispatch);
    }
    return dispatching.get(instanceId);
  });
  const running = activeCardCount(cardCache);
  const pressure = dispatchPressureGuard.snapshot(running);
  const warmup = warmupAdmission(cardCache, { windowMs: warmupWindowMs, maxWarming: warmupMaxCards() });
  const reason = dispatchHoldReason({
    waiting, gatewayStatus: gatewayRestart.snapshot().status, circuitOpen: schedulerCircuit.snapshot().open, pressure, warmup,
  });
  dispatchHolds.observe(reason, {
    running, targetMaxActive: pressure.targetMaxActive, workerCapacity: lastWorkerCapacity, maxWarming: warmup.maxWarming,
  });
}

runtime.callPreflight = async (release, project) => {
  const result = await preflightProjectSkills(release, project);
  if (!result.ok) throw new Error(preflightError(result));
};
runtime.beforeCallTick = instance => syncContentItemsManifest(instance);

async function startInstance(instance) {
  assertInstanceId(instance.id);
  const instanceDir = resolve(dataDir, "instances", instance.id);
  await mkdir(instanceDir, { recursive: true });
  const prepared = {
    ...instance,
    inputs: {
      ...(instance.inputs ?? {}),
      governance: normalizeProjectGovernance(instance),
      nightshift: {
        ...(instance.inputs?.nightshift ?? {}),
        instanceDir,
        contentItemsManifestPath: join(instanceDir, "content-items.json"),
        projectInputsPath: join(instanceDir, "project-inputs.json"),
      },
    },
  };
  await writeProjectInputsSnapshot(prepared);
  return runtime.startInstance(prepared);
}

async function scheduleStartedInstance(instanceId) {
  // Project start materializes its ready cards but never starts a Session
  // directly. The event scheduler owns every launch so the shared Gateway
  // pressure guard and global burst budget cannot be bypassed by concurrent
  // create/start API calls.
  const result = await serializedTick(instanceId, { dispatch: false, dryRun: false });
  await refreshCards({ cardIds: instanceCardIds(store, instanceId) });
  if (store.getInstanceControl(instanceId).automaticDispatch) {
    changeScheduler.enqueue("instance.started");
  }
  return result;
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

function preflightError(preflight) {
  const missingSkills = preflight.agents.some((entry) => entry.missingSkills.length > 0);
  const missingCommands = preflight.commands?.missing?.length > 0;
  if (missingSkills && missingCommands) return "Required Night Shift Skills and commands are unavailable";
  if (missingCommands) return `Required commands are not on PATH for the worker host: ${preflight.commands.missing.join(", ")}`;
  return "Required Night Shift Skills are unavailable";
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
  const commands = requiredCommands(release, project.inputs ?? {});
  const missing = missingCommands(commands);
  return {
    agents,
    commands: { missing, required: commands },
    ok: agents.every((entry) => entry.missingSkills.length === 0) && missing.length === 0,
    workflowSha256: release.metadata.workflowSha256,
  };
}

function serializedOperation(operation) {
  const run = tickQueue.catch(() => undefined).then(operation);
  tickQueue = run.catch(() => undefined);
  return run;
}

async function serializedTick(instanceId, options) {
  // Every API launch request enters the same scheduler and pressure budget.
  // Materialize/validate synchronously, then enqueue admission separately.
  const result = await serializedOperation(() => tickWithFaultProjection({
    instanceId, options: { ...options, dispatch: false }, runtime, store, workboard,
  }));
  if (options.dispatch && !options.dryRun) changeScheduler.enqueue("api.dispatch");
  return result;
}

function positiveInteger(value, fallback, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

// Explicit refresh entry points read only the cards of projects that are not
// archived; the archived majority of a mature board is never shown or
// scheduled. Governance may ask for the whole board. Either read is served
// from the cache when a recent one exists, so a polling client cannot make
// the Gateway walk its card store every few seconds.
let lastVisibleRefreshAt = 0;
let lastFullRefreshAt = 0;
async function refreshVisibleCards({ includeArchived = false } = {}) {
  const now = Date.now();
  const last = includeArchived ? lastFullRefreshAt : Math.max(lastVisibleRefreshAt, lastFullRefreshAt);
  if (now - last < cardRefreshMinIntervalMs) return cardCache;
  if (includeArchived) {
    const cards = await refreshCards();
    lastFullRefreshAt = Date.now();
    return cards;
  }
  await refreshCards({ cardIds: visibleCardIds(store) });
  lastVisibleRefreshAt = Date.now();
  return cardCache;
}

let cardCacheDigest = null;

async function refreshCards({ cardIds = null } = {}) {
  const scoped = Array.isArray(cardIds);
  const normalizedCardIds = scoped ? [...new Set(cardIds)].sort() : null;
  const scope = normalizedCardIds ? normalizedCardIds.join("\n") : "*";
  if (cardRefreshPromise) {
    if (cardRefreshScope === scope) return cardRefreshPromise;
    await cardRefreshPromise;
    return refreshCards({ cardIds });
  }
  cardRefreshScope = scope;
  cardRefreshPromise = workboard.listCards(scoped ? { cardIds: normalizedCardIds } : {}).then((cards) => {
    if (scoped) {
      const merged = new Map(cardCache.map((card) => [card.id, card]));
      for (const id of normalizedCardIds) merged.delete(id);
      for (const card of cards) merged.set(card.id, card);
      cardCache = [...merged.values()];
    } else {
      cardCache = cards;
    }
    // Only move the timestamp when the board actually changed: it is part of
    // the bootstrap body, so bumping it every refresh would change the ETag
    // and turn every poll into a full download even on a quiet board.
    const digest = createHash("sha1").update(JSON.stringify(cardCache)).digest("base64url");
    if (digest !== cardCacheDigest) {
      cardCacheDigest = digest;
      cardsUpdatedAt = new Date().toISOString();
    }
    return cards;
  }).finally(() => {
    cardRefreshPromise = null;
    cardRefreshScope = null;
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
  let source;
  try {
    source = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" || !contentItemId) throw error;
    source = await deliverablesFromItemHandoffs(instanceId, contentItemId);
    if (!source) throw error;
  }
  return normalizeDeliverablesManifest(source, { instanceId, contentItemId });
}

// No deliverables.json: fall back to the video the item's stage handoffs
// record (星擎夜班 D writes produce/final.mp4 and no manifest).
async function deliverablesFromItemHandoffs(instanceId, contentItemId) {
  const itemRoot = resolve(dataDir, "instances", instanceId, "content-items", contentItemId);
  let names;
  try {
    names = (await readdir(resolve(itemRoot, "handoffs"))).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const handoffs = [];
  for (const name of names) {
    try { handoffs.push(JSON.parse(await readFile(resolve(itemRoot, "handoffs", name), "utf8"))); } catch { /* an unreadable handoff is skipped */ }
  }
  // Completion accepts an absolute path inside the instance; the video link must too.
  const instanceRoot = resolve(dataDir, "instances", instanceId);
  for (const handoff of handoffs) {
    for (const output of handoff?.outputs ?? []) {
      if (output && typeof output.artifact === "string") output.artifact = instanceRelativeArtifactPath(output.artifact, [instanceRoot]);
    }
  }
  const item = store.listContentItems(instanceId).find((entry) => entry.id === contentItemId);
  const draft = deliverablesFromHandoffs(handoffs, { instanceId, contentItemId, title: item?.title ?? null });
  if (!draft) return null;
  const asset = await readFile(resolve(itemRoot, dirname(draft.video.path), "finishedAsset.json"), "utf8").then(JSON.parse).catch(() => null);
  return asset ? deliverablesFromHandoffs(handoffs, { instanceId, contentItemId, title: item?.title ?? null, asset }) : draft;
}

async function validateCompletion({ card, contentItemId, instance, release, reuseExecutionEvidence = false, stageId, submittedAttempt, terminalSession }) {
  const stage = release?.spec?.stages?.find((entry) => entry.id === stageId);
  const evidence = {};
  let handoff = null;
  const completionArtifacts = new Map();
  const human = humanCompletionEvidence({ store, card, instance, stageId, contentItemId, submittedAttempt });
  if (human) evidence.humanAttempt = human;
  if (stage?.actor === "agent" && !human) {
    const attempt = nativeCardAttempts(card).at(-1);
    if (!attempt?.sessionKey || !attempt.runId) throw new Error("Agent completion requires an auditable Workboard Session and runId");
    if (reuseExecutionEvidence) {
      evidence.execution = { source: "previous-terminal-validation", status: "reused" };
    } else {
      try {
        const result = terminalSession ?? await workboard.getSession(attempt.sessionKey, { limit: 120 });
        const rangeStart = Number(attempt.startedAt || 0) - 5000;
        const rangeEnd = Number(attempt.endedAt || Number.POSITIVE_INFINITY) + 5000;
        const messages = (result.messages ?? []).filter((message) =>
          !message.timestamp || (Number(message.timestamp) >= rangeStart && Number(message.timestamp) <= rangeEnd));
        evidence.execution = validateExecutionEvidence({
          cardId: card.id,
          messages,
          requiredSkills: card.metadata?.automation?.skills ?? [],
        });
      } catch (error) {
        error.completionPhase ??= "execution";
        throw error;
      }
    }
    evidence.sessionKey = attempt.sessionKey;
    evidence.runId = attempt.runId;
  }
  if ((stage?.sideEffects ?? []).length > 0) {
    try {
      const contentItem = contentItemId
        ? runtime.contentItemsWithRevisions(instance.id).find((entry) => entry.id === contentItemId)
        : null;
      const projectRun = contentItemId ? null : store.listStageRuns(instance.id).find(run => run.cardId === card.id && run.stageId === stageId);
      const operationKeys = resolveNightShiftOperationKeys({ card, release, instance, contentItem, projectRun });
      const operation = findNightShiftExternalOperation({
        card,
        candidateIdempotencyKeys: operationKeys.candidateIdempotencyKeys,
        operations: store.listExternalOperations(instance.id),
      });
      evidence.externalOperation = await validateExternalOperationCompletion({ card, operation, stage,
        loadReceipt: async (name) => {
          const raw = await loadStageHandoff({ contentItemId, instance, release, stageId, required: true });
          const manifest = normalizeStageHandoff(raw, { contentItemId, instanceId: instance.id, release, stageId });
          handoff = manifest;
          const entry = manifest.outputs.find(output => output.name === name);
          if (!entry) throw new Error("Declared terminal attempt receipt is missing from the handoff");
          const handoffDir = dirname(stageHandoffPath({ instanceDir: instance.inputs?.nightshift?.instanceDir ?? resolve(dataDir, "instances", instance.id), contentItemId, release, stageId }));
          const loaded = await loadInstanceArtifact({ artifact: entry.artifact, contentItemId, instance, handoffDir, hash: Boolean(human) });
          if (!loaded.exists || !loaded.json) throw new Error("Terminal attempt receipt must be a local JSON artifact");
          completionArtifacts.set(entry.artifact, loaded);
          return loaded.json;
        },
      });
    } catch (error) {
      error.completionPhase ??= "side_effect";
      throw error;
    }
  }
  if (release?.spec?.handoff?.version === 1) {
    try {
      if (!handoff) {
        const manifest = await loadStageHandoff({ contentItemId, instance, release, stageId, required: true });
        handoff = normalizeStageHandoff(manifest, { contentItemId, instanceId: instance.id, release, stageId });
      }
    } catch (error) {
      error.completionPhase ??= "handoff";
      throw error;
    }
  }
  if (release?.spec?.completion?.mode === "strict-v1") {
    const handoffDir = handoff
      ? dirname(stageHandoffPath({ instanceDir: instance.inputs?.nightshift?.instanceDir ?? resolve(dataDir, "instances", instance.id), contentItemId, release, stageId }))
      : null;
    try {
      evidence.outputs = (await validateDeclaredCompletion({
        checkUrl: checkCompletionUrl,
        instanceCreatedAt: instance.createdAt,
        loadArtifact: async (artifact) => {
          const loaded = completionArtifacts.get(artifact) ?? await loadInstanceArtifact({ artifact, contentItemId, instance, hash: Boolean(human), handoffDir });
          if (human) (evidence.artifacts ??= []).push({ artifact, sha256: loaded.sha256 });
          return loaded;
        },
        manifest: handoff,
        stage,
      })).output;
    } catch (error) {
      error.completionPhase ??= "outputs";
      throw error;
    }
  }
  if (writesContentItemsManifest(release, stage)) {
    // The stage that writes the manifest finishes only with one the import takes,
    // checked by the import's own rules on the file the import reads. Otherwise the
    // stage completed, the import refused the file on every pass and the project
    // stood still with nobody told (V, 2026-10-22: GEE-TIMED-PUB-20261018,
    // F-MERGED-ACCEPT-20261019-BR-B). Rejected, the error goes back to the Agent.
    try {
      const manifestPath = join(dataDir, "instances", instance.id, "content-items.json");
      const source = await readFile(manifestPath, "utf8").catch((error) => {
        if (error.code === "ENOENT") throw new Error(`content-items.json was not written: Night Shift imports content items only from ${manifestPath}`);
        throw error;
      });
      const issues = contentItemsManifestIssues(source, {
        path: manifestPath,
        maxItems: release.spec.contentItems?.maxItems ?? 50,
        routes: release.spec.contentItems?.routes ?? [],
      });
      if (issues.length) throw new Error(`Content items manifest cannot be imported: ${issues.join("; ")}`);
      evidence.contentItemsManifest = { path: manifestPath, checked: true };
    } catch (error) {
      error.completionPhase ??= "outputs";
      throw error;
    }
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

async function loadInstanceArtifact({ artifact, contentItemId = null, instance, hash = false, handoffDir = null }) {
  const configuredRoot = instance.inputs?.nightshift?.instanceDir ?? resolve(dataDir, "instances", instance.id);
  const instanceRoot = await realpath(configuredRoot);
  const normalizedPath = normalizeArtifactPath(instanceRelativeArtifactPath(artifactFromHandoffDirectory(artifact, handoffDir), [configuredRoot, instanceRoot]));
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

function projectConcurrency(instance) {
  const release = store.getRelease(instance.workflowSha256)?.manifest;
  const own = store.getInstanceControl(instance.id).perInstanceLimit;
  return {
    effective: projectConcurrencyLimit(release, { perInstanceLimit: own }),
    project: own,
    workflow: release?.spec?.concurrency?.perInstance ?? 1,
    max: PROJECT_CONCURRENCY_MAX,
  };
}

function withInstanceLinks(instance) {
  const control = { ...store.getInstanceControl(instance.id), queue: projectQueue.get(instance.id) ?? null, concurrency: projectConcurrency(instance) };
  return { ...instance, calls: publicCallSummary(store, instance.id), governance: normalizeProjectGovernance(instance), control, links: projectLinks(instance.id) };
}

function countCardsByStatus(cards) {
  return Object.fromEntries([...new Set(cards.map((card) => card.status))].sort().map((status) => [status, cards.filter((card) => card.status === status).length]));
}

function withCardLinks(card) {
  const id = cardInstanceId(card);
  const call = id ? publicCallSummary(store, id).filter(call => call.cardId === card.id).at(-1) : null;
  return { ...card, ...(call ? { metadata: { ...card.metadata, automation: { ...card.metadata?.automation, workflowCall: { iteration: call.iteration, state: call.state, blocked: call.blocked, reason: call.reason } } } } : {}), humanAttempt: publicHumanAttempt(store.getHumanAttempt(card.id)), links: cardLinks(card.id) };
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
    const instanceId = store.rootInstanceId(cardInstanceId(card));
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

async function serveDeliverTemplate(response, pathname) {
  const headers = {
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src ${DELIVER_SOURCES}; connect-src ${DELIVER_SOURCES}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  };
  const asset = pathname.match(/^\/deliver\/static\/([A-Za-z0-9._-]+)$/u);
  if (asset) {
    const filePath = resolve(deliverRoot, "static", asset[1]);
    const content = await readFile(filePath).catch(() => null);
    if (!content) {
      response.writeHead(404, headers).end("Not found");
      return;
    }
    response.writeHead(200, { ...headers, "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": contentType(filePath) });
    response.end(content);
    return;
  }
  const page = /^\/deliver\/?$/u.test(pathname) ? await readFile(resolve(deliverRoot, "index.html")).catch(() => null) : null;
  if (!page) {
    response.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  response.writeHead(200, { ...headers, "Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8" });
  response.end(page);
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

function json(response, status, value, options) {
  sendJson(response.req, response, status, value, options);
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
  changeScheduler.stop();
  if (capacityProbeTimer) clearInterval(capacityProbeTimer);
  capacityProbeTimer = null;
  if (holdObservationTimer) clearInterval(holdObservationTimer);
  holdObservationTimer = null;
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
  let finished = false;
  let forceTimer;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(forceTimer);
    Promise.resolve(workboard.close()).catch(() => undefined).finally(() => {
      store.close();
      process.exit(0);
    });
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
