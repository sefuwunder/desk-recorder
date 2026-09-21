// desk-recorder → Ascent: "Send to Ascent" flow against a tiny stub Ascent
// server (no live Ascent or Anytype contacted).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";

let base = "";
let stopDr: () => void = () => {};
let tmp = "";
let stubBase = "";
let stopStub: () => void = () => {};
const OLD_ASCENT = process.env.ASCENT_URL;
const OLD_BIN = process.env.WHISPER_BIN;

// ---------- stub Ascent ----------
const requests: string[] = [];
let projects: { id: string; name: string; icon?: string }[] = [];
let tasks: { id: string; project_id: string; title: string; notes: string }[] = [];
let seq = 1;
let mode: "ok" | "unpaired" | "task-fail" = "ok";

function json(v: unknown, status = 200) {
  return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
}

const TRANSCRIPT =
  "We talked about the quarterly numbers. I need to send the budget report by Friday. " +
  "Don't forget to call the dentist. Schedule the board review for Monday.";

async function uploadWebm(title = "ascent test") {
  const fd = new FormData();
  fd.append("audio", new File([new Uint8Array([1, 2, 3])], "note.webm", { type: "audio/webm" }));
  fd.append("title", title);
  const res = await fetch(base + "/api/recordings", { method: "POST", body: fd });
  return (await res.json()).recording.id as string;
}

async function seedRecording(): Promise<string> {
  const id = await uploadWebm();
  await fetch(base + `/api/transcript/${id}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: TRANSCRIPT }),
  });
  return id;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "desk-ascent-"));
  process.env.WHISPER_BIN = join(tmp, "definitely-not-there"); // keep offline engine inert
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}`);
      if (mode === "unpaired" && url.pathname.startsWith("/api/")) {
        return json({ error: "not paired with Anytype yet" }, 401);
      }
      if (url.pathname === "/api/projects" && req.method === "GET") {
        return json({ projects });
      }
      if (url.pathname === "/api/projects" && req.method === "POST") {
        const b = (await req.json()) as { name?: string; icon?: string };
        if (!b.name?.trim()) return json({ error: "project name is required" }, 400);
        const p = { id: `p${seq++}`, name: b.name.trim(), icon: b.icon };
        projects.push(p);
        return json({ project: p }, 201);
      }
      const m = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks$/);
      if (m && req.method === "POST") {
        if (mode === "task-fail") return json({ error: "boom" }, 500);
        const b = (await req.json()) as { title?: string; notes?: string };
        if (!b.title?.trim()) return json({ error: "task title is required" }, 400);
        const t = { id: `t${seq++}`, project_id: m[1], title: b.title.trim(), notes: String(b.notes || "") };
        tasks.push(t);
        return json({ task: t }, 201);
      }
      return json({ error: "not found" }, 404);
    },
  });
  stubBase = `http://localhost:${stub.port}`;
  stopStub = () => stub.stop();

  process.env.ASCENT_URL = stubBase;
  const { server } = buildApp({ port: 0, dataDir: tmp, dbPath: join(tmp, "t.db") });
  base = `http://localhost:${server.port}`;
  stopDr = () => server.stop();
});

afterAll(() => {
  stopDr();
  stopStub();
  if (OLD_ASCENT === undefined) delete process.env.ASCENT_URL;
  else process.env.ASCENT_URL = OLD_ASCENT;
  if (OLD_BIN === undefined) delete process.env.WHISPER_BIN;
  else process.env.WHISPER_BIN = OLD_BIN;
  rmSync(tmp, { recursive: true, force: true });
});

describe("send to-dos to Ascent", () => {
  test("creates the Desk Recorder project and sends only unchecked to-dos", async () => {
    const id = await seedRecording();
    const todos = (await (await fetch(base + `/api/recordings/${id}/todos`)).json()).todos;
    expect(todos).toHaveLength(3);
    // check one off — it must not be sent
    const doneOne = todos.find((t: any) => t.text.includes("dentist"));
    await fetch(base + `/api/todos/${doneOne.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: 1 }),
    });

    requests.length = 0;
    const r = await fetch(base + `/api/recordings/${id}/todos/send-to-ascent`, { method: "POST" });
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out.sent).toBe(2);
    expect(out.project.name).toBe("Desk Recorder");
    expect(requests).toContain("GET /api/projects");
    expect(requests).toContain("POST /api/projects");
    const created = tasks.filter((t) => t.project_id === out.project.id);
    expect(created.map((t) => t.title).sort()).toEqual([
      "Schedule the board review for Monday",
      "Send the budget report by Friday",
    ].sort());
    expect(created[0].notes).toContain("From desk recorder:");
    // sent to-dos are tracked
    const after = (await (await fetch(base + `/api/recordings/${id}/todos`)).json()).todos;
    expect(after.filter((t: any) => t.ascent_task_id).map((t: any) => t.text).sort()).toEqual(
      ["Schedule the board review for Monday", "Send the budget report by Friday"].sort()
    );
    expect(after.find((t: any) => t.text.includes("dentist")).ascent_task_id).toBeNull();
  });

  test("re-click sends nothing new", async () => {
    const id = await seedRecording();
    await fetch(base + `/api/recordings/${id}/todos/send-to-ascent`, { method: "POST" });
    const before = requests.length;
    const r = await fetch(base + `/api/recordings/${id}/todos/send-to-ascent`, { method: "POST" });
    const out = await r.json();
    expect(r.status).toBe(200);
    expect(out.sent).toBe(0);
    // only the project-list lookup fires; no task creations
    const newReqs = requests.slice(before);
    expect(newReqs).toEqual(["GET /api/projects"]);
  });

  test("a new to-do is sent on the next click, old ones skipped", async () => {
    const id = await seedRecording();
    await fetch(base + `/api/recordings/${id}/todos/send-to-ascent`, { method: "POST" });
    // new transcript with one extra item merges in
    await fetch(base + `/api/transcript/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: TRANSCRIPT + " Buy more tape for the deck." }),
    });
    const before = tasks.length;
    const r = await fetch(base + `/api/recordings/${id}/todos/send-to-ascent`, { method: "POST" });
    const out = await r.json();
    expect(out.sent).toBe(1);
    expect(tasks.slice(before).map((t) => t.title)).toEqual(["Buy more tape for the deck"]);
  });

  test("reuses an existing Desk Recorder project without creating a duplicate", async () => {
    projects = [{ id: "pexisting", name: "Desk Recorder" }];
    const id = await seedRecording();
    const before = requests.length;
    const r = await fetch(base + `/api/recordings/${id}/todos/send-to-ascent`, { method: "POST" });
    const out = await r.json();
    expect(r.status).toBe(200);
    expect(out.project.id).toBe("pexisting");
    const newReqs = requests.slice(before);
    expect(newReqs).not.toContain("POST /api/projects");
    expect(tasks[tasks.length - 1].project_id).toBe("pexisting");
  });

  test("Ascent errors are surfaced plainly", async () => {
    mode = "unpaired";
    const id = await seedRecording();
    const r = await fetch(base + `/api/recordings/${id}/todos/send-to-ascent`, { method: "POST" });
    expect(r.status).toBe(502);
    const out = await r.json();
    expect(out.error).toContain("not paired with Anytype yet");
    mode = "ok";
  });

  test("mid-run task failure marks what was sent and reports the error", async () => {
    mode = "task-fail";
    const id = await seedRecording();
    const r = await fetch(base + `/api/recordings/${id}/todos/send-to-ascent`, { method: "POST" });
    expect(r.status).toBe(502);
    const out = await r.json();
    expect(out.error).toContain("boom");
    mode = "ok";
  });

  test("unreachable Ascent names the URL it tried", async () => {
    process.env.ASCENT_URL = "http://127.0.0.1:1"; // nothing listens here
    const id = await seedRecording();
    const r = await fetch(base + `/api/recordings/${id}/todos/send-to-ascent`, { method: "POST" });
    expect(r.status).toBe(502);
    const out = await r.json();
    expect(out.error).toContain("http://127.0.0.1:1");
    expect(out.error).toContain("is Ascent running?");
    process.env.ASCENT_URL = stubBase;
  });

  test("404 for an unknown recording", async () => {
    const r = await fetch(base + `/api/recordings/nope/todos/send-to-ascent`, { method: "POST" });
    expect(r.status).toBe(404);
  });
});

describe("todos migration", () => {
  test("ascent_task_id is added to pre-existing todos tables", async () => {
    const dbPath = join(tmp, "mig.db");
    const db = openDb(dbPath);
    db.exec("ALTER TABLE todos DROP COLUMN ascent_task_id");
    db.close();
    const reopened = openDb(dbPath);
    const cols = (reopened.query("PRAGMA table_info(todos)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("ascent_task_id");
    reopened.close();
  });
});
