# Desk Recorder

An executive desk recorder for capturing and organizing transcribed voice notes — styled as a line-art reel-to-reel deck (dark charcoal, thin off-white strokes, amber record accent).

**Stack:** Bun + zero npm dependencies + built-in SQLite. Port **3010**. Single-user, localhost, no auth.

## Features

- **Record** — big transport (● record / ■ stop / ▶ play), mic capture via `MediaRecorder` (webm/opus). Files land in gitignored `data/audio/`, metadata in SQLite.
- **Animated tape mechanism** — SVG reels spin while recording/playing (CSS, state-driven), tape-pack fill levels shift with progress, running `MM:SS:CS` timecode, and VU meters driven by a **real** `AnalyserNode` (mic during record, playback stream during play — no fake oscillation).
- **Live transcription** — browser `SpeechRecognition`/`webkitSpeechRecognition` (zero-dep, no model downloads). Interim results stream onto the "tape readout"; the final transcript is saved per recording. Graceful notice + manual-entry fallback when unsupported (needs Chrome/Edge; works on localhost without HTTPS).
- **Organize** — sidebar list (title, date, duration, tags), full-text search over titles/transcripts/markdown notes, tag filter chips, rename, delete (with confirmation, removes the audio file too), export as `.md`.
- **Markdown notes** — per-note editor + rendered preview via a small zero-dep renderer (headings, bold/italic, lists, links, code, quotes). Transcripts are editable too.

Respects `prefers-reduced-motion` (reels still, meters static). Responsive down to 390px.

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
- `GET /api/tags` — distinct tags

## Tests

```sh
bun test
```

Covers API CRUD, search, tag filtering/normalization, file cleanup on delete, multipart validation (non-audio rejected, 25MB cap), plus the timecode formatter and markdown renderer (evaluated from `public/lib.js` with a stubbed document).

## Notes

- Speech recognition is a browser cloud service: it needs Chrome/Edge, mic permission, and network. Everything else works fully offline.
- Real mic + transcription can't be verified headless — confirm on your machine.
