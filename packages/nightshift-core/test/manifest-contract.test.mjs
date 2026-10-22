import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildAgentBrief,
  cardTitle,
  compileWorkflow,
  contentItemsManifestIssues,
  contentItemsOfManifest,
  loadWorkflow,
  normalizeContentItems,
  parseWorkflowMarkdown,
  validateWorkflow,
  WORKBOARD_NOTES_LIMIT,
  writesContentItemsManifest,
} from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "fixtures/manifest-contract-20261023");
const workflowPath = resolve(here, "../../../examples/workflows/xingqing-content-delivery.workflow.md");
const ROUTES = ["AI_GENERATE", "SCENE_EDIT"];

// The import and the stage's completion use one rule set: a manifest has issues
// exactly when the import would refuse it.
function importRefuses(parsed) {
  const items = contentItemsOfManifest(parsed);
  if (items === null) return true;
  if (items.length === 0) return false;
  try {
    normalizeContentItems(items, { maxItems: 30, routes: ROUTES });
    return false;
  } catch {
    return true;
  }
}

test("V's two manifests from 2026-10-22/23: one imports as written, one is an empty scan", async () => {
  const dl = JSON.parse(await readFile(join(fixtures, "DL-1022-21.content-items.json"), "utf8"));
  assert.equal(dl.items.length, 30);
  assert.ok(dl.items.filter((item) => item.title.length > 180).length >= 20);
  assert.deepEqual(contentItemsManifestIssues(dl, { maxItems: 30, routes: ROUTES }), [], "long titles are not the manifest's fault");
  const gee = JSON.parse(await readFile(join(fixtures, "GEE-TIMED-PUB-20261022-BR.content-items.json"), "utf8"));
  assert.deepEqual(contentItemsOfManifest(gee), [], "an empty list, not a missing one");
  assert.deepEqual(contentItemsManifestIssues(gee), []);
});

test("completion finds what the import refuses, all of it at once", () => {
  const cases = [
    [{ rows: [{ id: "a" }] }, /has no contentItems or items array; it holds rows\(1\)/],
    ["{not json", /not valid JSON/],
    [{ items: [{ id: "F-MERGED-ACCEPT-20261019-BR-B-01", title: "x" }] }, /27 characters or fewer/],
    [{ items: [{ id: "a", title: "x" }, { id: "a", title: "y" }] }, /Duplicate content item id: a/],
    [{ items: [{ id: "a", title: "x", route: "TELEPORT" }] }, /Unsupported content route TELEPORT/],
    [{ items: [{ id: "a" }] }, /title is required/],
    [{ items: Array.from({ length: 31 }, (_, index) => ({ id: `i${index}`, title: "t" })) }, /at most 30/],
    [{ stableId: "x", items: [{ stableId: "ok", title: "documented field" }] }, null],
  ];
  for (const [manifest, expected] of cases) {
    const issues = contentItemsManifestIssues(manifest, { maxItems: 30, routes: ROUTES });
    if (expected) assert.match(issues.join("\n"), expected);
    else assert.deepEqual(issues, []);
    const parsed = typeof manifest === "string" ? null : manifest;
    if (parsed) assert.equal(issues.length > 0, importRefuses(parsed), JSON.stringify(manifest).slice(0, 80));
  }
  const many = contentItemsManifestIssues({ items: Array.from({ length: 20 }, () => ({ title: "no id" })) });
  assert.equal(many.length, 13, "twelve and a count of the rest");
});

test("the manifest stage is the one whose output the Workflow names as its source", async () => {
  const release = compileWorkflow(await loadWorkflow(workflowPath));
  const writers = release.spec.stages.filter((stage) => writesContentItemsManifest(release, stage)).map((stage) => stage.id);
  assert.deepEqual(writers, ["plan"]);
});

test("a card title fits the board, whatever the project name and item title", () => {
  for (const [project, item, stage] of [
    ["山东天骄生物 阿拉伯语 30条（Gulfood 展前·下载交付·纯混剪）", "x".repeat(207), "备料 + Brief 编译"],
    ["p".repeat(300), "短", "出片"],
    ["p".repeat(300), null, "s".repeat(300)],
    ["项目", "😀".repeat(200), "出片"],
  ]) {
    const title = cardTitle({ project, item, stage });
    assert.ok(title.length <= 180, `${title.length}`);
    assert.ok(!/[\uD800-\uDBFF]$/.test(title.replace(/…$/, "")), "no half character");
  }
  assert.equal(cardTitle({ project: "项目", item: "条目", stage: "出片" }), "项目｜条目｜出片");
  assert.equal(cardTitle({ project: "项目", item: "x".repeat(60), stage: "出片" }, 40).length, 40);
});

test("a project stage after a hundred items still gets a brief within the board's note limit", async () => {
  const release = compileWorkflow(await loadWorkflow(workflowPath));
  const stage = release.spec.stages.find((entry) => entry.id === "deliver-download");
  const contentItems = Array.from({ length: 100 }, (_, index) => ({ id: `item-${String(index).padStart(3, "0")}-with-a-long-name`, title: `Item ${index}`, route: "SCENE_EDIT" }));
  const instance = {
    id: "NS-MANY", name: "Many", status: "active", workflowSha256: release.metadata.workflowSha256,
    inputs: { deliveryMode: "download", nightshift: { instanceDir: "/srv/nightshift/instances/NS-MANY-with-a-long-directory-name" } },
    agentBindings: { "content-operator": "main" },
  };
  const brief = buildAgentBrief(release, instance, stage, null, contentItems, contentItems.slice(0, 20).map((item) => ({ ...item, reason: "r".repeat(160) })));
  assert.ok(brief.length <= WORKBOARD_NOTES_LIMIT, `${brief.length}`);
  assert.match(brief, /content-items\/<content item id>\/handoffs\/produce\.json for each content item in .*content-items\.json \(100\)/);
});

test("ids a card label carries and a card's Skill list are held to the board's limits at publish", async () => {
  const source = await readFile(workflowPath, "utf8");
  const longStage = source.replace("## STAGE route｜", "## STAGE route-with-an-id-far-too-long-for-a-label｜").replaceAll("needs: [route]", "needs: [route-with-an-id-far-too-long-for-a-label]");
  const issues = (text) => validateWorkflow(parseWorkflowMarkdown(text));
  assert.ok(issues(longStage).some((entry) => entry.code === "stage.id.label"), JSON.stringify(issues(longStage).map((entry) => entry.code)));
  const manySkills = source.replace(/skills: \[([^\]]*)\]/, (_, list) => `skills: [${list}, ${Array.from({ length: 21 }, (_, index) => `extra-skill-${index}`).join(", ")}]`);
  assert.ok(issues(manySkills).some((entry) => entry.code === "stage.skills.workboard"));
  assert.deepEqual(issues(source).filter((entry) => /label|workboard|skill\.name/.test(entry.code)), []);
});
