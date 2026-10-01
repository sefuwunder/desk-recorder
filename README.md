# Desk Recorder

An executive desk recorder for capturing and organizing transcribed voice notes — styled as a line-art reel-to-reel deck (dark charcoal, thin off-white strokes, amber record accent).

**Stack:** Bun + zero npm dependencies + built-in SQLite. Port **3010**. Single-user, localhost, no auth.

## Features

- **Record** — big transport (● record / ■ stop / ▶ play), mic capture via an `AudioWorklet` (16kHz mono 16-bit PCM, ~2MB/min — no ffmpeg needed). Audio streams to the server in ~2s chunks as it records, so long sessions never pile up in tab memory. Files land in gitignored `data/audio/`, metadata in SQLite.
- **Animated tape mechanism** — SVG reels spin while recording/playing (CSS, state-driven), tape-pack fill levels shift with progress, running `MM:SS:CS` timecode, and VU meters driven by a **real** `AnalyserNode` (mic during record, playback stream during play — no fake oscillation).
- **Transcription, two ways** —
  - *Offline (server-side, any browser):* after recording stops, the server transcribes the WAV with a local whisper.cpp binary (`data/whisper/whisper-cli` + model, CPU, no network). The note shows Queued → Transcribing… → done, and the transcript is stored on the recording. Set it up once with `scripts/setup-transcription.sh`.
  - *Live interim (Chrome/Edge only):* browser `SpeechRecognition` streams interim results onto the "tape readout" while recording; when offline transcription is set up, the server transcript becomes the final stored text. Firefox has no Web Speech API, so it relies on the offline path.
- **Organize** — sidebar list (title, date, duration, tags), full-text search over titles/transcripts/markdown notes, tag filter chips, rename, delete (with confirmation, removes the audio file too), export as `.md`.
- **Markdown notes** — per-note editor + rendered preview via a small zero-dep renderer (headings, bold/italic, lists, links, code, quotes). Transcripts are editable too.

Respects `prefers-reduced-motion` (reels still, meters static). Responsive down to 390px.

**Themes** — Tokyo Night (dark) and Tokyo Dawn (light), toggled from the moon/sun switch in the topbar. Choice persists in `localStorage` (`dr-theme`); with no saved choice the OS `prefers-color-scheme` decides. The theme is applied before first paint, so there's no flash.

## Offline transcription setup

```sh
scripts/setup-transcription.sh
# downloads (or builds) whisper-cli and the ggml-base.en.bin model into data/whisper/
```

Env overrides: `WHISPER_BIN` (path to a whisper.cpp binary), `WHISPER_MODEL` (model file name under `data/whisper/`, default `ggml-base.en.bin`), `WHISPER_MODEL_PATH` (absolute model path). The footer shows whether the engine is available; each note has a Transcribe button when its transcript is empty. Only WAV recordings are transcribed (everything the deck records is WAV); other formats keep manual transcripts.

## Run

```sh
bun src/server.ts
# open http://localhost:3010
```

Env: `PORT` (default 3010), `DATA_DIR` (default `./data`).

## API

- `POST /api/recordings` — multipart (`audio` file ≤25MB, `title`, `duration_ms`) → 201
- `GET /api/recordings?q=&tag=` — list (full-text search + tag filter)
- `GET /api/recordings/:id` · `PATCH /api/recordings/:id` (title, transcript, md_notes, tags, duration_ms) · `DELETE /api/recordings/:id` (removes audio file too)
- `GET /api/recordings/:id/audio` — streams the audio
- `POST /api/transcript/:id` — `{transcript}` saves the final client transcript
- `GET /api/transcribe/status` — `{available, model, binary}` (paths never exposed)
- `POST /api/recordings/:id/transcribe` — 202, transcribes in the background (WAV only); recording gains `transcribe_status` (`idle|queued|working|done|error`) + `transcribe_error`
- `GET /api/recordings/:id/todos` — per-recording to-do list, in extraction order
- `POST /api/recordings/:id/todos/extract` — re-run extraction on demand (`{todos, added}`; merges, never duplicates, preserves done states)
- `POST /api/recordings/:id/todos/send-to-ascent` — send open, never-sent to-dos to Ascent (see below; `{todos, sent, project}`)
- `PATCH /api/todos/:todoId` — `{done: 0|1}` toggles a to-do
- `DELETE /api/todos/:todoId` — removes a to-do
- `GET /api/tags` — distinct tags

## To-dos from transcripts

When a transcription finishes (offline whisper or the browser-finalized text),
the server runs a **deterministic, fully local heuristic** (`src/todos.ts`) over
the transcript and files the results as a checkable per-recording list in the
new **To-dos** tab — no LLM, no network.

The extractor sentence-splits the transcript and keeps sentences that look
actionable: imperatives at the start ("call", "email", "schedule", "finish", …),
or commitment phrases ("need to", "have to", "must", "let's", "don't forget",
"remind me", "action item", "to-do", "follow up", "we should", …). Spoken
filler ("um", "so", "first,", "then") is stripped, each item is truncated to
140 chars, duplicates are dropped, and questions ("Should we…?") are never
treated as commitments. It's conservative on purpose: it would rather miss a
borderline item than flood the list with false positives.

Extraction is **merge-only**: re-transcribing (or hitting "Extract to-dos")
adds new items but never duplicates or resets items you've checked off.
To-dos are stored in a `todos` SQLite table and deleted with their recording.
There's no manual add, no due dates, no export, and no cross-recording list —
deliberately small surface, easy to extend later.

## Send to-dos to Ascent

The To-dos tab has a **Send to Ascent** button. Clicking it pushes the
recording's *open, never-sent* to-dos into [Ascent](https://github.com/sefuwunder/ascent)
under a project named **"Desk Recorder"** (created on first send, reused after).
One Ascent task is created per to-do, with a note linking back to the
recording's title. Sending is explicit per click — there is no auto-sync.

Each sent to-do records its Ascent task id (`ascent_task_id`), so clicking the
button again only sends new items; already-checked items are never sent. If
Ascent isn't reachable, the button says so plainly with the URL it tried.
Ascent runs at `http://127.0.0.1:3004` by default; override with the
`ASCENT_URL` environment variable when starting desk-recorder.

## Tests

```sh
bun test
```

Covers API CRUD, search, tag filtering/normalization, file cleanup on delete, multipart validation (non-audio rejected, 25MB cap), plus the timecode formatter and markdown renderer (evaluated from `public/lib.js` with a stubbed document).

## Notes

- Browser live transcription is a cloud service: it needs Chrome/Edge, mic permission, and network. The offline whisper path is fully local and works in any browser.
- Real mic + transcription can't be verified headless — confirm on your machine.
