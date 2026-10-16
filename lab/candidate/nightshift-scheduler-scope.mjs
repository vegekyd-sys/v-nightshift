// Mechanism benchmark against a bounded, read-transaction export of native
// Workboard rows. No model calls, native dispatch, or shared writes. It is not
// an acceptance test for twelve running Agents or a foreground conversation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { schedulerCardIds as candidate } from "../../packages/nightshift-core/src/scheduler-pass.mjs";

const input = process.env.NS_SCOPE_SNAPSHOT;
const runtime = process.env.VLAB_CANDIDATE_RUNTIME;
assert(input && runtime && process.env.VLAB_CANDIDATE_DATA, "snapshot and candidate environment required");
const encoded = fs.readFileSync(input);
const bytes = input.endsWith(".gz") ? gunzipSync(encoded) : encoded;
const snapshot = JSON.parse(bytes);
const inventory = snapshot.inventory;
const store = {
  listInstances: () => inventory.projects,
  listStageRuns: id => inventory.runs.filter(run => run.instance_id === id).map(run => ({
    cardId: run.card_id, status: run.status, failure: run.failure, updatedAt: run.updated_at,
  })),
  listContentItemRuns: () => [],
  listActionCardIds: id => inventory.ledger.filter(row => row.instance_id === id).map(row => row.card_id),
};
const variants = { candidate };
for (const [name, env] of [["september17", "NS_SCOPE_SEPTEMBER17"], ["production", "NS_SCOPE_PRODUCTION"]]) {
  assert(process.env[env], `${env} source is required`);
  variants[name] = (await import(pathToFileURL(path.resolve(process.env[env])))).schedulerCardIds;
}
const scopes = Object.fromEntries(Object.entries(variants).map(([name, fn]) => [name, fn(store, null, { fullSweep: false })]));
const repair = candidate(store, null, { fullSweep: true });
for (const fn of Object.values(variants)) assert.deepEqual(fn(store, null, { fullSweep: true }).sort(), repair.toSorted());
const kept = new Set(scopes.candidate);
const nativeActive = snapshot.tables.workboard_cards.filter(row => !['done', 'cancelled'].includes(row.status));
for (const row of nativeActive) assert(kept.has(row.id), "native work in flight was lost");
for (const run of inventory.runs) {
  if (!['done', 'cancelled'].includes(run.status)) assert(kept.has(run.card_id), "live/recovery card was lost");
}
const runIds = new Set(inventory.runs.map(run => run.card_id));
for (const row of inventory.ledger) if (!runIds.has(row.card_id)) assert(kept.has(row.card_id), "approval-only ledger card was lost");

const dbPath = path.join(process.env.VLAB_CANDIDATE_DATA, "scope-workboard.sqlite");
assert(!fs.existsSync(dbPath), "private destination must be new");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys=OFF; BEGIN");
for (const schema of snapshot.schema.filter(row => row.type === "table")) db.exec(schema.sql);
for (const [table, rows] of Object.entries(snapshot.tables)) {
  if (!rows.length) continue;
  const columns = Object.keys(rows[0]);
  assert(columns.every(key => /^[a-z_][a-z0-9_]*$/.test(key)) && /^[a-z_][a-z0-9_]*$/.test(table));
  const statement = db.prepare(`INSERT INTO "${table}" (${columns.map(key => `"${key}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (const row of rows) statement.run(...columns.map(key => row[key]));
}
for (const schema of snapshot.schema.filter(row => row.type === "index" || row.type === "trigger")) db.exec(schema.sql);
db.exec(`PRAGMA user_version=${Number(snapshot.userVersion)}; COMMIT`);
db.close();
const dist = path.join(runtime, "openclaw", "dist");
const nativeFile = fs.readdirSync(dist).find(file => /^sqlite-store-.*\.js$/.test(file) &&
  fs.readFileSync(path.join(dist, file), "utf8").includes("WorkboardSqliteCardStore"));
assert(nativeFile, "native Workboard SQLite module missing");
const native = await import(pathToFileURL(path.join(dist, nativeFile)));
const nativeStores = native.t({ dbPath });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const metrics = Object.fromEntries(Object.keys(scopes).map(name => [name, []]));
const signatures = new Map();
let before;
try {
  // Alternate the order to avoid attributing warm-cache gains to the patch.
  for (let round = 0; round < 12; round++) {
    const order = round % 2 ? Object.keys(scopes).reverse() : Object.keys(scopes);
    for (const name of order) {
      const ids = scopes[name];
      const started = performance.now();
      const rows = await Promise.all(ids.map(id => nativeStores.cards.lookup(id)));
      assert(rows.every(Boolean), "snapshot is missing selected native cards");
      const payloadBytes = Buffer.byteLength(JSON.stringify(rows));
      const ms = performance.now() - started;
      const signature = hash(rows);
      if (signatures.has(name)) assert.equal(signature, signatures.get(name), "read changed the native rows");
      signatures.set(name, signature);
      metrics[name].push({ ms: Math.round(ms * 1000) / 1000, payloadBytes, nativeLookups: ids.length });
    }
    if (round === 0) before = hash(await Promise.all(repair.map(id => nativeStores.cards.lookup(id))));
  }
  const allRows = await Promise.all(repair.map(id => nativeStores.cards.lookup(id)));
  assert.equal(allRows.filter(Boolean).length, repair.length);
  assert.equal(hash(allRows), before, "read benchmark changed a native card");
} finally { nativeStores.close(); }
const quantile = (values, q) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * q) - 1];
console.log(JSON.stringify({
  evidence: "real native SQLite reads on one bounded production snapshot; not twelve running Agents or foreground E2E",
  snapshotSha256: createHash('sha256').update(bytes).digest('hex'), snapshotBytes: bytes.length,
  exportMs: snapshot.exportMs, projects: inventory.projects.length, runs: inventory.runs.length,
  ledger: inventory.ledger.length, tables: Object.fromEntries(Object.entries(snapshot.tables).map(([name, rows]) => [name, rows.length])),
  nativeNonsettledCards: nativeActive.length,
  sourceModule: nativeFile, sourceModuleSha256: createHash('sha256').update(fs.readFileSync(path.join(dist, nativeFile))).digest('hex'),
  repairCards: repair.length, scopeCards: Object.fromEntries(Object.entries(scopes).map(([name, ids]) => [name, ids.length])),
  scopeIdHashes: Object.fromEntries(Object.entries(scopes).map(([name, ids]) => [name, hash(ids.toSorted())])),
  outputHashes: Object.fromEntries(signatures),
  metrics: Object.fromEntries(Object.entries(metrics).map(([name, samples]) => [name, {
    samples: samples.length, firstPassMs: samples[0].ms,
    warmMedianMs: quantile(samples.slice(1).map(row => row.ms), .5), warmP95Ms: quantile(samples.slice(1).map(row => row.ms), .95),
    medianMs: quantile(samples.map(row => row.ms), .5), p95Ms: quantile(samples.map(row => row.ms), .95),
    payloadBytes: samples[0].payloadBytes, nativeLookups: samples[0].nativeLookups,
    perPassMs: samples.map(row => row.ms),
  }])),
  nativeRowsUnchanged: true, allLiveRecoveryApprovalCardsKept: true, allRepairScopesEqual: true,
}));
