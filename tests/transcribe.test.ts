// desk-recorder transcription tests: WAV validation, downsample/encode,
// whisper endpoints with a fake whisper-cli, status shape, no path leaks.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../src/app.ts";
import { setTranscriptionState } from "../src/db.ts";
import {
  isValidWav, isAvailable, getTranscribeStatus, transcribeFile,
} from "../src/whisper.ts";
import { readFileSync } from "node:fs";

// ---- lib.js via stubbed eval (same pattern as lib.test.ts) ----
const libSrc = readFileSync(new URL("../public/lib.js", import.meta.url), "utf8");
const L = new Function("window", "document", "module", libSrc + "\nreturn DeskLib;")(
  {}, { createElement: () => { throw new Error("no DOM"); } }, { exports: {} }
);

describe("isValidWav", () => {
  test("accepts a RIFF/WAVE header", () => {
    const b = new Uint8Array(44);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    b.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    expect(isValidWav(b)).toBe(true);
  });
  test("rejects short buffers", () => expect(isValidWav(new Uint8Array(11))).toBe(false));
  test("rejects wrong magic", () => {
    const b = new Uint8Array(44);
    b.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
    expect(isValidWav(b)).toBe(false);
  });
  test("rejects RIFF non-WAVE", () => {
    const b = new Uint8Array(44);
    b.set([0x52, 0x49, 0x46, 0x46], 0);
    b.set([0x41, 0x56, 0x49, 0x20], 8); // AVI
    expect(isValidWav(b)).toBe(false);
  });
});

describe("downsampleTo16k", () => {
  test("1s of 48kHz sine -> 16000 samples, values track the sine", () => {
    const N = 48000, f = 440;
    const input = new Float32Array(N);
    for (let i = 0; i < N; i++) input[i] = Math.sin((2 * Math.PI * f * i) / N);
    const out = L.downsampleTo16k(input, 48000);
    expect(out.length).toBe(16000);
    let worst = 0;
    for (let i = 0; i < out.length; i++) {
      const ideal = Math.sin((2 * Math.PI * f * i) / 16000);
      worst = Math.max(worst, Math.abs(out[i] - ideal));
    }
    expect(worst).toBeLessThan(0.02);
  });
  test("same rate passes through", () => {
    const input = new Float32Array([0.1, -0.2, 0.3]);
    const out = L.downsampleTo16k(input, 16000);
    expect(out.length).toBe(3);
    expect(out[1]).toBeCloseTo(-0.2, 6);
  });
  test("empty input -> empty output", () => {
    expect(L.downsampleTo16k(new Float32Array(0), 48000).length).toBe(0);
  });
});

describe("encodeWavPcm16", () => {
  test("header + samples round-trip", () => {
    const bytes = L.encodeWavPcm16(new Float32Array([0, 0.5, -0.5, 1, -1]));
    expect(bytes.length).toBe(44 + 10);
    const tag = (o: number, n: number) =>
      String.fromCharCode(...bytes.slice(o, o + n));
    expect(tag(0, 4)).toBe("RIFF");
    expect(tag(8, 4)).toBe("WAVE");
    expect(tag(12, 4)).toBe("fmt ");
    expect(tag(36, 4)).toBe("data");
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(v.getUint32(24, true)).toBe(16000); // sample rate
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(40, true)).toBe(10); // data bytes
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(Math.round(0.5 * 32767));
    expect(v.getInt16(48, true)).toBe(Math.round(-0.5 * 32767));
    expect(v.getInt16(50, true)).toBe(32767);
    expect(v.getInt16(52, true)).toBe(-32767);
    // server-side validator accepts our own output
    expect(isValidWav(bytes)).toBe(true);
  });
});

// ---- fake whisper-cli plumbing ----
let tmp = "";
let base = "";
let stop: () => void = () => {};
let db: any = null;
const CANNED = "canned transcript from fake whisper";

function makeWav(seconds = 1): File {
  const n = 16000 * seconds;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000);
  const bytes = L.encodeWavPcm16(pcm);
  return new File([bytes], "note.wav", { type: "audio/wav" });
}

async function uploadWav() {
  const fd = new FormData();
  fd.append("audio", makeWav());
  fd.append("title", "whisper test");
  const res = await fetch(base + "/api/recordings", { method: "POST", body: fd });
  const data = await res.json();
  return { res, id: data.recording.id as string };
}

async function waitFor(id: string, want: string, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(base + "/api/recordings/" + id).then((x) => x.json());
    if (r.recording.transcribe_status === want) return r.recording;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + want);
    await new Promise((r2) => setTimeout(r2, 100));
  }
}

const OLD_BIN = process.env.WHISPER_BIN;
const OLD_MODEL = process.env.WHISPER_MODEL_PATH;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "desk-whisper-"));
  // fake whisper-cli: writes canned text to the -of target, or sleeps when asked
  const fake = join(tmp, "whisper-cli");
  writeFileSync(
    fake,
    "#!/bin/sh\n" +
      'if [ -n "$FAKE_WHISPER_SLEEP" ]; then sleep 5; fi\n' +
      'out=""; prev=""\n' +
      'for a in "$@"; do if [ "$prev" = "-of" ]; then out="$a"; fi; prev="$a"; done\n' +
      `echo "${CANNED}" > "$out.txt"\n`
  );
  chmodSync(fake, 0o755);
  writeFileSync(join(tmp, "model.bin"), "fake-model");
  process.env.WHISPER_BIN = fake;
  process.env.WHISPER_MODEL_PATH = join(tmp, "model.bin");

  const app = buildApp({ port: 0, dataDir: tmp, dbPath: join(tmp, "t.db") });
  base = `http://localhost:${app.server.port}`;
  db = app.db;
  stop = () => app.server.stop();
});

afterAll(() => {
  stop();
  if (OLD_BIN === undefined) delete process.env.WHISPER_BIN;
  else process.env.WHISPER_BIN = OLD_BIN;
  if (OLD_MODEL === undefined) delete process.env.WHISPER_MODEL_PATH;
  else process.env.WHISPER_MODEL_PATH = OLD_MODEL;
  rmSync(tmp, { recursive: true, force: true });
});

describe("whisper engine", () => {
  test("isAvailable true with fake bin + model", () => {
    expect(isAvailable(tmp)).toBe(true);
  });
  test("transcribeFile returns canned text", async () => {
    const wav = join(tmp, "direct.wav");
    const f = makeWav();
    writeFileSync(wav, new Uint8Array(await f.arrayBuffer()));
    expect(await transcribeFile(tmp, wav)).toBe(CANNED);
  });
  test("transcribeFile times out on a hanging binary", async () => {
    const wav = join(tmp, "direct.wav");
    process.env.FAKE_WHISPER_SLEEP = "1";
    try {
      await expect(transcribeFile(tmp, wav, 300)).rejects.toThrow("timed out");
    } finally {
      delete process.env.FAKE_WHISPER_SLEEP;
    }
  });
  test("transcribeFile rejects when engine missing", async () => {
    process.env.WHISPER_BIN = join(tmp, "nope");
    try {
      await expect(transcribeFile(tmp, join(tmp, "direct.wav"))).rejects.toThrow(
        "not available"
      );
    } finally {
      process.env.WHISPER_BIN = join(tmp, "whisper-cli");
    }
  });
});

describe("transcribe API", () => {
  test("upload auto-transcribes WAV (idle->queued->working->done)", async () => {
    const { res, id } = await uploadWav();
    expect(res.status).toBe(201);
    const rec = await waitFor(id, "done");
    expect(rec.transcript).toBe(CANNED);
    expect(rec.transcribe_error).toBe("");
  });

  test("manual POST /:id/transcribe -> 202 and completes", async () => {
    const { id } = await uploadWav();
    await waitFor(id, "done");
    setTranscriptionState(db, id, "idle", "", "");
    const res = await fetch(base + `/api/recordings/${id}/transcribe`, { method: "POST" });
    expect(res.status).toBe(202);
    const rec = await waitFor(id, "done");
    expect(rec.transcript).toBe(CANNED);
  });

  test("transcribe a non-WAV recording -> 400", async () => {
    const fd = new FormData();
    fd.append("audio", new File([new Uint8Array([1, 2, 3])], "note.webm", { type: "audio/webm" }));
    const up = await fetch(base + "/api/recordings", { method: "POST", body: fd });
    const id = (await up.json()).recording.id;
    const res = await fetch(base + `/api/recordings/${id}/transcribe`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/WAV/);
  });

  test("transcribe unknown id -> 404", async () => {
    const res = await fetch(base + "/api/recordings/nope/transcribe", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("GET /api/transcribe/status shape, no path leaks", async () => {
    const res = await fetch(base + "/api/transcribe/status");
    const s = await res.json();
    expect(s.available).toBe(true);
    expect(s.model).toBe("model.bin"); // basename of WHISPER_MODEL_PATH
    expect(s.binary).toBe("whisper-cli");
    expect(JSON.stringify(s)).not.toContain(tmp);
  });

  test("unavailable engine -> status false, transcribe 503", async () => {
    process.env.WHISPER_BIN = join(tmp, "nope");
    try {
      const s = await fetch(base + "/api/transcribe/status").then((r) => r.json());
      expect(s.available).toBe(false);
      const { id } = await uploadWav();
      const rec0 = await fetch(base + "/api/recordings/" + id).then((r) => r.json());
      expect(rec0.recording.transcribe_status).toBe("idle"); // no auto-queue
      const res = await fetch(base + `/api/recordings/${id}/transcribe`, { method: "POST" });
      expect(res.status).toBe(503);
    } finally {
      process.env.WHISPER_BIN = join(tmp, "whisper-cli");
    }
  });
});
