// desk-recorder API tests: CRUD, search, tag filter, file cleanup, multipart validation.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../src/app.ts";
import { isValidWav } from "../src/whisper.ts";

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

describe("chunked upload stream", () => {
  async function startStream(title = "Streamed note", sampleRate = 16000) {
    const res = await fetch(base + "/api/recordings/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, sampleRate }),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }
  async function chunk(id, bytes) {
    const res = await fetch(base + `/api/recordings/${id}/chunk`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  test("stream -> chunks append in order -> finish yields a valid WAV", async () => {
    const { res: sr, data: sd } = await startStream();
    expect(sr.status).toBe(201);
    const id = sd.recording.id;
    expect(sd.recording.mime).toBe("audio/wav");
    expect(sd.recording.size).toBe(0);

    const c1 = await chunk(id, new Uint8Array([1, 2, 3, 4]));
    expect(c1.res.status).toBe(200);
    expect(c1.data.size).toBe(4);
    const c2 = await chunk(id, new Uint8Array([5, 6]));
    expect(c2.data.size).toBe(6);

    const fin = await fetch(base + `/api/recordings/${id}/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Final title", duration_ms: 2000 }),
    });
    const fd = await fin.json();
    expect(fin.status).toBe(200);
    expect(fd.recording.title).toBe("Final title");
    expect(fd.recording.duration_ms).toBe(2000);
    expect(fd.recording.size).toBe(6);

    const raw = new Uint8Array(await fetch(base + `/api/recordings/${id}/audio`).then((r) => r.arrayBuffer()));
    expect(isValidWav(raw)).toBe(true);
    const v = new DataView(raw.buffer);
    expect(v.getUint32(24, true)).toBe(16000); // sample rate in header
    expect(v.getUint32(40, true)).toBe(6); // data length patched at finish
    expect([...raw.slice(44)]).toEqual([1, 2, 3, 4, 5, 6]); // byte order preserved
  });

  test("finish keeps a custom sample rate in the header", async () => {
    const { data: sd } = await startStream("sr test", 44100);
    const id = sd.recording.id;
    await chunk(id, new Uint8Array([7, 8]));
    await fetch(base + `/api/recordings/${id}/finish`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const raw = new Uint8Array(await fetch(base + `/api/recordings/${id}/audio`).then((r) => r.arrayBuffer()));
    expect(isValidWav(raw)).toBe(true);
    expect(new DataView(raw.buffer).getUint32(24, true)).toBe(44100);
  });

  test("chunk to unknown id is 404", async () => {
    const { res } = await chunk("nope", new Uint8Array([1]));
    expect(res.status).toBe(404);
  });

  test("chunk after finish is 409", async () => {
    const { data: sd } = await startStream("close me");
    const id = sd.recording.id;
    await fetch(base + `/api/recordings/${id}/finish`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const { res } = await chunk(id, new Uint8Array([9]));
    expect(res.status).toBe(409);
  });

  test("empty chunk is 400", async () => {
    const { data: sd } = await startStream("empty chunk");
    const { res } = await chunk(sd.recording.id, new Uint8Array([]));
    expect(res.status).toBe(400);
  });

  test("finish unknown id is 404", async () => {
    const res = await fetch(base + "/api/recordings/nope/finish", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(404);
  });

  test("bad sampleRate is rejected", async () => {
    const { res } = await startStream("bad sr", 123);
    expect(res.status).toBe(400);
  });
});

describe("archive", () => {
  test("archived recordings leave the default list, return with ?archived=1", async () => {
    const { data } = await upload({ audio: audioFile("arch.webm"), title: "To archive" });
    const id = data.recording.id;

    const ar = await fetch(base + `/api/recordings/${id}/archive`, { method: "POST" });
    expect(ar.status).toBe(200);
    expect((await ar.json()).recording.archived).toBe(1);

    const list = await fetch(base + "/api/recordings").then((r) => r.json());
    expect(list.recordings.some((r) => r.id === id)).toBe(false);
    const withArch = await fetch(base + "/api/recordings?archived=1").then((r) => r.json());
    expect(withArch.recordings.some((r) => r.id === id)).toBe(true);

    const un = await fetch(base + `/api/recordings/${id}/unarchive`, { method: "POST" });
    expect((await un.json()).recording.archived).toBe(0);
    const list2 = await fetch(base + "/api/recordings").then((r) => r.json());
    expect(list2.recordings.some((r) => r.id === id)).toBe(true);
  });

  test("archive unknown id is 404", async () => {
    const res = await fetch(base + "/api/recordings/nope/archive", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("send to Abba", () => {
  const oldUrl = process.env.ABBA_URL;
  const oldToken = process.env.ABBA_TOKEN;
  let abbaHits = [];
  let abbaServer = null;

  beforeAll(() => {
    abbaServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/notes" && req.method === "POST") {
          const body = await req.json();
          abbaHits.push({ auth: req.headers.get("authorization"), body });
          return Response.json({ note: { id: 42, title: body.title } }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.ABBA_URL = `http://localhost:${abbaServer.port}`;
  });

  afterAll(() => {
    abbaServer.stop();
    if (oldUrl === undefined) delete process.env.ABBA_URL; else process.env.ABBA_URL = oldUrl;
    if (oldToken === undefined) delete process.env.ABBA_TOKEN; else process.env.ABBA_TOKEN = oldToken;
  });

  async function send(id) {
    const res = await fetch(base + `/api/recordings/${id}/send-to-abba`, { method: "POST" });
    return { res, data: await res.json().catch(() => ({})) };
  }

  test("no token -> 503 with setup guidance", async () => {
    delete process.env.ABBA_TOKEN;
    const { data } = await upload({ audio: audioFile("ab1.webm"), title: "Abba 1" });
    await fetch(base + `/api/recordings/${data.recording.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "hello abba" }),
    });
    const { res, data: sd } = await send(data.recording.id);
    expect(res.status).toBe(503);
    expect(sd.error).toMatch(/ABBA_TOKEN/);
  });

  test("sends transcript as a private note, stores note id, second send is a no-op", async () => {
    process.env.ABBA_TOKEN = "test-token-123";
    abbaHits = [];
    const { data } = await upload({ audio: audioFile("ab2.webm"), title: "Abba 2" });
    const id = data.recording.id;
    await fetch(base + `/api/recordings/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "quarterly review notes" }),
    });
    const { res, data: sd } = await send(id);
    expect(res.status).toBe(200);
    expect(sd.abba_note_id).toBe("42");
    expect(sd.recording.abba_note_id).toBe("42");
    expect(abbaHits.length).toBe(1);
    expect(abbaHits[0].auth).toBe("Bearer test-token-123");
    expect(abbaHits[0].body.title).toBe("Abba 2");
    expect(abbaHits[0].body.body).toMatch(/quarterly review notes/);
    expect(abbaHits[0].body.tags).toEqual(["voice-note"]);
    expect(abbaHits[0].body.shared).toBe(false);

    const again = await send(id);
    expect(again.data.already_sent).toBe(true);
    expect(abbaHits.length).toBe(1); // no duplicate note
  });

  test("nothing to send -> 400", async () => {
    process.env.ABBA_TOKEN = "test-token-123";
    const { data } = await upload({ audio: audioFile("ab3.webm"), title: "Abba 3" });
    const { res, data: sd } = await send(data.recording.id);
    expect(res.status).toBe(400);
    expect(sd.error).toMatch(/nothing to send/);
  });

  test("unknown id -> 404", async () => {
    process.env.ABBA_TOKEN = "test-token-123";
    const { res } = await send("nope");
    expect(res.status).toBe(404);
  });
});
