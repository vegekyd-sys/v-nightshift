import assert from "node:assert/strict";
import test from "node:test";
import { auditNightShiftGovernance, normalizeProjectGovernance, validateGovernanceManifest } from "../src/index.mjs";

test("governance defaults are advisory and never reject an unclassified project", () => {
  assert.deepEqual(normalizeProjectGovernance({ id: "CUSTOMER-1", name: "Customer delivery" }, new Date("2026-09-12T00:00:00Z")), {
    purpose: "production",
    retentionDays: null,
    expiresAt: null,
    classificationSource: "default",
  });
});

test("batch governance requires exact project status and card counts before mutation", () => {
  const manifest = { version: 1, projects: [{ id: "OLD-TEST", expectedStatus: "paused", expectedCardCount: 1 }] };
  const instances = [{ id: "OLD-TEST", name: "Old test", status: "paused" }];
  const cards = [{ id: "one", status: "ready", labels: ["instance:OLD-TEST"] }];
  assert.equal(validateGovernanceManifest(manifest, { cards, instances })[0].cardCount, 1);
  assert.throws(() => validateGovernanceManifest({ ...manifest, projects: [{ ...manifest.projects[0], expectedCardCount: 2 }] }, { cards, instances }), /card count changed/);
  assert.throws(() => validateGovernanceManifest(manifest, { cards: [{ ...cards[0], status: "running" }], instances }), /running cards/);
});

test("explicit test governance receives a retention date without changing execution state", () => {
  const result = normalizeProjectGovernance({
    id: "ANY-ID",
    name: "Free-form experiment",
    governance: { purpose: "test", retentionDays: 5 },
    createdAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(result.purpose, "test");
  assert.equal(result.expiresAt, "2026-09-06T00:00:00.000Z");
});

test("audit suggests expired paused tests but does not classify active tests for archive", () => {
  const cards = [
    { id: "one", status: "ready", title: "one", labels: ["instance:OLD-TEST", "nightshift-action:abc"] },
    { id: "two", status: "ready", title: "two", labels: ["instance:OLD-TEST", "nightshift-action:abc"] },
    { id: "orphan", status: "blocked", title: "orphan", labels: [] },
  ];
  const instances = [
    { id: "OLD-TEST", name: "Old test", status: "paused", createdAt: "2026-08-01T00:00:00Z" },
    { id: "LIVE-TEST", name: "Live test", status: "active", createdAt: "2026-08-01T00:00:00Z" },
    { id: "ARCHIVED-TEST", name: "Archived test", status: "archived", createdAt: "2026-08-01T00:00:00Z" },
  ];
  cards.push(
    { id: "archived-one", status: "ready", title: "one", labels: ["instance:ARCHIVED-TEST", "nightshift-action:hidden"] },
    { id: "archived-two", status: "ready", title: "two", labels: ["instance:ARCHIVED-TEST", "nightshift-action:hidden"] },
  );
  const audit = auditNightShiftGovernance({ cards, instances, now: new Date("2026-09-12T00:00:00Z") });
  assert.deepEqual(audit.archiveCandidates.map((entry) => entry.id), ["OLD-TEST"]);
  assert.equal(audit.summary.duplicateActionGroups, 1);
  assert.equal(audit.summary.duplicateExcessCards, 1);
  assert.equal(audit.summary.orphanCards, 1);
});
