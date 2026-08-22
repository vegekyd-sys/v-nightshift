import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NightShiftRuntime,
  NightShiftStore,
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
    resolve(appRoot, "../../examples/workflows/xingqing-content-delivery.v0.2.yaml"),
);
const board = process.env.NIGHTSHIFT_BOARD ?? "nightshift-lab";
await mkdir(dataDir, { recursive: true });
const store = new NightShiftStore(join(dataDir, "nightshift.sqlite"));
const workboard = new WorkboardGatewayAdapter({ board });
const runtime = new NightShiftRuntime({ board, store, workboard });
let cardCache = [];
let cardsUpdatedAt = null;
let cardRefreshPromise = null;
let lastSchedulerAt = null;
let lastSchedulerError = null;
let schedulerPromise = null;

await ensureWorkflow();
await ensureSeedInstance();
await refreshCards();
await reconcileSeededInstances(cardCache);
const schedulerTimer = setInterval(() => {
  runScheduler();
}, 30000);
schedulerTimer.unref();
const initialSchedulerTimer = setTimeout(() => runScheduler(), 1000);
initialSchedulerTimer.unref();

const server = createServer(async (request, response) => {
  try {
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
    json(response, 200, {
      board,
      cardsUpdatedAt,
      lastSchedulerAt,
      lastSchedulerError,
      ok: true,
      service: "nightshift-workboard",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    if (url.searchParams.get("refresh") === "1") await refreshCards();
    const instances = store.listInstances().map((instance) => ({
      ...instance,
      stageRuns: store.listStageRuns(instance.id),
    }));
    json(response, 200, {
      board,
      cards: cardCache,
      cardsUpdatedAt,
      events: store.listEvents(null, 80),
      instances,
      workflows: store.listReleases(),
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/workflows/validate") {
    const body = await bodyJson(request);
    const result = runtime.validate(body.sourceYaml ?? "");
    json(response, 200, { issues: result.issues, ok: result.ok });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/workflows/draft") {
    const body = await bodyJson(request);
    json(response, 200, runtime.saveDraft(body.sourceYaml ?? ""));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/workflows/publish") {
    const body = await bodyJson(request);
    json(response, 200, runtime.publish(body.sourceYaml ?? ""));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/instances") {
    const body = await bodyJson(request);
    json(response, 201, runtime.startInstance(body));
    return;
  }
  const instanceInputMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/inputs$/);
  if (request.method === "PATCH" && instanceInputMatch) {
    const body = await bodyJson(request);
    json(
      response,
      200,
      runtime.updateInstanceInputs(
        decodeURIComponent(instanceInputMatch[1]),
        body.inputs ?? {},
      ),
    );
    return;
  }
  const tickMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/tick$/);
  if (request.method === "POST" && tickMatch) {
    const body = await bodyJson(request);
    const result =
      await runtime.tick(decodeURIComponent(tickMatch[1]), {
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
  const decisionMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/(approve|request-changes|reject)$/);
  if (request.method === "POST" && decisionMatch) {
    const body = await bodyJson(request);
    const input = {
      ...body,
      cardId: decodeURIComponent(decisionMatch[1]),
    };
    const result = decisionMatch[2] === "approve"
      ? await runtime.approve(input)
      : decisionMatch[2] === "request-changes"
        ? await runtime.requestChanges(input)
        : await runtime.reject(input);
    await refreshCards();
    json(response, 200, result);
    return;
  }
  json(response, 404, { error: "Not found" });
}

async function ensureWorkflow() {
  const source = await readFile(workflowPath, "utf8");
  runtime.saveDraft(source);
  if (store.listReleases().length === 0) runtime.publish(source);
}

async function ensureSeedInstance() {
  const seedPath = process.env.NIGHTSHIFT_SEED_INSTANCE_PATH;
  if (!seedPath || store.listInstances().length > 0) return;
  const seed = JSON.parse(await readFile(resolve(seedPath), "utf8"));
  const release = store.listReleases()[0];
  runtime.startInstance({ ...seed, workflowSha256: release.workflowSha256 });
}

async function reconcileSeededInstances(cards) {
  for (const instance of store.listInstances()) {
    await runtime.reconcile(instance.id, cards);
  }
}

function runScheduler() {
  if (schedulerPromise) return schedulerPromise;
  schedulerPromise = (async () => {
    const cards = await refreshCards();
    let changed = false;
    for (const instance of store.listInstances()) {
      if (instance.status !== "active") continue;
      const result = await runtime.tick(instance.id, { cards, dispatch: true });
      if (result.applied.length > 0) changed = true;
    }
    if (changed) await refreshCards();
    lastSchedulerAt = new Date().toISOString();
    lastSchedulerError = null;
  })().catch((error) => {
    lastSchedulerAt = new Date().toISOString();
    lastSchedulerError = error.message;
    console.error(`Night Shift scheduler failed: ${error.message}`);
  }).finally(() => {
    schedulerPromise = null;
  });
  return schedulerPromise;
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
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  }[extname(path)] ?? "application/octet-stream";
}

function shutdown() {
  clearInterval(schedulerTimer);
  clearTimeout(initialSchedulerTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
