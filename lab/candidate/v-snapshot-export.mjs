// Read-only export of what Night Shift's engine decides on, from V, for a VLab candidate to replay
// (docs/change-flow.md: verify against V's latest data before merging, never by acting on V).
//
//   ssh v 'sudo -u openclaw node --input-type=module -' < lab/candidate/v-snapshot-export.mjs | gzip > snapshot.json.gz
//
// It opens the Night Shift database read-only and reads project files; it writes nothing on V.
// It carries the latest release of every Workflow, the projects active or updated in the last
// SNAPSHOT_DAYS days (default 14) with their content items, and each one's content-items.json.
// Project inputs keep only the keys the brief and the planner read. No media, no transcripts, no
// credentials, so it stays out of git: keep it on the VLab host.
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DATA = process.env.NIGHTSHIFT_DATA_DIR ?? "/home/openclaw/.openclaw/nightshift";
const DAYS = Number(process.env.SNAPSHOT_DAYS ?? 14);
const db = new DatabaseSync(join(DATA, "nightshift.sqlite"), { readOnly: true });
const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
const releases = db.prepare(`SELECT workflow_sha, workflow_id, version, source_yaml, manifest_json, published_at FROM workflow_releases r
  WHERE published_at = (SELECT MAX(published_at) FROM workflow_releases x WHERE x.workflow_id = r.workflow_id)
     OR workflow_sha IN (SELECT workflow_sha FROM instances WHERE status = 'active' OR updated_at >= ?)`).all(since);
const KEPT_INPUTS = ["deliveryMode", "targetCount", "enterpriseName", "routePlan", "authorizationScope", "nightshift"];
const instances = [];
for (const row of db.prepare("SELECT id, name, workflow_sha, status, inputs_json, created_at, updated_at FROM instances WHERE status = 'active' OR updated_at >= ?").all(since)) {
  const inputs = JSON.parse(row.inputs_json);
  const kept = Object.fromEntries(KEPT_INPUTS.filter((key) => key in inputs).map((key) => [key, inputs[key]]));
  const contentItems = db.prepare("SELECT id, title, route, status, ordinal FROM content_items WHERE instance_id = ? ORDER BY ordinal").all(row.id);
  const manifest = await readFile(join(DATA, "instances", row.id, "content-items.json"), "utf8").catch(() => null);
  instances.push({ id: row.id, name: row.name, workflowSha256: row.workflow_sha, status: row.status, inputs: kept, createdAt: row.created_at, contentItems, manifest });
}
process.stdout.write(JSON.stringify({ exportedAt: new Date().toISOString(), since, releases, instances }));
