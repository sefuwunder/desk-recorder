// desk-recorder API tests: CRUD, search, tag filter, file cleanup, multipart validation.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../src/app.ts";

let base = "";
let stop: () => void = () => {};
let tmp = "";

function audioFile(name = "note.webm", type = "audio/webm", bytes = new Uint8Array([1, 2, 3, 4])) {
  return new File([bytes], name, { type });
}

async function upload(fields: Record<string, unknown> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v as never);
  const res = await fetch(base + "/api/recordings", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "desk-rec-"));
  const { server } = buildApp({ port: 0, dataDir: tmp, dbPath: join(tmp, "t.db") });
  base = `http://localhost:${server.port}`;
  stop = () => server.stop();
});

afterAll(() => {
  stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("recordings API", () => {
  test("POST valid audio creates a recording + file on disk", async () => {
    const { res, data } = await upload({ audio: audioFile(), title: "Board meeting", duration_ms: "61000" });
    expect(res.status).toBe(201);
    const r = data.recording;
    expect(r.id).toBeString();
    expect(r.title).toBe("Board meeting");
    expect(r.duration_ms).toBe(61000);
    expect(r.size).toBe(4);
    expect(existsSync(join(tmp, "audio", r.filename))).toBe(true);
  });

  test("POST defaults title when blank", async () => {
    const { res, data } = await upload({ audio: audioFile("a.webm") });
    expect(res.status).toBe(201);
    expect(data.recording.title).toMatch(/^Voice note/);
  });

  test("POST without audio is rejected", async () => {
    const { res, data } = await upload({ title: "nope" });
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/audio/i);
  });

  test("POST non-audio file is rejected", async () => {
    const evil = new File(["<html>"], "x.html", { type: "text/html" });
    const { res, data } = await upload({ audio: evil });
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/not an audio/i);
  });

  test("POST oversize audio is rejected with 413", async () => {
    const big = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "big.webm", { type: "audio/webm" });
    const { res, data } = await upload({ audio: big });
    expect(res.status).toBe(413);
    expect(data.error).toMatch(/25MB/);
  });

  test("GET list / GET one / 404", async () => {
    await upload({ audio: audioFile("one.webm"), title: "Alpha note about budgets" });
    await upload({ audio: audioFile("two.webm"), title: "Beta note" });
    const list = await (await fetch(base + "/api/recordings")).json();
    expect(list.recordings.length).toBeGreaterThanOrEqual(2);
    const id = list.recordings[0].id;
    const one = await (await fetch(base + `/api/recordings/${id}`)).json();
    expect(one.recording.id).toBe(id);
    const nf = await fetch(base + "/api/recordings/does-not-exist");
    expect(nf.status).toBe(404);
  });

  test("search q matches title/transcript/notes", async () => {
    const { data } = await upload({ audio: audioFile("s.webm"), title: "Searchable" });
    const id = data.recording.id;
    await fetch(base + `/api/recordings/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "the zebra acquisition closed", md_notes: "## follow up" }),
    });
    for (const q of ["zebra", "follow up", "Searchable"]) {
      const r = await (await fetch(base + "/api/recordings?q=" + encodeURIComponent(q))).json();
      expect(r.recordings.some((x: { id: string }) => x.id === id)).toBe(true);
    }
    const miss = await (await fetch(base + "/api/recordings?q=qqq-no-match")).json();
    expect(miss.recordings.some((x: { id: string }) => x.id === id)).toBe(false);
  });

  test("tag filter + tags endpoint + tag normalization", async () => {
    const { data } = await upload({ audio: audioFile("t.webm"), title: "Tagged" });
    const id = data.recording.id;
    const p = await (
      await fetch(base + `/api/recordings/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: [" board ", "board", "ideas", ""] }),
      })
    ).json();
    expect(JSON.parse(p.recording.tags)).toEqual(["board", "ideas"]);
    const f = await (await fetch(base + "/api/recordings?tag=board")).json();
    expect(f.recordings.some((x: { id: string }) => x.id === id)).toBe(true);
    const f2 = await (await fetch(base + "/api/recordings?tag=ideas")).json();
    expect(f2.recordings.some((x: { id: string }) => x.id === id)).toBe(true);
    const f3 = await (await fetch(base + "/api/recordings?tag=nope")).json();
    expect(f3.recordings.some((x: { id: string }) => x.id === id)).toBe(false);
    const tags = await (await fetch(base + "/api/tags")).json();
    expect(tags.tags).toContain("board");
  });

  test("POST /api/transcript/:id saves transcript; rejects non-string", async () => {
    const { data } = await upload({ audio: audioFile("tr.webm"), title: "Tr" });
    const id = data.recording.id;
    const ok = await (
      await fetch(base + `/api/transcript/${id}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: "hello world" }),
      })
    ).json();
    expect(ok.recording.transcript).toBe("hello world");
    const bad = await fetch(base + `/api/transcript/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: 42 }),
    });
    expect(bad.status).toBe(400);
    const nf = await fetch(base + "/api/transcript/nope", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "x" }),
    });
    expect(nf.status).toBe(404);
  });

  test("GET audio streams bytes with content-type", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const { data } = await upload({ audio: audioFile("s.webm", "audio/webm", bytes) });
    const res = await fetch(base + `/api/recordings/${data.recording.id}/audio`);
    expect(res.status).toBe(200);
    // Note: Bun's File normalizes bare "audio/webm" to "video/webm"; the server
    // faithfully round-trips whatever type the client declared.
    expect(res.headers.get("content-type")).toBe(data.recording.mime);
    expect(res.headers.get("content-type")).toMatch(/webm/);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf]).toEqual([9, 8, 7, 6, 5]);
    const nf = await fetch(base + "/api/recordings/nope/audio");
    expect(nf.status).toBe(404);
  });

  test("DELETE removes row and audio file", async () => {
    const { data } = await upload({ audio: audioFile("d.webm"), title: "Doomed" });
    const id = data.recording.id;
    const fname = data.recording.filename;
    expect(existsSync(join(tmp, "audio", fname))).toBe(true);
    const del = await fetch(base + `/api/recordings/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(existsSync(join(tmp, "audio", fname))).toBe(false);
    const gone = await fetch(base + `/api/recordings/${id}`);
    expect(gone.status).toBe(404);
    const del2 = await fetch(base + `/api/recordings/${id}`, { method: "DELETE" });
    expect(del2.status).toBe(404);
  });

  test("PATCH unknown id is 404", async () => {
    const res = await fetch(base + "/api/recordings/nope", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
  });
});
