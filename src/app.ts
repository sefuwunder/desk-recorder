// desk-recorder: HTTP app factory (testable) + static file serving.
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import {
  openDb, listRecordings, getRecording, insertRecording,
  updateRecording, deleteRecording, distinctTags, setTranscriptionState,
  listTodos, getTodo, mergeTodos, setTodoDone, deleteTodo,
  listSendableTodos, setTodoAscentId,
} from "./db.ts";
import {
  isAvailable, getTranscribeStatus, isValidWav, transcribeFile,
} from "./whisper.ts";
import { extractTodos } from "./todos.ts";
import {
  ascentBase, findOrCreateProject, createAscentTask, AscentError,
} from "./ascent.ts";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // ~25MB
const AUDIO_EXTS = [".webm", ".mp3", ".wav", ".ogg", ".oga", ".m4a", ".mp4", ".flac"];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function audioDir(dataDir: string): string {
  return join(dataDir, "audio");
}

function isAudioFile(name: string, type: string): boolean {
  if (type && type.toLowerCase().startsWith("audio/")) return true;
  const lower = name.toLowerCase();
  return AUDIO_EXTS.some((e) => lower.endsWith(e));
}

export interface AppOptions {
  port: number;
  dataDir: string;
  dbPath?: string;
}

export function buildApp(opts: AppOptions) {
  const dataDir = opts.dataDir;
  const dir = audioDir(dataDir);
  mkdirSync(dir, { recursive: true }); // data/ is gitignored; create it on first run
  const db = openDb(opts.dbPath || join(dataDir, "desk-recorder.db"));

  /** Background whisper transcription for one recording. Never throws. */
  async function runTranscription(id: string): Promise<void> {
    const rec = getRecording(db, id);
    if (!rec || rec.transcribe_status === "working") return;
    const wavPath = join(dir, basename(rec.filename));
    const f = Bun.file(wavPath);
    if (!(await f.exists())) {
      setTranscriptionState(db, id, "error", undefined, "audio file missing");
      return;
    }
    const head = new Uint8Array(await f.slice(0, 12).arrayBuffer());
    if (!isValidWav(head)) {
      setTranscriptionState(db, id, "error", undefined, "not a WAV file");
      return;
    }
    setTranscriptionState(db, id, "working");
    try {
      const text = await transcribeFile(dataDir, wavPath);
      setTranscriptionState(db, id, "done", text, "");
      // pull actionable items out of the finished transcript (merge-only:
      // existing items and their done states are preserved)
      if (text.trim()) mergeTodos(db, id, extractTodos(text));
    } catch (e) {
      setTranscriptionState(
        db, id, "error", undefined,
        e instanceof Error ? e.message : "transcription failed"
      );
    }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    const method = req.method.toUpperCase();

    // ---- API: collection
    if (path === "/api/recordings" && method === "GET") {
      return json({
        recordings: listRecordings(db, url.searchParams.get("q") || undefined, url.searchParams.get("tag") || undefined),
      });
    }
    if (path === "/api/tags" && method === "GET") {
      return json({ tags: distinctTags(db) });
    }
    if (path === "/api/recordings" && method === "POST") {
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        return json({ error: "expected multipart form data" }, 400);
      }
      const audio = form.get("audio");
      const titleRaw = form.get("title");
      if (!(audio instanceof File) || audio.size === 0) {
        return json({ error: "missing audio file (field: audio)" }, 400);
      }
      if (!isAudioFile(audio.name || "", audio.type || "")) {
        return json({ error: "not an audio file" }, 400);
      }
      if (audio.size > MAX_AUDIO_BYTES) {
        return json({ error: "audio exceeds 25MB cap" }, 413);
      }
      const id = randomUUID();
      const ext = ("." + (audio.name.split(".").pop() || "webm")).toLowerCase().replace(/[^a-z0-9.]/g, "") || ".webm";
      const filename = `${id}${AUDIO_EXTS.includes(ext) ? ext : ".webm"}`;
      await Bun.write(join(dir, filename), audio);
      const rec = insertRecording(db, {
        id,
        title: (typeof titleRaw === "string" && titleRaw.trim()) || `Voice note ${new Date().toLocaleString()}`,
        filename,
        mime: audio.type || "audio/webm",
        size: audio.size,
        duration_ms: Math.max(0, Math.floor(Number(form.get("duration_ms")) || 0)),
        transcript: "",
        md_notes: "",
        tags: "[]",
      });
      // Auto-transcribe WAV uploads when the offline engine is set up.
      if (isAvailable(dataDir)) {
        const head = new Uint8Array(await Bun.file(join(dir, filename)).slice(0, 12).arrayBuffer());
        if (isValidWav(head)) {
          setTranscriptionState(db, id, "queued");
          runTranscription(id).catch(() => {});
        }
      }
      return json({ recording: rec }, 201);
    }

    // ---- API: single recording routes
    const m = path.match(/^\/api\/recordings\/([^/]+)(\/(audio))?$/);
    if (m) {
      const id = m[1];
      if (method === "GET" && !m[3]) {
        const rec = getRecording(db, id);
        return rec ? json({ recording: rec }) : json({ error: "not found" }, 404);
      }
      if (method === "GET" && m[3] === "audio") {
        const rec = getRecording(db, id);
        if (!rec) return json({ error: "not found" }, 404);
        const file = Bun.file(join(dir, basename(rec.filename)));
        if (!(await file.exists())) return json({ error: "audio file missing" }, 404);
        return new Response(file, {
          headers: {
            "content-type": rec.mime || "audio/webm",
            "content-length": String(rec.size),
            "accept-ranges": "bytes",
          },
        });
      }
      if (method === "PATCH") {
        let body: Record<string, unknown>;
        try {
          body = await req.json();
        } catch {
          return json({ error: "expected JSON body" }, 400);
        }
        const rec = updateRecording(db, id, body as never);
        return rec ? json({ recording: rec }) : json({ error: "not found" }, 404);
      }
      if (method === "DELETE") {
        const rec = deleteRecording(db, id);
        if (!rec) return json({ error: "not found" }, 404);
        try {
          await unlink(join(dir, basename(rec.filename)));
        } catch { /* file already gone */ }
        return json({ ok: true });
      }
    }

    // ---- API: offline transcription status (never exposes paths)
    if (path === "/api/transcribe/status" && method === "GET") {
      return json(getTranscribeStatus(dataDir));
    }

    // ---- API: request offline transcription of one recording
    const trm = path.match(/^\/api\/recordings\/([^/]+)\/transcribe$/);
    if (trm && method === "POST") {
      const rec = getRecording(db, trm[1]);
      if (!rec) return json({ error: "not found" }, 404);
      if (!isAvailable(dataDir)) {
        return json({ error: "offline transcription not set up — run scripts/setup-transcription.sh" }, 503);
      }
      const wavPath = join(dir, basename(rec.filename));
      const f = Bun.file(wavPath);
      if (!(await f.exists())) return json({ error: "audio file missing" }, 404);
      const head = new Uint8Array(await f.slice(0, 12).arrayBuffer());
      if (!isValidWav(head)) return json({ error: "only WAV recordings can be transcribed" }, 400);
      if (rec.transcribe_status === "queued" || rec.transcribe_status === "working") {
        return json({ recording: rec }, 202);
      }
      setTranscriptionState(db, rec.id, "queued");
      runTranscription(rec.id).catch(() => {});
      return json({ recording: getRecording(db, rec.id) }, 202);
    }

    // ---- API: save final transcript from the client
    const tm = path.match(/^\/api\/transcript\/([^/]+)$/);
    if (tm && method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return json({ error: "expected JSON body" }, 400);
      }
      if (typeof body.transcript !== "string") {
        return json({ error: "transcript must be a string" }, 400);
      }
      const rec = updateRecording(db, tm[1], { transcript: body.transcript });
      if (rec && body.transcript.trim()) {
        // browser-finalized transcripts get to-dos too (merge-only)
        mergeTodos(db, rec.id, extractTodos(body.transcript));
      }
      return rec ? json({ recording: rec }) : json({ error: "not found" }, 404);
    }

    // ---- API: per-recording to-dos
    const tdList = path.match(/^\/api\/recordings\/([^/]+)\/todos$/);
    if (tdList && method === "GET") {
      const rec = getRecording(db, tdList[1]);
      if (!rec) return json({ error: "not found" }, 404);
      return json({ todos: listTodos(db, rec.id) });
    }
    const tdExtract = path.match(/^\/api\/recordings\/([^/]+)\/todos\/extract$/);
    if (tdExtract && method === "POST") {
      const rec = getRecording(db, tdExtract[1]);
      if (!rec) return json({ error: "not found" }, 404);
      const { added } = mergeTodos(db, rec.id, extractTodos(rec.transcript || ""));
      return json({ todos: listTodos(db, rec.id), added });
    }
    // ---- API: send a recording's open, never-sent to-dos to Ascent.
    // Explicit per click — no auto-sync. Find-or-creates the "Desk Recorder"
    // project in Ascent, creates one task per to-do, and records the Ascent
    // task id so a re-click only sends new items.
    const tdSend = path.match(/^\/api\/recordings\/([^/]+)\/todos\/send-to-ascent$/);
    if (tdSend && method === "POST") {
      const rec = getRecording(db, tdSend[1]);
      if (!rec) return json({ error: "not found" }, 404);
      const pending = listSendableTodos(db, rec.id);
      const base = ascentBase();
      try {
        const project = await findOrCreateProject(base);
        let sent = 0;
        // Sequential so a mid-run failure leaves a clean resume point:
        // sent items are marked, the error names how many went through.
        for (const t of pending) {
          const created = await createAscentTask(
            base, project.id, t.text, `From desk recorder: “${rec.title}”`
          );
          setTodoAscentId(db, t.id, created.id);
          sent++;
        }
        return json({ todos: listTodos(db, rec.id), sent, project });
      } catch (e: unknown) {
        const msg = e instanceof AscentError ? e.message : String(e);
        return json({ error: msg, todos: listTodos(db, rec.id) }, 502);
      }
    }
    const tdOne = path.match(/^\/api\/todos\/([^/]+)$/);
    if (tdOne) {
      if (method === "PATCH") {
        let body: Record<string, unknown>;
        try {
          body = await req.json();
        } catch {
          return json({ error: "expected JSON body" }, 400);
        }
        const done =
          body.done === 1 || body.done === true ? 1 :
          body.done === 0 || body.done === false ? 0 : null;
        if (done === null) return json({ error: "done must be 0 or 1" }, 400);
        const todo = setTodoDone(db, tdOne[1], done);
        return todo ? json({ todo }) : json({ error: "not found" }, 404);
      }
      if (method === "DELETE") {
        const todo = deleteTodo(db, tdOne[1]);
        return todo ? json({ ok: true }) : json({ error: "not found" }, 404);
      }
    }

    // ---- static
    if (method === "GET") {
      let p = path === "/" ? "/index.html" : path;
      if (p.includes("..")) return new Response("bad path", { status: 400 });
      const root = new URL("../public/", import.meta.url);
      const file = Bun.file(new URL("." + p, root));
      if (await file.exists()) return new Response(file);
    }
    return new Response("not found", { status: 404 });
  }

  const server = Bun.serve({ port: opts.port, fetch: handle });
  return { server, db, dataDir };
}
