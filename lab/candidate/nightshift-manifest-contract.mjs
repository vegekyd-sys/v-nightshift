// Replays V's latest data (lab/candidate/v-snapshot-export.mjs) through this branch's engine:
// the board's card limits and the content-items manifest contract. Reads the snapshot only.
//
// Asserts, on every project and Workflow V had in the snapshot window:
//   - no latest Workflow release fails the new publish-time Workboard limits;
//   - every card the planner can make (each stage, each content item) has a title within the
//     board's 180 and a brief within its 12,000 characters;
//   - the stage-completion check finds an issue in a manifest exactly when the import refuses
//     it, an empty list aside (it now imports nothing instead of failing every pass);
//   - DL-1022-21's cards fit, and GEE-TIMED-PUB-20261022-BR no longer fails to import.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  buildAgentBrief, cardTitle, CARD_TITLE_MAX, contentItemsManifestIssues, contentItemsOfManifest,
  normalizeContentItems, parseWorkflow, validateWorkflow, WORKBOARD_NOTES_LIMIT,
} from "../../packages/nightshift-core/src/index.mjs";

const file = process.env.SNAPSHOT;
assert(file, "SNAPSHOT is required");
const snapshot = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
const releases = new Map(snapshot.releases.map((row) => [row.workflow_sha, { ...row, manifest: JSON.parse(row.manifest_json) }]));
const latest = new Map();
for (const row of releases.values()) if (!latest.has(row.workflow_id) || latest.get(row.workflow_id).published_at < row.published_at) latest.set(row.workflow_id, row);

const report = { exportedAt: snapshot.exportedAt, releases: releases.size, projects: snapshot.instances.length };

// 1. Publish-time limits on the Workflows V runs. Releases no project in the window uses are
// reported, not asserted: an old one may already be unusable on today's board.
const inUse = new Set(snapshot.instances.map((entry) => releases.get(entry.workflowSha256)?.workflow_id).filter(Boolean));
const publishIssues = [], unusedPublishIssues = [];
for (const row of latest.values()) {
  let issues;
  try { issues = validateWorkflow(parseWorkflow(row.source_yaml, `${row.workflow_id}.md`)); } catch (error) { issues = [{ code: "parse", message: error.message }]; }
  for (const entry of issues.filter((issue) => /label|workboard|skill\.name/.test(issue.code))) {
    (inUse.has(row.workflow_id) ? publishIssues : unusedPublishIssues).push(`${row.workflow_id}@${row.version}: ${entry.code} ${entry.message}`);
  }
}
Object.assign(report, { workflowsInUse: inUse.size, publishLimitIssues: publishIssues, unusedWorkflowPublishLimitIssues: unusedPublishIssues });

// 2. Every card the planner can make.
let cards = 0, oldTitleRefused = 0, briefErrors = [];
const titleOver = [];
const refusedBefore = new Map();
for (const instance of snapshot.instances) {
  const release = releases.get(instance.workflowSha256)?.manifest;
  if (!release) continue;
  const project = instance.name ?? instance.id;
  for (const stage of release.spec.stages) {
    const items = (stage.scope ?? "project") === "content-item" ? instance.contentItems : [null];
    for (const item of items) {
      cards += 1;
      const old = item ? `${project}｜${item.title}｜${stage.title}` : `${project}｜${stage.title}`;
      if (old.length > 180) { oldTitleRefused += 1; refusedBefore.set(instance.id, (refusedBefore.get(instance.id) ?? 0) + 1); }
      const title = cardTitle({ project, item: item ? item.title : null, stage: stage.title });
      if (title.length > CARD_TITLE_MAX) titleOver.push(`${instance.id}/${stage.id}/${item?.id ?? "-"}: ${title.length}`);
      try {
        const brief = buildAgentBrief(release, { ...instance, approvals: [] }, stage, item, instance.contentItems, []);
        if (brief.length > WORKBOARD_NOTES_LIMIT) briefErrors.push(`${instance.id}/${stage.id}: ${brief.length}`);
      } catch (error) {
        if (!/Missing agent binding|approval/i.test(error.message)) briefErrors.push(`${instance.id}/${stage.id}/${item?.id ?? "-"}: ${error.message.slice(0, 120)}`);
      }
    }
  }
}
Object.assign(report, { cards, oldTitleRefused, projectsWhoseCardsTheBoardRefusedBefore: Object.fromEntries(refusedBefore), titleOver, briefErrors: briefErrors.slice(0, 20), briefErrorCount: briefErrors.length });

// 3. The manifest contract against the import, on every content-items.json V holds.
const oldImportRefuses = (source, release) => {
  const parsed = JSON.parse(source);
  const items = Array.isArray(parsed) ? parsed : (parsed?.contentItems ?? parsed?.items);
  if (!Array.isArray(items) || items.length === 0) return true;
  try { normalizeContentItems(items, { maxItems: release.spec.contentItems?.maxItems ?? 50, routes: release.spec.contentItems?.routes ?? [] }); return false; } catch { return true; }
};
const disagreements = [], withIssues = [], emptyLists = [];
for (const instance of snapshot.instances) {
  const release = releases.get(instance.workflowSha256)?.manifest;
  if (!instance.manifest || !release?.spec?.contentItems) continue;
  const issues = contentItemsManifestIssues(instance.manifest, { maxItems: release.spec.contentItems.maxItems ?? 50, routes: release.spec.contentItems.routes ?? [], path: `${instance.id}/content-items.json` });
  let parsed = null;
  try { parsed = JSON.parse(instance.manifest); } catch {}
  const empty = Array.isArray(contentItemsOfManifest(parsed)) && contentItemsOfManifest(parsed).length === 0;
  if (empty) emptyLists.push(instance.id);
  let before;
  try { before = oldImportRefuses(instance.manifest, release); } catch { before = true; }
  if (issues.length) withIssues.push(`${instance.id} (${instance.status}): ${issues[0].slice(0, 140)}`);
  if (!empty && before !== issues.length > 0) disagreements.push(`${instance.id}: import ${before ? "refuses" : "takes"}, contract finds ${issues.length}`);
}
Object.assign(report, { manifestsChecked: snapshot.instances.filter((entry) => entry.manifest).length, manifestDisagreements: disagreements, manifestsWithIssues: withIssues, emptyLists });

// 4. Tonight's two projects.
const dl = snapshot.instances.find((entry) => entry.id === "DL-1022-21");
const gee = snapshot.instances.find((entry) => entry.id === "GEE-TIMED-PUB-20261022-BR");
report.DL_1022_21 = { refusedBefore: refusedBefore.get("DL-1022-21") ?? 0, titleOverNow: titleOver.filter((entry) => entry.startsWith("DL-1022-21/")).length };
report.GEE_BR = { importRefusedBefore: oldImportRefuses(gee.manifest, releases.get(gee.workflowSha256).manifest), issuesNow: contentItemsManifestIssues(gee.manifest).length, empty: emptyLists.includes(gee.id) };

console.log(JSON.stringify(report, null, 1));
assert.deepEqual(publishIssues, [], "a Workflow V runs would be refused at publish");
assert.deepEqual(titleOver, []);
assert.equal(briefErrors.length, 0, briefErrors.join("\n"));
assert.deepEqual(disagreements, [], "the completion contract and the import disagree");
assert.ok(report.DL_1022_21.refusedBefore > 0 && report.DL_1022_21.titleOverNow === 0);
assert.ok(report.GEE_BR.importRefusedBefore && report.GEE_BR.issuesNow === 0 && report.GEE_BR.empty);
