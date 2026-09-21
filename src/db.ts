// desk-recorder: SQLite schema + data access. Bun + bun:sqlite, zero deps.
import { Database } from "bun:sqlite";

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
}

export function openDb(path: string): Database {
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
  return db;
}

const PUBLIC_COLS =
  "id, title, filename, mime, size, duration_ms, transcript, md_notes, tags, created_at, updated_at";

export function listRecordings(db: Database, q?: string, tag?: string): Recording[] {
  const where: string[] = [];
  const vals: unknown[] = [];
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
  patch: Partial<Pick<Recording, "title" | "transcript" | "md_notes" | "tags" | "duration_ms">>
): Recording | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); vals.push(String(patch.title).slice(0, 200)); }
  if (patch.transcript !== undefined) { sets.push("transcript = ?"); vals.push(String(patch.transcript)); }
  if (patch.md_notes !== undefined) { sets.push("md_notes = ?"); vals.push(String(patch.md_notes)); }
  if (patch.duration_ms !== undefined) { sets.push("duration_ms = ?"); vals.push(Math.max(0, Math.floor(Number(patch.duration_ms) || 0))); }
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
  db.prepare("DELETE FROM recordings WHERE id = ?").run(id);
  return rec;
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
