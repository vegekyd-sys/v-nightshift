import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { normalizeContentItems } from "./content-items.mjs";

export class NightShiftStore {
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_releases (
        workflow_sha TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        version TEXT NOT NULL,
        name TEXT NOT NULL,
        source_yaml TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        published_at TEXT NOT NULL,
        UNIQUE(workflow_id, version)
      );
      CREATE TABLE IF NOT EXISTS workflow_drafts (
        workflow_id TEXT PRIMARY KEY,
        source_yaml TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workflow_sha TEXT NOT NULL REFERENCES workflow_releases(workflow_sha),
        status TEXT NOT NULL,
        inputs_json TEXT NOT NULL,
        agent_bindings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stage_runs (
        instance_id TEXT NOT NULL REFERENCES instances(id),
        stage_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        card_id TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(instance_id, stage_id, attempt)
      );
      CREATE TABLE IF NOT EXISTS content_items (
        instance_id TEXT NOT NULL REFERENCES instances(id),
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        route TEXT,
        status TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(instance_id, id)
      );
      CREATE TABLE IF NOT EXISTS content_item_runs (
        instance_id TEXT NOT NULL,
        content_item_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        card_id TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(instance_id, content_item_id, stage_id, attempt),
        FOREIGN KEY(instance_id, content_item_id) REFERENCES content_items(instance_id, id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        stage_id TEXT NOT NULL,
        content_item_id TEXT,
        effect TEXT,
        scope TEXT,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        evidence TEXT,
        approval_card_id TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        instance_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const approvalColumns = this.db.prepare("PRAGMA table_info(approvals)").all();
    if (!approvalColumns.some((column) => column.name === "content_item_id")) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN content_item_id TEXT");
    }
  }

  saveDraft(workflowId, sourceYaml, now = new Date()) {
    this.db
      .prepare(`
        INSERT INTO workflow_drafts(workflow_id, source_yaml, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(workflow_id) DO UPDATE SET
          source_yaml=excluded.source_yaml,
          updated_at=excluded.updated_at
      `)
      .run(workflowId, sourceYaml, now.toISOString());
    return this.getDraft(workflowId);
  }

  getDraft(workflowId) {
    return this.db
      .prepare("SELECT workflow_id AS workflowId, source_yaml AS sourceYaml, updated_at AS updatedAt FROM workflow_drafts WHERE workflow_id = ?")
      .get(workflowId) ?? null;
  }

  saveRelease(release, sourceYaml, now = new Date()) {
    this.db
      .prepare(`
        INSERT INTO workflow_releases(
          workflow_sha, workflow_id, version, name, source_yaml, manifest_json, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_sha) DO NOTHING
      `)
      .run(
        release.metadata.workflowSha256,
        release.metadata.id,
        release.metadata.version,
        release.metadata.name,
        sourceYaml,
        JSON.stringify(release),
        now.toISOString(),
      );
    return this.getRelease(release.metadata.workflowSha256);
  }

  getRelease(workflowSha) {
    const row = this.db
      .prepare("SELECT * FROM workflow_releases WHERE workflow_sha = ?")
      .get(workflowSha);
    return row ? releaseRow(row) : null;
  }

  listReleases() {
    return this.db
      .prepare("SELECT * FROM workflow_releases ORDER BY published_at DESC")
      .all()
      .map(releaseRow);
  }

  createInstance(instance, now = new Date()) {
    const timestamp = now.toISOString();
    this.db
      .prepare(`
        INSERT INTO instances(
          id, name, workflow_sha, status, inputs_json, agent_bindings_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        instance.id,
        instance.name ?? instance.id,
        instance.workflowSha256,
        instance.status ?? "active",
        JSON.stringify(instance.inputs ?? {}),
        JSON.stringify(instance.agentBindings ?? {}),
        timestamp,
        timestamp,
      );
    this.appendEvent({
      instanceId: instance.id,
      type: "instance.created",
      payload: { workflowSha256: instance.workflowSha256 },
      now,
    });
    return this.getInstance(instance.id);
  }

  getInstance(id) {
    const row = this.db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
    if (!row) return null;
    const approvals = this.listApprovals(id);
    return instanceRow(row, approvals);
  }

  listInstances() {
    return this.db
      .prepare("SELECT * FROM instances ORDER BY updated_at DESC")
      .all()
      .map((row) => instanceRow(row, this.listApprovals(row.id)));
  }

  updateInstanceStatus(id, status, now = new Date()) {
    this.db
      .prepare("UPDATE instances SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now.toISOString(), id);
    return this.getInstance(id);
  }

  updateInstanceInputs(id, patch, now = new Date()) {
    const current = this.getInstance(id);
    if (!current) throw new Error(`Unknown instance ${id}`);
    const inputs = { ...current.inputs, ...patch };
    this.db
      .prepare("UPDATE instances SET inputs_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(inputs), now.toISOString(), id);
    this.appendEvent({
      instanceId: id,
      type: "instance.inputs.updated",
      payload: { keys: Object.keys(patch).sort() },
      now,
    });
    return this.getInstance(id);
  }

  replaceContentItems(instanceId, items, now = new Date(), maxItems = 50, routes = []) {
    if (!this.getInstance(instanceId)) throw new Error(`Unknown instance ${instanceId}`);
    const normalized = normalizeContentItems(items, { maxItems, routes });
    const timestamp = now.toISOString();
    const existingIds = new Set(this.listContentItems(instanceId).map((item) => item.id));
    const nextIds = new Set(normalized.map((item) => item.id));
    for (const id of existingIds) {
      if (nextIds.has(id)) continue;
      const runs = this.db.prepare("SELECT COUNT(*) AS count FROM content_item_runs WHERE instance_id = ? AND content_item_id = ?").get(instanceId, id);
      if (runs.count > 0) throw new Error(`Cannot remove content item ${id} after execution has started`);
      this.db.prepare("DELETE FROM content_items WHERE instance_id = ? AND id = ?").run(instanceId, id);
    }
    const statement = this.db.prepare(`
      INSERT INTO content_items(instance_id, id, title, route, status, ordinal, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, id) DO UPDATE SET
        title=excluded.title,
        route=excluded.route,
        status=excluded.status,
        ordinal=excluded.ordinal,
        payload_json=excluded.payload_json,
        updated_at=excluded.updated_at
    `);
    for (const item of normalized) {
      const existing = this.db.prepare("SELECT created_at FROM content_items WHERE instance_id = ? AND id = ?").get(instanceId, item.id);
      const current = this.listContentItems(instanceId).find((entry) => entry.id === item.id);
      if (current?.route && item.route !== current.route) {
        const downstream = this.db.prepare("SELECT COUNT(*) AS count FROM content_item_runs WHERE instance_id = ? AND content_item_id = ? AND stage_id <> 'route'").get(instanceId, item.id);
        if (downstream.count > 0) throw new Error(`Cannot change route for ${item.id} after downstream execution has started`);
      }
      statement.run(instanceId, item.id, item.title, item.route, item.status, item.ordinal, JSON.stringify(item), existing?.created_at ?? timestamp, timestamp);
    }
    this.db.prepare("UPDATE instances SET updated_at = ? WHERE id = ?").run(timestamp, instanceId);
    this.appendEvent({ instanceId, type: "content-items.replaced", payload: { count: normalized.length, routes: normalized.map((item) => item.route) }, now });
    return this.listContentItems(instanceId);
  }

  listContentItems(instanceId) {
    return this.db.prepare(`
      SELECT instance_id AS instanceId, id, title, route, status, ordinal,
             payload_json AS payloadJson, created_at AS createdAt, updated_at AS updatedAt
      FROM content_items WHERE instance_id = ? ORDER BY ordinal, id
    `).all(instanceId).map(contentItemRow);
  }

  upsertStageRun(run, now = new Date()) {
    this.db
      .prepare(`
        INSERT INTO stage_runs(instance_id, stage_id, attempt, card_id, status, summary, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id, stage_id, attempt) DO UPDATE SET
          card_id=excluded.card_id,
          status=excluded.status,
          summary=excluded.summary,
          updated_at=excluded.updated_at
      `)
      .run(
        run.instanceId,
        run.stageId,
        run.attempt ?? 1,
        run.cardId ?? null,
        run.status,
        run.summary ?? null,
        now.toISOString(),
      );
    return this.listStageRuns(run.instanceId).find(
      (entry) => entry.stageId === run.stageId && entry.attempt === (run.attempt ?? 1),
    );
  }

  listStageRuns(instanceId) {
    return this.db
      .prepare(`
        SELECT instance_id AS instanceId, stage_id AS stageId, attempt, card_id AS cardId,
               status, summary, updated_at AS updatedAt
        FROM stage_runs WHERE instance_id = ? ORDER BY rowid
      `)
      .all(instanceId);
  }

  upsertContentItemRun(run, now = new Date()) {
    this.db.prepare(`
      INSERT INTO content_item_runs(instance_id, content_item_id, stage_id, attempt, card_id, status, summary, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, content_item_id, stage_id, attempt) DO UPDATE SET
        card_id=excluded.card_id,
        status=excluded.status,
        summary=excluded.summary,
        updated_at=excluded.updated_at
    `).run(run.instanceId, run.contentItemId, run.stageId, run.attempt ?? 1, run.cardId ?? null, run.status, run.summary ?? null, now.toISOString());
    return this.listContentItemRuns(run.instanceId).find((entry) => entry.contentItemId === run.contentItemId && entry.stageId === run.stageId && entry.attempt === (run.attempt ?? 1));
  }

  listContentItemRuns(instanceId) {
    return this.db.prepare(`
      SELECT instance_id AS instanceId, content_item_id AS contentItemId, stage_id AS stageId,
             attempt, card_id AS cardId, status, summary, updated_at AS updatedAt
      FROM content_item_runs WHERE instance_id = ? ORDER BY rowid
    `).all(instanceId);
  }

  recordApproval(approval, now = new Date()) {
    const id = approval.id ?? randomUUID();
    this.db
      .prepare(`
        INSERT INTO approvals(
          id, instance_id, stage_id, content_item_id, effect, scope, status, actor, evidence,
          approval_card_id, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        approval.instanceId,
        approval.stageId,
        approval.contentItemId ?? null,
        approval.effect ?? null,
        approval.scope ?? null,
        approval.status,
        approval.actor,
        approval.evidence ?? null,
        approval.cardId ?? null,
        approval.expiresAt ?? null,
        now.toISOString(),
      );
    this.appendEvent({
      instanceId: approval.instanceId,
      type: "approval.recorded",
      payload: { ...approval, id },
      now,
    });
    return this.listApprovals(approval.instanceId).find((entry) => entry.id === id);
  }

  listApprovals(instanceId) {
    return this.db
      .prepare(`
        SELECT id, instance_id AS instanceId, stage_id AS stageId, content_item_id AS contentItemId, effect, scope, status,
               actor, evidence, approval_card_id AS cardId,
               expires_at AS expiresAt, created_at AS createdAt
        FROM approvals WHERE instance_id = ? ORDER BY created_at DESC
      `)
      .all(instanceId);
  }

  appendEvent({ instanceId = null, type, payload = {}, now = new Date(), eventId }) {
    const id = eventId ?? randomUUID();
    this.db
      .prepare(`
        INSERT OR IGNORE INTO audit_events(event_id, instance_id, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(id, instanceId, type, JSON.stringify(payload), now.toISOString());
    return id;
  }

  listEvents(instanceId = null, limit = 100) {
    const rows = instanceId
      ? this.db
          .prepare("SELECT * FROM audit_events WHERE instance_id = ? ORDER BY sequence DESC LIMIT ?")
          .all(instanceId, limit)
      : this.db
          .prepare("SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ?")
          .all(limit);
    return rows.map((row) => ({
      sequence: row.sequence,
      eventId: row.event_id,
      instanceId: row.instance_id,
      type: row.type,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
    }));
  }
}

function releaseRow(row) {
  return {
    workflowSha256: row.workflow_sha,
    workflowId: row.workflow_id,
    version: row.version,
    name: row.name,
    sourceYaml: row.source_yaml,
    sourceMarkdown: row.source_yaml,
    manifest: JSON.parse(row.manifest_json),
    publishedAt: row.published_at,
  };
}

function instanceRow(row, approvals) {
  return {
    id: row.id,
    name: row.name,
    workflowSha256: row.workflow_sha,
    status: row.status,
    inputs: JSON.parse(row.inputs_json),
    agentBindings: JSON.parse(row.agent_bindings_json),
    approvals,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function contentItemRow(row) {
  return {
    ...JSON.parse(row.payloadJson),
    instanceId: row.instanceId,
    id: row.id,
    title: row.title,
    route: row.route,
    status: row.status,
    ordinal: row.ordinal,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
