import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deliverableArtifactPaths,
  NightShiftRuntime,
  NightShiftStore,
  normalizeArtifactPath,
  normalizeDeliverablesManifest,
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
let tickQueue = Promise.resolve();
let shuttingDown = false;

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
  const artifactMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/artifacts\/(.+)$/);
  if ((request.method === "GET" || request.method === "HEAD") && artifactMatch) {
    const instanceId = decodeURIComponent(artifactMatch[1]);
    const relativePath = decodeURIComponent(artifactMatch[2]);
    await serveDeliverableArtifact(request, response, instanceId, relativePath);
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
    await refreshCards();
    let changed = false;
    for (const instance of store.listInstances()) {
      if (instance.status !== "active") continue;
      const result = await serializedTick(instance.id, { dispatch: true });
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

function serializedTick(instanceId, options) {
  const run = tickQueue
    .catch(() => undefined)
    .then(async () => {
      const cards = await workboard.listCards();
      return runtime.tick(instanceId, { ...options, cards });
    });
  tickQueue = run.catch(() => undefined);
  return run;
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

async function loadDeliverables(instanceId) {
  assertInstanceId(instanceId);
  const manifestPath = resolve(dataDir, "instances", instanceId, "deliverables.json");
  const source = JSON.parse(await readFile(manifestPath, "utf8"));
  return normalizeDeliverablesManifest(source, { instanceId });
}

async function presentDeliverables(manifest) {
  const artifactUrl = (path) => path
    ? `/api/instances/${encodeURIComponent(manifest.instanceId)}/artifacts/${path.split("/").map(encodeURIComponent).join("/")}`
    : null;
  return {
    ...manifest,
    proposal: {
      ...manifest.proposal,
      summary: await readArtifactText(manifest, manifest.proposal.summaryPath),
      summaryUrl: artifactUrl(manifest.proposal.summaryPath),
    },
    video: {
      ...manifest.video,
      url: artifactUrl(manifest.video.path),
      posterUrl: artifactUrl(manifest.video.posterPath),
    },
    qc: {
      ...manifest.qc,
      report: await readArtifactText(manifest, manifest.qc.reportPath),
      reportUrl: artifactUrl(manifest.qc.reportPath),
    },
  };
}

async function readArtifactText(manifest, relativePath) {
  if (!relativePath) return null;
  const filePath = await resolveDeclaredArtifact(manifest, relativePath);
  const content = await readFile(filePath, "utf8");
  return content.slice(0, 24000);
}

async function serveDeliverableArtifact(request, response, instanceId, requestedPath) {
  let manifest;
  try {
    manifest = await loadDeliverables(instanceId);
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
    filePath = await resolveDeclaredArtifact(manifest, relativePath);
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

async function resolveDeclaredArtifact(manifest, relativePath) {
  const normalizedPath = normalizeArtifactPath(relativePath);
  if (!deliverableArtifactPaths(manifest).has(normalizedPath)) {
    throw new Error("Artifact is not declared in the delivery manifest");
  }
  const instanceRoot = await realpath(resolve(dataDir, "instances", manifest.instanceId));
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
