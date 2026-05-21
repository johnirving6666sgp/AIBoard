import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dataDir, dbPath } from "./paths.js";

fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    raw_content TEXT NOT NULL,
    markdown_path TEXT,
    vault_path TEXT,
    thread_id TEXT,
    workflow_id TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    target TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
    target TEXT NOT NULL,
    command_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS candidate_statuses (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    candidate_key TEXT NOT NULL,
    status TEXT NOT NULL,
    candidate_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (event_id, candidate_key)
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'markdown',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS imported_files (
    path TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
    error TEXT,
    imported_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vault_snapshots (
    vault_path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
    imported_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS source_imports (
    source_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
    imported_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vault_sync_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    root_path TEXT,
    scanned INTEGER NOT NULL DEFAULT 0,
    imported INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
  );
`);

const insertEventStmt = db.prepare(`
  INSERT INTO events (
    id, source, actor, type, status, priority, title, summary, raw_content,
    markdown_path, vault_path, thread_id, workflow_id, tags_json, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateMarkdownPathStmt = db.prepare(`
  UPDATE events SET markdown_path = ?, updated_at = ? WHERE id = ?
`);

const updateEventStatusStmt = db.prepare(`
  UPDATE events SET status = ?, updated_at = ? WHERE id = ?
`);

const selectEventStmt = db.prepare("SELECT * FROM events WHERE id = ?");

const selectEventsStmt = db.prepare(`
  SELECT * FROM events
  WHERE
    (? IS NULL OR status = ?)
    AND (? IS NULL OR source = ?)
    AND (? IS NULL OR type = ?)
    AND (
      ? IS NULL
      OR title LIKE ?
      OR summary LIKE ?
      OR raw_content LIKE ?
      OR tags_json LIKE ?
    )
  ORDER BY
    CASE priority
      WHEN 'urgent' THEN 0
      WHEN 'high' THEN 1
      WHEN 'normal' THEN 2
      ELSE 3
    END,
    created_at DESC
  LIMIT ?
`);

const countByStatusStmt = db.prepare(`
  SELECT status, COUNT(*) as count FROM events GROUP BY status
`);

const countByTypeStmt = db.prepare(`
  SELECT type, COUNT(*) as count FROM events WHERE status != 'archived' GROUP BY type
`);

const insertActionStmt = db.prepare(`
  INSERT INTO actions (id, event_id, kind, label, target, payload_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectActionsStmt = db.prepare(`
  SELECT * FROM actions WHERE event_id = ? ORDER BY created_at ASC
`);

const insertArtifactStmt = db.prepare(`
  INSERT INTO artifacts (id, event_id, title, path, kind, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const selectArtifactsStmt = db.prepare(`
  SELECT artifacts.* FROM artifacts
  LEFT JOIN events ON artifacts.event_id = events.id
  WHERE COALESCE(events.status, 'new') != 'archived'
  ORDER BY artifacts.created_at DESC LIMIT ?
`);

const countEventsStmt = db.prepare("SELECT COUNT(*) as count FROM events");
const countArtifactsStmt = db.prepare(`
  SELECT COUNT(*) as count FROM artifacts
  LEFT JOIN events ON artifacts.event_id = events.id
  WHERE COALESCE(events.status, 'new') != 'archived'
`);

const insertCommandStmt = db.prepare(`
  INSERT INTO commands (id, event_id, target, command_type, payload_json, status, created_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectCommandsStmt = db.prepare(`
  SELECT * FROM commands
  WHERE (? IS NULL OR status = ?)
  ORDER BY created_at DESC
  LIMIT ?
`);

const selectCommandStmt = db.prepare(`
  SELECT * FROM commands WHERE id = ?
`);

const selectEventCommandsStmt = db.prepare(`
  SELECT * FROM commands WHERE event_id = ? ORDER BY created_at DESC
`);

const updateCommandStatusStmt = db.prepare(`
  UPDATE commands SET status = ? WHERE id = ?
`);

const countCommandsByStatusStmt = db.prepare(`
  SELECT status, COUNT(*) as count FROM commands GROUP BY status
`);

const upsertCandidateStatusStmt = db.prepare(`
  INSERT INTO candidate_statuses (event_id, candidate_key, status, candidate_json, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(event_id, candidate_key) DO UPDATE SET
    status = excluded.status,
    candidate_json = excluded.candidate_json,
    updated_at = excluded.updated_at
`);

const selectCandidateStatusesStmt = db.prepare(`
  SELECT * FROM candidate_statuses ORDER BY updated_at DESC
`);

const selectEventCandidateStatusesStmt = db.prepare(`
  SELECT * FROM candidate_statuses WHERE event_id = ? ORDER BY updated_at DESC
`);

const insertImportedFileStmt = db.prepare(`
  INSERT INTO imported_files (path, status, event_id, error, imported_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET
    status = excluded.status,
    event_id = excluded.event_id,
    error = excluded.error,
    imported_at = excluded.imported_at
`);

const selectImportedFilesStmt = db.prepare(`
  SELECT * FROM imported_files ORDER BY imported_at DESC LIMIT ?
`);

const selectVaultSnapshotStmt = db.prepare(`
  SELECT * FROM vault_snapshots WHERE vault_path = ?
`);

const upsertVaultSnapshotStmt = db.prepare(`
  INSERT INTO vault_snapshots (vault_path, content_hash, event_id, imported_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(vault_path) DO UPDATE SET
    content_hash = excluded.content_hash,
    event_id = excluded.event_id,
    imported_at = excluded.imported_at
`);

const selectVaultSnapshotsStmt = db.prepare(`
  SELECT * FROM vault_snapshots ORDER BY imported_at DESC LIMIT ?
`);

const selectSourceImportStmt = db.prepare(`
  SELECT * FROM source_imports WHERE source_key = ?
`);

const insertSourceImportStmt = db.prepare(`
  INSERT INTO source_imports (source_key, source, event_id, imported_at)
  VALUES (?, ?, ?, ?)
`);

const insertVaultSyncRunStmt = db.prepare(`
  INSERT INTO vault_sync_runs (
    id, status, root_path, scanned, imported, skipped, failed, error, started_at, finished_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectVaultSyncRunsStmt = db.prepare(`
  SELECT * FROM vault_sync_runs ORDER BY finished_at DESC LIMIT ?
`);

export function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    actor: row.actor,
    type: row.type,
    status: row.status,
    priority: row.priority,
    title: row.title,
    summary: row.summary,
    rawContent: row.raw_content,
    markdownPath: row.markdown_path,
    vaultPath: row.vault_path,
    threadId: row.thread_id,
    workflowId: row.workflow_id,
    tags: JSON.parse(row.tags_json || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function actionRow(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    kind: row.kind,
    label: row.label,
    target: row.target,
    payload: JSON.parse(row.payload_json || "{}"),
    createdAt: row.created_at
  };
}

export function artifactRow(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    title: row.title,
    path: row.path,
    kind: row.kind,
    createdAt: row.created_at
  };
}

export function commandRow(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    target: row.target,
    commandType: row.command_type,
    payload: JSON.parse(row.payload_json || "{}"),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

export function insertEvent(event) {
  insertEventStmt.run(
    event.id,
    event.source,
    event.actor,
    event.type,
    event.status,
    event.priority,
    event.title,
    event.summary,
    event.rawContent,
    event.markdownPath || null,
    event.vaultPath || null,
    event.threadId || null,
    event.workflowId || null,
    JSON.stringify(event.tags || []),
    event.createdAt,
    event.updatedAt
  );
  return getEvent(event.id);
}

export function updateMarkdownPath(id, markdownPath) {
  updateMarkdownPathStmt.run(markdownPath, new Date().toISOString(), id);
  return getEvent(id);
}

export function updateEventStatus(id, status) {
  updateEventStatusStmt.run(status, new Date().toISOString(), id);
  return getEvent(id);
}

export function getEvent(id) {
  const event = rowToEvent(selectEventStmt.get(id));
  if (!event) return null;
  event.actions = getActions(id);
  return event;
}

export function listEvents(filters = {}) {
  const status = filters.status || null;
  const source = filters.source || null;
  const type = filters.type || null;
  const q = filters.q ? `%${filters.q}%` : null;
  const limit = Number(filters.limit || 100);
  return selectEventsStmt
    .all(status, status, source, source, type, type, q, q, q, q, q, limit)
    .map(rowToEvent);
}

export function addActions(eventId, actions) {
  const createdAt = new Date().toISOString();
  for (const action of actions) {
    insertActionStmt.run(
      action.id,
      eventId,
      action.kind,
      action.label,
      action.target || null,
      JSON.stringify(action.payload || {}),
      createdAt
    );
  }
}

export function getActions(eventId) {
  return selectActionsStmt.all(eventId).map(actionRow);
}

export function insertCommand(command) {
  insertCommandStmt.run(
    command.id,
    command.eventId || null,
    command.target,
    command.commandType,
    JSON.stringify(command.payload || {}),
    command.status || "draft",
    command.createdBy || "human",
    command.createdAt
  );
  return command;
}

export function listCommands(filters = {}) {
  const status = filters.status || null;
  const limit = Number(filters.limit || 50);
  return selectCommandsStmt.all(status, status, limit).map(commandRow);
}

export function getCommand(id) {
  const row = selectCommandStmt.get(id);
  return row ? commandRow(row) : null;
}

export function listEventCommands(eventId) {
  return selectEventCommandsStmt.all(eventId).map(commandRow);
}

export function setCommandStatus(id, status) {
  updateCommandStatusStmt.run(status, id);
}

export function upsertCandidateStatus({ eventId, candidateKey, status, candidate }) {
  upsertCandidateStatusStmt.run(
    eventId,
    candidateKey,
    status,
    JSON.stringify(candidate || {}),
    new Date().toISOString()
  );
  return { eventId, candidateKey, status, candidate };
}

export function listCandidateStatuses(eventId = null) {
  const rows = eventId ? selectEventCandidateStatusesStmt.all(eventId) : selectCandidateStatusesStmt.all();
  return rows.map((row) => ({
    eventId: row.event_id,
    candidateKey: row.candidate_key,
    status: row.status,
    candidate: JSON.parse(row.candidate_json || "{}"),
    updatedAt: row.updated_at
  }));
}

export function addArtifact(artifact) {
  insertArtifactStmt.run(
    artifact.id,
    artifact.eventId || null,
    artifact.title,
    artifact.path,
    artifact.kind || "markdown",
    artifact.createdAt
  );
}

export function listArtifacts(limit = 50) {
  return selectArtifactsStmt.all(Number(limit)).map(artifactRow);
}

export function countEvents() {
  return countEventsStmt.get().count;
}

export function recordImportedFile({ path, status, eventId = null, error = null }) {
  insertImportedFileStmt.run(path, status, eventId, error, new Date().toISOString());
}

export function listImportedFiles(limit = 25) {
  return selectImportedFilesStmt.all(Number(limit)).map((row) => ({
    path: row.path,
    status: row.status,
    eventId: row.event_id,
    error: row.error,
    importedAt: row.imported_at
  }));
}

export function getVaultSnapshot(vaultPath) {
  return selectVaultSnapshotStmt.get(vaultPath) || null;
}

export function upsertVaultSnapshot({ vaultPath, contentHash, eventId }) {
  upsertVaultSnapshotStmt.run(vaultPath, contentHash, eventId, new Date().toISOString());
}

export function listVaultSnapshots(limit = 25) {
  return selectVaultSnapshotsStmt.all(Number(limit)).map((row) => ({
    vaultPath: row.vault_path,
    contentHash: row.content_hash,
    eventId: row.event_id,
    importedAt: row.imported_at
  }));
}

export function hasSourceImport(sourceKey) {
  return Boolean(selectSourceImportStmt.get(sourceKey));
}

export function recordSourceImport({ sourceKey, source, eventId }) {
  insertSourceImportStmt.run(sourceKey, source, eventId, new Date().toISOString());
}

export function recordVaultSyncRun(run) {
  insertVaultSyncRunStmt.run(
    run.id,
    run.status,
    run.rootPath || null,
    run.scanned || 0,
    run.imported || 0,
    run.skipped || 0,
    run.failed || 0,
    run.error || null,
    run.startedAt,
    run.finishedAt
  );
}

export function listVaultSyncRuns(limit = 20) {
  return selectVaultSyncRunsStmt.all(Number(limit)).map((row) => ({
    id: row.id,
    status: row.status,
    rootPath: row.root_path,
    scanned: row.scanned,
    imported: row.imported,
    skipped: row.skipped,
    failed: row.failed,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }));
}

export function getStats() {
  const byStatus = Object.fromEntries(countByStatusStmt.all().map((row) => [row.status, row.count]));
  const byType = Object.fromEntries(countByTypeStmt.all().map((row) => [row.type, row.count]));
  const commandsByStatus = Object.fromEntries(countCommandsByStatusStmt.all().map((row) => [row.status, row.count]));
  return {
    needAttention: (byStatus.new || 0) + (byStatus.triaged || 0),
    running: byStatus.in_progress || 0,
    artifacts: countArtifactsStmt.get().count,
    researchQueue: byType.research_queue || 0,
    tracking: byType.tracking_update || 0,
    draftCommands: commandsByStatus.draft || 0,
    archived: byStatus.archived || 0,
    byStatus,
    byType,
    commandsByStatus
  };
}
