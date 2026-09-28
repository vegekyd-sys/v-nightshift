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
        failure_json TEXT,
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
        failure_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(instance_id, content_item_id, stage_id, attempt),
        FOREIGN KEY(instance_id, content_item_id) REFERENCES content_items(instance_id, id)
      );

      CREATE TABLE IF NOT EXISTS action_cards (
        action_key TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        card_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS action_cards_instance_id_idx ON action_cards(instance_id);
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
        binding_json TEXT,
        binding_hash TEXT,
        approval_card_id TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_operations (
        idempotency_key TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        content_item_id TEXT,
        stage_id TEXT NOT NULL,
        owner_card_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        external_task_id TEXT,
        checkpoint_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instance_controls (
        instance_id TEXT PRIMARY KEY REFERENCES instances(id),
        automatic_dispatch INTEGER NOT NULL DEFAULT 1,
        fault_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS human_attempts (
        card_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        instance_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_subject_state (
        subject_key TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY,
        notification_key TEXT NOT NULL UNIQUE,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        card_id TEXT,
        kind TEXT NOT NULL,
        target_chat_id TEXT NOT NULL,
        allowed_open_ids_json TEXT NOT NULL,
        presentation_json TEXT NOT NULL,
        fallback_text TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        message_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS notification_metadata (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- 需要你: a card attempt that stopped and will not move without a person.
      CREATE TABLE IF NOT EXISTS decision_requests (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        content_item_id TEXT,
        stage_id TEXT NOT NULL,
        attempt TEXT NOT NULL,
        source TEXT NOT NULL,
        problem TEXT NOT NULL,
        cause TEXT NOT NULL DEFAULT '',
        impact TEXT NOT NULL DEFAULT '',
        suggestion TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        scope TEXT NOT NULL,
        options_json TEXT NOT NULL,
        group_key TEXT NOT NULL,
        status TEXT NOT NULL,
        decision_json TEXT,
        announced_at TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        UNIQUE(card_id, attempt)
      );
      CREATE INDEX IF NOT EXISTS decision_requests_open ON decision_requests(status, instance_id);
    `);
    // Production databases created by the 2026-08-25 notification build already
    // carry this column and these tables; newer ones gain them here.
    const instanceColumns = this.db.prepare("PRAGMA table_info(instances)").all();
    if (!instanceColumns.some((column) => column.name === "collaboration_json")) {
      this.db.exec("ALTER TABLE instances ADD COLUMN collaboration_json TEXT NOT NULL DEFAULT '{}'");
    }
    const approvalColumns = this.db.prepare("PRAGMA table_info(approvals)").all();
    if (!approvalColumns.some((column) => column.name === "content_item_id")) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN content_item_id TEXT");
    }
    if (!approvalColumns.some((column) => column.name === "binding_json")) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN binding_json TEXT");
    }
    if (!approvalColumns.some((column) => column.name === "binding_hash")) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN binding_hash TEXT");
    }
    for (const table of ["stage_runs", "content_item_runs"]) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === "failure_json")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN failure_json TEXT`);
      }
    }
  }

  // One request per card attempt. Reopening the same attempt returns the row it
  // already has, so repeated passes never duplicate a request.
  openDecisionRequest(request, now = new Date()) {
    const existing = this.getDecisionRequestForCard(request.cardId, request.attempt);
    if (existing) return { ...existing, reused: true };
    const id = request.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO decision_requests(
        id, instance_id, card_id, content_item_id, stage_id, attempt, source, problem, cause, impact, suggestion,
        detail, evidence_json, scope, options_json, group_key, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `).run(
      id,
      request.instanceId,
      request.cardId,
      request.contentItemId ?? null,
      request.stageId,
      String(request.attempt),
      request.source,
      request.problem,
      request.cause ?? "",
      request.impact ?? "",
      request.suggestion ?? "",
      request.detail ?? "",
      JSON.stringify(request.evidence ?? {}),
      request.scope,
      JSON.stringify(request.options),
      request.groupKey,
      now.toISOString(),
    );
    this.appendEvent({
      instanceId: request.instanceId,
      type: "decision.requested",
      payload: { decisionId: id, cardId: request.cardId, stageId: request.stageId, source: request.source, groupKey: request.groupKey },
      now,
    });
    return { ...this.getDecisionRequest(id), reused: false };
  }

  updateDecisionRequestText(id, { problem, cause = "", impact = "", suggestion = "", detail = "", evidence }, now = new Date()) {
    this.db.prepare(`UPDATE decision_requests SET problem = ?, cause = ?, impact = ?, suggestion = ?, detail = ?, evidence_json = ? WHERE id = ? AND status = 'open'`)
      .run(problem, cause, impact, suggestion, detail, JSON.stringify(evidence ?? {}), id);
    const current = this.getDecisionRequest(id);
    this.appendEvent({ instanceId: current?.instanceId, type: "decision.described", payload: { decisionId: id }, now });
    return current;
  }

  getDecisionRequest(id) {
    const row = this.db.prepare("SELECT * FROM decision_requests WHERE id = ?").get(id);
    return row ? decisionRequestRow(row) : null;
  }

  getDecisionRequestForCard(cardId, attempt) {
    const row = this.db.prepare("SELECT * FROM decision_requests WHERE card_id = ? AND attempt = ?").get(cardId, String(attempt));
    return row ? decisionRequestRow(row) : null;
  }

  listDecisionRequests({ instanceId = null, status = "open" } = {}) {
    const clauses = [];
    const values = [];
    if (status) { clauses.push("status = ?"); values.push(status); }
    if (instanceId) { clauses.push("instance_id = ?"); values.push(instanceId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM decision_requests ${where} ORDER BY created_at`).all(...values).map(decisionRequestRow);
  }

  // A decision is written once; a later call returns the decided row unchanged.
  decideRequest(id, decision, now = new Date()) {
    const current = this.getDecisionRequest(id);
    if (!current) throw new Error(`Unknown decision request ${id}`);
    if (current.status !== "open") return { ...current, alreadyDecided: true };
    const recorded = { ...decision, at: now.toISOString() };
    this.db.prepare("UPDATE decision_requests SET status = 'decided', decision_json = ?, decided_at = ? WHERE id = ? AND status = 'open'")
      .run(JSON.stringify(recorded), now.toISOString(), id);
    this.appendEvent({
      instanceId: current.instanceId,
      type: "decision.decided",
      payload: { decisionId: id, cardId: current.cardId, optionId: decision.optionId, actor: decision.actor, note: decision.note ?? null },
      now,
    });
    return { ...this.getDecisionRequest(id), alreadyDecided: false };
  }

  // A new attempt, or a card that moved on by itself, no longer needs the old decision.
  supersedeDecisionRequests(cardId, { exceptAttempt = null } = {}, now = new Date()) {
    const rows = this.db.prepare("SELECT * FROM decision_requests WHERE card_id = ? AND status = 'open'").all(cardId).map(decisionRequestRow);
    for (const row of rows) {
      if (exceptAttempt !== null && row.attempt === String(exceptAttempt)) continue;
      this.db.prepare("UPDATE decision_requests SET status = 'superseded', decided_at = ? WHERE id = ?").run(now.toISOString(), row.id);
    }
    return rows.filter((row) => exceptAttempt === null || row.attempt !== String(exceptAttempt)).length;
  }

  markDecisionRequestsAnnounced(ids, now = new Date()) {
    const statement = this.db.prepare("UPDATE decision_requests SET announced_at = ? WHERE id = ? AND announced_at IS NULL");
    for (const id of ids) statement.run(now.toISOString(), id);
  }

  getInstanceControl(instanceId) {
    const row = this.db.prepare("SELECT * FROM instance_controls WHERE instance_id = ?").get(instanceId);
    return { automaticDispatch: row ? Boolean(row.automatic_dispatch) : true, fault: row?.fault_json ? JSON.parse(row.fault_json) : null };
  }

  setInstanceControl(instanceId, patch) {
    const control = { ...this.getInstanceControl(instanceId), ...patch };
    this.db.prepare(`INSERT INTO instance_controls VALUES (?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET automatic_dispatch=excluded.automatic_dispatch,
      fault_json=excluded.fault_json, updated_at=excluded.updated_at`).run(
      instanceId, control.automaticDispatch ? 1 : 0, control.fault ? JSON.stringify(control.fault) : null, new Date().toISOString());
    return control;
  }

  getHumanAttempt(cardId) {
    const row = this.db.prepare("SELECT record_json FROM human_attempts WHERE card_id = ?").get(cardId);
    return row ? JSON.parse(row.record_json) : null;
  }

  saveHumanAttempt(record) {
    this.db.prepare(`INSERT INTO human_attempts VALUES (?, ?, ?)
      ON CONFLICT(card_id) DO UPDATE SET record_json=excluded.record_json`).run(record.cardId, record.instanceId, JSON.stringify(record));
    return record;
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
          id, name, workflow_sha, status, inputs_json, agent_bindings_json, collaboration_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        instance.id,
        instance.name ?? instance.id,
        instance.workflowSha256,
        instance.status ?? "active",
        JSON.stringify(instance.inputs ?? {}),
        JSON.stringify(instance.agentBindings ?? {}),
        JSON.stringify(instance.collaboration ?? {}),
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

  archiveInstance(id, now = new Date(), details = {}) {
    const current = this.getInstance(id);
    if (!current) throw new Error(`Unknown instance ${id}`);
    const archived = this.updateInstanceStatus(id, "archived", now);
    this.appendEvent({
      instanceId: id,
      type: "instance.archived",
      payload: {
        version: 1,
        previousStatus: current.status,
        actor: details.actor ?? null,
        reason: details.reason ?? null,
        cardCounts: details.cardCounts ?? null,
      },
      now,
    });
    return archived;
  }

  restoreInstance(id, now = new Date(), details = {}) {
    const current = this.getInstance(id);
    if (!current) throw new Error(`Unknown instance ${id}`);
    if (current.status !== "archived") throw new Error(`Instance ${id} is not archived`);
    const archivedEvent = this.listEvents(id, 1000).find((event) => event.type === "instance.archived");
    if (!archivedEvent) throw new Error(`Instance ${id} has no archive snapshot`);
    const previousStatus = archivedEvent.payload?.previousStatus ?? "paused";
    const restoredStatus = previousStatus === "active" ? "paused" : previousStatus;
    const restored = this.updateInstanceStatus(id, restoredStatus, now);
    this.appendEvent({
      instanceId: id,
      type: "instance.restored",
      payload: {
        version: 1,
        archiveEventId: archivedEvent.eventId,
        previousStatus,
        restoredStatus,
        actor: details.actor ?? null,
        reason: details.reason ?? null,
      },
      now,
    });
    return restored;
  }

  updateInstanceCollaboration(id, collaboration, now = new Date()) {
    if (!this.getInstance(id)) throw new Error(`Unknown instance ${id}`);
    this.db
      .prepare("UPDATE instances SET collaboration_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(collaboration ?? {}), now.toISOString(), id);
    this.appendEvent({
      instanceId: id,
      type: "instance.collaboration.updated",
      payload: {
        hasCreator: Boolean(collaboration?.createdByOpenId),
        hasSourceChat: Boolean(collaboration?.sourceChatId),
      },
      now,
    });
    return this.getInstance(id);
  }

  // A subject's generation advances only when its state changes, so a
  // notification key built from it is sent once per real transition.
  transitionNotificationSubject(subjectKey, state, now = new Date()) {
    const current = this.db
      .prepare("SELECT state, generation, updated_at AS updatedAt FROM notification_subject_state WHERE subject_key = ?")
      .get(subjectKey);
    if (current?.state === state) return { changed: false, ...current, subjectKey };
    const generation = (current?.generation ?? 0) + 1;
    const updatedAt = now.toISOString();
    this.db.prepare(`
      INSERT INTO notification_subject_state(subject_key, state, generation, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(subject_key) DO UPDATE SET
        state=excluded.state, generation=excluded.generation, updated_at=excluded.updated_at
    `).run(subjectKey, state, generation, updatedAt);
    return { changed: true, generation, state, subjectKey, updatedAt };
  }

  enqueueNotification(delivery, now = new Date()) {
    const existing = this.db
      .prepare("SELECT * FROM notification_deliveries WHERE notification_key = ?")
      .get(delivery.notificationKey);
    if (existing) return notificationDeliveryRow(existing);
    const id = delivery.id ?? randomUUID();
    const timestamp = now.toISOString();
    this.db.prepare(`
      INSERT INTO notification_deliveries(
        id, notification_key, instance_id, card_id, kind, target_chat_id,
        allowed_open_ids_json, presentation_json, fallback_text, status,
        attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(
      id,
      delivery.notificationKey,
      delivery.instanceId,
      delivery.cardId ?? null,
      delivery.kind,
      delivery.targetChatId,
      JSON.stringify(delivery.allowedOpenIds ?? []),
      JSON.stringify(delivery.presentation),
      delivery.fallbackText,
      timestamp,
      timestamp,
    );
    return this.getNotification(id);
  }

  getNotification(id) {
    const row = this.db.prepare("SELECT * FROM notification_deliveries WHERE id = ?").get(id);
    return row ? notificationDeliveryRow(row) : null;
  }

  listPendingNotifications(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM notification_deliveries
      WHERE status IN ('pending', 'failed') AND attempts < 5
      ORDER BY created_at ASC LIMIT ?
    `).all(limit).map(notificationDeliveryRow);
  }

  markNotificationDelivered(id, messageId, now = new Date()) {
    const timestamp = now.toISOString();
    this.db.prepare(`
      UPDATE notification_deliveries
      SET status='delivered', attempts=attempts+1, message_id=?, last_error=NULL, delivered_at=?, updated_at=?
      WHERE id=?
    `).run(messageId ?? null, timestamp, timestamp, id);
    return this.getNotification(id);
  }

  markNotificationFailed(id, error, now = new Date()) {
    this.db.prepare(`
      UPDATE notification_deliveries SET status='failed', attempts=attempts+1, last_error=?, updated_at=? WHERE id=?
    `).run(String(error).slice(0, 2000), now.toISOString(), id);
    return this.getNotification(id);
  }

  getNotificationMetadata(key) {
    const row = this.db.prepare("SELECT value_json AS valueJson FROM notification_metadata WHERE key = ?").get(key);
    return row ? JSON.parse(row.valueJson) : null;
  }

  setNotificationMetadata(key, value, now = new Date()) {
    this.db.prepare(`
      INSERT INTO notification_metadata(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
    `).run(key, JSON.stringify(value), now.toISOString());
    return value;
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
        INSERT INTO stage_runs(instance_id, stage_id, attempt, card_id, status, summary, failure_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id, stage_id, attempt) DO UPDATE SET
          card_id=excluded.card_id,
          status=excluded.status,
          summary=excluded.summary,
          failure_json=excluded.failure_json,
          updated_at=excluded.updated_at
      `)
      .run(
        run.instanceId,
        run.stageId,
        run.attempt ?? 1,
        run.cardId ?? null,
        run.status,
        run.summary ?? null,
        run.failure ? JSON.stringify(run.failure) : null,
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
               status, summary, failure_json AS failureJson, updated_at AS updatedAt
        FROM stage_runs WHERE instance_id = ? ORDER BY rowid
      `)
      .all(instanceId)
      .map(runRow);
  }

  upsertContentItemRun(run, now = new Date()) {
    this.db.prepare(`
      INSERT INTO content_item_runs(instance_id, content_item_id, stage_id, attempt, card_id, status, summary, failure_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, content_item_id, stage_id, attempt) DO UPDATE SET
        card_id=excluded.card_id,
        status=excluded.status,
        summary=excluded.summary,
        failure_json=excluded.failure_json,
        updated_at=excluded.updated_at
    `).run(run.instanceId, run.contentItemId, run.stageId, run.attempt ?? 1, run.cardId ?? null, run.status, run.summary ?? null, run.failure ? JSON.stringify(run.failure) : null, now.toISOString());
    return this.listContentItemRuns(run.instanceId).find((entry) => entry.contentItemId === run.contentItemId && entry.stageId === run.stageId && entry.attempt === (run.attempt ?? 1));
  }

  listContentItemRuns(instanceId) {
    return this.db.prepare(`
      SELECT instance_id AS instanceId, content_item_id AS contentItemId, stage_id AS stageId,
             attempt, card_id AS cardId, status, summary, failure_json AS failureJson, updated_at AS updatedAt
      FROM content_item_runs WHERE instance_id = ? ORDER BY rowid
    `).all(instanceId).map(runRow);
  }

  // Card idempotency cannot depend on a board read. An approval card is not a
  // stage run, so a scoped read never returns it, and the label scan in
  // applyAction then decided the card did not exist and created another one
  // every pass: 2,254 duplicates across three projects on 2026-09-17. The
  // ledger makes reuse independent of whatever the caller happened to read.
  recordActionCard({ actionKey, cardId, instanceId }, now = new Date()) {
    if (!actionKey || !cardId || !instanceId) return;
    const at = now.toISOString();
    this.db.prepare(
      `INSERT INTO action_cards (action_key, instance_id, card_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(action_key) DO UPDATE SET card_id = excluded.card_id, updated_at = excluded.updated_at`,
    ).run(String(actionKey), String(instanceId), String(cardId), at, at);
  }

  listActionCardIds(instanceId) {
    return this.db.prepare("SELECT card_id FROM action_cards WHERE instance_id = ?")
      .all(String(instanceId)).map((row) => row.card_id).filter(Boolean);
  }

  recordApproval(approval, now = new Date()) {
    const id = approval.id ?? randomUUID();
    this.db
      .prepare(`
        INSERT INTO approvals(
          id, instance_id, stage_id, content_item_id, effect, scope, status, actor, evidence,
          binding_json, binding_hash, approval_card_id, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        approval.bindings ? JSON.stringify(approval.bindings) : null,
        approval.bindingHash ?? null,
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
               actor, evidence, binding_json AS bindingJson, binding_hash AS bindingHash, approval_card_id AS cardId,
               expires_at AS expiresAt, created_at AS createdAt
        FROM approvals WHERE instance_id = ? ORDER BY created_at DESC
      `)
      .all(instanceId)
      .map((approval) => ({
        ...approval,
        bindings: approval.bindingJson ? JSON.parse(approval.bindingJson) : null,
        bindingJson: undefined,
      }));
  }

  reserveExternalOperation(operation, now = new Date()) {
    const timestamp = now.toISOString();
    const existing = this.getExternalOperation(operation.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== operation.requestHash) {
        throw new Error("External operation idempotency key was reused with a different request hash");
      }
      return { ...existing, reused: true };
    }
    this.db.prepare(`
      INSERT INTO external_operations(
        idempotency_key, instance_id, content_item_id, stage_id, owner_card_id,
        request_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
    `).run(
      operation.idempotencyKey,
      operation.instanceId,
      operation.contentItemId ?? null,
      operation.stageId,
      operation.ownerCardId,
      operation.requestHash,
      timestamp,
      timestamp,
    );
    this.appendEvent({
      instanceId: operation.instanceId,
      type: "external-operation.reserved",
      payload: { idempotencyKey: operation.idempotencyKey, ownerCardId: operation.ownerCardId, stageId: operation.stageId },
      now,
    });
    return { ...this.getExternalOperation(operation.idempotencyKey), reused: false };
  }

  checkpointExternalOperation(idempotencyKey, patch, now = new Date()) {
    const current = this.getExternalOperation(idempotencyKey);
    if (!current) throw new Error("Unknown external operation");
    const allowed = new Set(["reserved", "executing", "succeeded", "failed", "unknown"]);
    const status = patch.status ?? current.status;
    if (!allowed.has(status)) throw new Error("Invalid external operation status");
    if (current.status === "succeeded" && status !== "succeeded") {
      throw new Error("Succeeded external operations are immutable");
    }
    this.db.prepare(`
      UPDATE external_operations SET status = ?, external_task_id = ?, checkpoint_json = ?, result_json = ?, updated_at = ?
      WHERE idempotency_key = ?
    `).run(
      status,
      patch.externalTaskId ?? current.externalTaskId,
      patch.checkpoint === undefined ? JSON.stringify(current.checkpoint) : JSON.stringify(patch.checkpoint),
      patch.result === undefined ? JSON.stringify(current.result) : JSON.stringify(patch.result),
      now.toISOString(),
      idempotencyKey,
    );
    this.appendEvent({
      instanceId: current.instanceId,
      type: "external-operation.checkpointed",
      payload: { idempotencyKey, status, externalTaskId: patch.externalTaskId ?? current.externalTaskId },
      now,
    });
    return this.getExternalOperation(idempotencyKey);
  }

  getExternalOperation(idempotencyKey) {
    const row = this.db.prepare("SELECT * FROM external_operations WHERE idempotency_key = ?").get(idempotencyKey);
    return row ? externalOperationRow(row) : null;
  }

  listExternalOperations(instanceId) {
    return this.db.prepare("SELECT * FROM external_operations WHERE instance_id = ? ORDER BY created_at").all(instanceId).map(externalOperationRow);
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

  getEvent(eventId) {
    const row = this.db
      .prepare("SELECT * FROM audit_events WHERE event_id = ?")
      .get(eventId);
    return row ? auditEventRow(row) : null;
  }

  listEvents(instanceId = null, limit = 100) {
    const rows = instanceId
      ? this.db
          .prepare("SELECT * FROM audit_events WHERE instance_id = ? ORDER BY sequence DESC LIMIT ?")
          .all(instanceId, limit)
      : this.db
          .prepare("SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ?")
          .all(limit);
    return rows.map(auditEventRow);
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
    collaboration: row.collaboration_json ? JSON.parse(row.collaboration_json) : {},
    approvals,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function notificationDeliveryRow(row) {
  return {
    id: row.id,
    notificationKey: row.notification_key,
    instanceId: row.instance_id,
    cardId: row.card_id,
    kind: row.kind,
    targetChatId: row.target_chat_id,
    allowedOpenIds: JSON.parse(row.allowed_open_ids_json),
    presentation: JSON.parse(row.presentation_json),
    fallbackText: row.fallback_text,
    status: row.status,
    attempts: row.attempts,
    messageId: row.message_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

function externalOperationRow(row) {
  return {
    idempotencyKey: row.idempotency_key,
    instanceId: row.instance_id,
    contentItemId: row.content_item_id,
    stageId: row.stage_id,
    ownerCardId: row.owner_card_id,
    requestHash: row.request_hash,
    status: row.status,
    externalTaskId: row.external_task_id,
    checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decisionRequestRow(row) {
  return {
    id: row.id,
    instanceId: row.instance_id,
    cardId: row.card_id,
    contentItemId: row.content_item_id,
    stageId: row.stage_id,
    attempt: row.attempt,
    source: row.source,
    problem: row.problem,
    cause: row.cause,
    impact: row.impact,
    suggestion: row.suggestion,
    detail: row.detail,
    evidence: JSON.parse(row.evidence_json || "{}"),
    scope: row.scope,
    options: JSON.parse(row.options_json),
    groupKey: row.group_key,
    status: row.status,
    decision: row.decision_json ? JSON.parse(row.decision_json) : null,
    announcedAt: row.announced_at,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function auditEventRow(row) {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    instanceId: row.instance_id,
    type: row.type,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}

function runRow(row) {
  return {
    ...row,
    failure: row.failureJson ? JSON.parse(row.failureJson) : null,
    failureJson: undefined,
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
