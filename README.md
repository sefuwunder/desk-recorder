# Desk Recorder

An executive desk recorder for capturing and organizing transcribed voice notes — styled as a line-art reel-to-reel deck (dark charcoal, thin off-white strokes, amber record accent).

**Stack:** Bun + zero npm dependencies + built-in SQLite. Port **3010**. Single-user, localhost, no auth.

## Features

- **Record** — big transport (● record / ■ stop / ▶ play), mic capture via an `AudioWorklet` WAV recorder (16kHz mono 16-bit PCM, ~2MB/min — no ffmpeg needed). Files land in gitignored `data/audio/`, metadata in SQLite.
- **Animated tape mechanism** — SVG reels spin while recording/playing (CSS, state-driven), tape-pack fill levels shift with progress, running `MM:SS:CS` timecode, and VU meters driven by a **real** `AnalyserNode` (mic during record, playback stream during play — no fake oscillation).
- **Transcription, two ways** —
  - *Offline (server-side, any browser):* after recording stops, the server transcribes the WAV with a local whisper.cpp binary (`data/whisper/whisper-cli` + model, CPU, no network). The note shows Queued → Transcribing… → done, and the transcript is stored on the recording. Set it up once with `scripts/setup-transcription.sh`.
  - *Live interim (Chrome/Edge only):* browser `SpeechRecognition` streams interim results onto the "tape readout" while recording; when offline transcription is set up, the server transcript becomes the final stored text. Firefox has no Web Speech API, so it relies on the offline path.
- **Organize** — sidebar list (title, date, duration, tags), full-text search over titles/transcripts/markdown notes, tag filter chips, rename, delete (with confirmation, removes the audio file too), export as `.md`.
- **Markdown notes** — per-note editor + rendered preview via a small zero-dep renderer (headings, bold/italic, lists, links, code, quotes). Transcripts are editable too.

Respects `prefers-reduced-motion` (reels still, meters static). Responsive down to 390px.

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
- `GET /api/tags` — distinct tags

## Tests

```sh
bun test
```

Covers API CRUD, search, tag filtering/normalization, file cleanup on delete, multipart validation (non-audio rejected, 25MB cap), plus the timecode formatter and markdown renderer (evaluated from `public/lib.js` with a stubbed document).

## Notes

- Browser live transcription is a cloud service: it needs Chrome/Edge, mic permission, and network. The offline whisper path is fully local and works in any browser.
- Real mic + transcription can't be verified headless — confirm on your machine.
