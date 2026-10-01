// desk-recorder: SQLite schema + data access. Bun + bun:sqlite, zero deps.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface Recording {
  id: string;
  title: string;
  filename: string;
  mime: string;
  size: number;
  duration_ms: number;
  transcript: string;
  md_notes: string;
  tags: string; // JSON array of strings
  created_at: number;
  updated_at: number;
  transcribe_status: string; // idle | queued | working | done | error
  transcribe_error: string;
  archived: number; // 0 | 1
  abba_note_id: string; // Abba note id once sent there, '' until then
}

export interface Todo {
  id: string;
  recording_id: string;
  text: string;
  done: number; // 0 | 1
  position: number;
  created_at: number;
  ascent_task_id: string | null; // Ascent task id once sent there, null until then
}

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      transcript TEXT NOT NULL DEFAULT '',
      md_notes TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recordings_created ON recordings(created_at DESC);
  `);
  // lightweight migration for DBs created before transcription columns existed
  const have = new Set(
    (db.query("PRAGMA table_info(recordings)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!have.has("transcribe_status")) {
    db.exec("ALTER TABLE recordings ADD COLUMN transcribe_status TEXT NOT NULL DEFAULT 'idle'");
  }
  if (!have.has("transcribe_error")) {
    db.exec("ALTER TABLE recordings ADD COLUMN transcribe_error TEXT NOT NULL DEFAULT ''");
  }
  if (!have.has("archived")) {
    db.exec("ALTER TABLE recordings ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  if (!have.has("abba_note_id")) {
    db.exec("ALTER TABLE recordings ADD COLUMN abba_note_id TEXT NOT NULL DEFAULT ''");
  }
  // per-recording to-do items, extracted deterministically from transcripts
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_todos_recording ON todos(recording_id, position);
  `);
  // lightweight migration: to-dos created before the Ascent integration lack
  // the column that tracks which items have already been sent to Ascent
  const todoCols = new Set(
    (db.query("PRAGMA table_info(todos)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!todoCols.has("ascent_task_id")) {
    db.exec("ALTER TABLE todos ADD COLUMN ascent_task_id TEXT");
  }
  return db;
}

const PUBLIC_COLS =
  "id, title, filename, mime, size, duration_ms, transcript, md_notes, tags, created_at, updated_at, transcribe_status, transcribe_error, archived, abba_note_id";

export function listRecordings(db: Database, q?: string, tag?: string, includeArchived = false): Recording[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (!includeArchived) where.push("archived = 0");
  if (q && q.trim()) {
    where.push("(title LIKE ? OR transcript LIKE ? OR md_notes LIKE ?)");
    const like = `%${q.trim()}%`;
    vals.push(like, like, like);
  }
  if (tag && tag.trim()) {
    // tags stored as JSON array; match exact tag via LIKE on quoted form
    where.push("tags LIKE ?");
    vals.push(`%"${tag.trim().replace(/"/g, "")}"%`);
  }
  const sql = `SELECT ${PUBLIC_COLS} FROM recordings${
    where.length ? " WHERE " + where.join(" AND ") : ""
  } ORDER BY created_at DESC`;
  return db.query(sql).all(...vals) as Recording[];
}

export function getRecording(db: Database, id: string): Recording | null {
  return (
    (db.query(`SELECT ${PUBLIC_COLS} FROM recordings WHERE id = ?`).get(id) as Recording) ||
    null
  );
}

export function insertRecording(
  db: Database,
  r: Omit<Recording, "created_at" | "updated_at">
): Recording {
  const now = Date.now();
  db.prepare(
    `INSERT INTO recordings
       (id, title, filename, mime, size, duration_ms, transcript, md_notes, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    r.id, r.title, r.filename, r.mime, r.size, r.duration_ms,
    r.transcript, r.md_notes, r.tags, now, now
  );
  return getRecording(db, r.id)!;
}

export function updateRecording(
  db: Database,
  id: string,
  patch: Partial<Pick<Recording, "title" | "transcript" | "md_notes" | "tags" | "duration_ms" | "archived" | "abba_note_id">>
): Recording | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); vals.push(String(patch.title).slice(0, 200)); }
  if (patch.transcript !== undefined) { sets.push("transcript = ?"); vals.push(String(patch.transcript)); }
  if (patch.md_notes !== undefined) { sets.push("md_notes = ?"); vals.push(String(patch.md_notes)); }
  if (patch.duration_ms !== undefined) { sets.push("duration_ms = ?"); vals.push(Math.max(0, Math.floor(Number(patch.duration_ms) || 0))); }
  if (patch.archived !== undefined) { sets.push("archived = ?"); vals.push(patch.archived ? 1 : 0); }
  if (patch.abba_note_id !== undefined) { sets.push("abba_note_id = ?"); vals.push(String(patch.abba_note_id).slice(0, 64)); }
  if (patch.tags !== undefined) {
    const tags = Array.isArray(patch.tags)
      ? [...new Set(patch.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20)
      : [];
    sets.push("tags = ?");
    vals.push(JSON.stringify(tags));
  }
  if (!sets.length) return getRecording(db, id);
  sets.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(id);
  const res = db.prepare(`UPDATE recordings SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  if (res.changes === 0) return null;
  return getRecording(db, id);
}

export function deleteRecording(db: Database, id: string): Recording | null {
  const rec = getRecording(db, id);
  if (!rec) return null;
  db.prepare("DELETE FROM todos WHERE recording_id = ?").run(id);
  db.prepare("DELETE FROM recordings WHERE id = ?").run(id);
  return rec;
}

// Append-only accounting for chunked uploads: bump size without rewriting.
export function addRecordingBytes(db: Database, id: string, n: number): void {
  db.prepare("UPDATE recordings SET size = size + ?, updated_at = ? WHERE id = ?").run(n, Date.now(), id);
}

const TODO_COLS =
  "id, recording_id, text, done, position, created_at, ascent_task_id";

/* ---------------- to-dos ---------------- */

export function listTodos(db: Database, recordingId: string): Todo[] {
  return db
    .query(`SELECT ${TODO_COLS} FROM todos WHERE recording_id = ? ORDER BY position ASC, created_at ASC`)
    .all(recordingId) as Todo[];
}

export function getTodo(db: Database, todoId: string): Todo | null {
  return (
    (db.query(`SELECT ${TODO_COLS} FROM todos WHERE id = ?`).get(todoId) as Todo) ||
    null
  );
}

/** Unchecked to-dos that have never been sent to Ascent — the send candidates. */
export function listSendableTodos(db: Database, recordingId: string): Todo[] {
  return db
    .query(
      `SELECT ${TODO_COLS} FROM todos WHERE recording_id = ? AND done = 0 AND (ascent_task_id IS NULL OR ascent_task_id = '') ORDER BY position ASC, created_at ASC`
    )
    .all(recordingId) as Todo[];
}

/**
 * Add extracted items for a recording, skipping any already present
 * (case-insensitive). Existing done states are preserved. Returns the
 * number of items added.
 */
export function mergeTodos(db: Database, recordingId: string, texts: string[]): { added: number } {
  const existing = new Set(listTodos(db, recordingId).map((t) => t.text.toLowerCase().trim()));
  const row = db.query("SELECT COALESCE(MAX(position), -1) AS m FROM todos WHERE recording_id = ?").get(recordingId) as { m: number };
  let pos = row.m;
  let added = 0;
  const stmt = db.prepare(
    "INSERT INTO todos (id, recording_id, text, done, position, created_at) VALUES (?, ?, ?, 0, ?, ?)"
  );
  for (const raw of texts) {
    const text = raw.trim().slice(0, 500);
    if (!text) continue;
    const key = text.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    pos += 1;
    stmt.run(randomUUID(), recordingId, text, pos, Date.now());
    added += 1;
  }
  return { added };
}

export function setTodoDone(db: Database, todoId: string, done: 0 | 1): Todo | null {
  const res = db.prepare("UPDATE todos SET done = ? WHERE id = ?").run(done, todoId);
  if (res.changes === 0) return null;
  return getTodo(db, todoId);
}

/** Mark a to-do as sent to Ascent by recording the Ascent task id. */
export function setTodoAscentId(db: Database, todoId: string, ascentTaskId: string): Todo | null {
  const res = db.prepare("UPDATE todos SET ascent_task_id = ? WHERE id = ?").run(ascentTaskId, todoId);
  if (res.changes === 0) return null;
  return getTodo(db, todoId);
}

export function deleteTodo(db: Database, todoId: string): Todo | null {
  const todo = getTodo(db, todoId);
  if (!todo) return null;
  db.prepare("DELETE FROM todos WHERE id = ?").run(todoId);
  return todo;
}

export type TranscribeStatus = "idle" | "queued" | "working" | "done" | "error";

/** Set transcription state; optionally store the transcript and/or an error. */
export function setTranscriptionState(
  db: Database,
  id: string,
  status: TranscribeStatus,
  transcript?: string,
  error?: string
): Recording | null {
  const sets = ["transcribe_status = ?"];
  const vals: unknown[] = [status];
  if (transcript !== undefined) {
    sets.push("transcript = ?");
    vals.push(String(transcript));
  }
  if (error !== undefined) {
    sets.push("transcribe_error = ?");
    vals.push(String(error));
  }
  sets.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(id);
  const res = db.prepare(`UPDATE recordings SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  if (res.changes === 0) return null;
  return getRecording(db, id);
}

export function distinctTags(db: Database): string[] {
  const rows = db.query("SELECT tags FROM recordings").all() as { tags: string }[];
  const set = new Set<string>();
  for (const row of rows) {
    try {
      for (const t of JSON.parse(row.tags || "[]")) if (typeof t === "string" && t) set.add(t);
    } catch { /* ignore malformed */ }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
