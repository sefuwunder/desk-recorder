// desk-recorder: HTTP app factory (testable) + static file serving.
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import {
  openDb, listRecordings, getRecording, insertRecording,
  updateRecording, deleteRecording, distinctTags,
} from "./db.ts";

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
  const db = openDb(opts.dbPath || join(dataDir, "desk-recorder.db"));

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
      return rec ? json({ recording: rec }) : json({ error: "not found" }, 404);
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
