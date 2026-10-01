/* desk-recorder client: transport, tape deck animation, real VU meters via
   WebAudio AnalyserNode, AudioWorklet 16kHz mono capture streamed to the
   server in chunks as it records (flat tab memory), SpeechRecognition live
   interim text, offline server transcription status. Zero deps. */
(function () {
  "use strict";
  var L = window.DeskLib;
  var esc = L.escapeHtml;

  /* ---------------- API ---------------- */
  async function api(path, opts) {
    var res = await fetch(path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) throw new Error((data && data.error) || ("request failed: " + res.status));
    return data;
  }
  var GET = (p) => api(p);
  var POST = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  var PATCH = (p, body) => api(p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  var DEL = (p) => api(p, { method: "DELETE" });

  /* ---------------- state ---------------- */
  var state = {
    recordings: [],
    tags: [],
    currentId: null,
    q: "",
    tag: "",
    showArchived: false,
    transport: "idle", // idle | recording | playing
    detailTab: "transcript",
    todos: [],
  };

  /* ---------------- dom ---------------- */
  function $(id) { return document.getElementById(id); }
  var reelL = $("reelL"), reelR = $("reelR"), fillL = $("fillL"), fillR = $("fillR");
  var timecodeText = $("timecodeText"), recDot = $("recDot");
  var meterL = $("meterL"), meterR = $("meterR");
  var btnRecord = $("btnRecord"), btnStop = $("btnStop"), btnPlay = $("btnPlay");
  var statusLine = $("statusLine"), scrubTrack = $("scrubTrack"), scrubHead = $("scrubHead");
  var scrubCur = $("scrubCur"), scrubTot = $("scrubTot");
  var readout = $("readout"), interimText = $("interimText"), srNotice = $("srNotice");
  var notesList = $("notesList"), noteCount = $("noteCount"), searchInput = $("searchInput");
  var tagChips = $("tagChips"), chipArchived = $("chipArchived"), nowRec = $("nowRec");
  var detailPanel = $("detailPanel"), detailTitle = $("detailTitle"), detailMeta = $("detailMeta");
  var transcriptEdit = $("transcriptEdit"), notesEdit = $("notesEdit"), notesPreview = $("notesPreview");
  var tagList = $("tagList"), tagInput = $("tagInput");
  var btnTranscribe = $("btnTranscribe"), sttPill = $("sttPill"), sttNotice = $("sttNotice");
  var todoList = $("todoList"), todoCount = $("todoCount");
  var btnExtractTodos = $("btnExtractTodos"), todoHint = $("todoHint");

  $("topDate").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  }).toUpperCase();

  /* ---------------- theme ---------------- */
  var themeNightBtn = $("themeNight"), themeDawnBtn = $("themeDawn");
  function setTheme(t) {
    var theme = L.resolveTheme(
      t,
      window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)").matches : false
    );
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("dr-theme", theme); } catch (e) { /* private mode */ }
    var night = theme === "tokyo-night";
    themeNightBtn.classList.toggle("on", night);
    themeDawnBtn.classList.toggle("on", !night);
    themeNightBtn.setAttribute("aria-pressed", night ? "true" : "false");
    themeDawnBtn.setAttribute("aria-pressed", !night ? "true" : "false");
  }
  themeNightBtn.addEventListener("click", function () { setTheme("tokyo-night"); });
  themeDawnBtn.addEventListener("click", function () { setTheme("tokyo-dawn"); });
  // sync buttons with the theme the <head> pre-paint script already applied
  setTheme(document.documentElement.getAttribute("data-theme"));

  /* ---------------- audio engine ---------------- */
  var audioEl = new Audio();
  audioEl.preload = "metadata";
  var actx = null, analyser = null, analyserData = null, mediaSrc = null;
  var meterRAF = 0, clockRAF = 0;
  var micStream = null, micSource = null, workletNode = null, recStart = 0;
  // chunked upload state: 16-bit mono PCM streams to the server as it is
  // captured, so a long session never accumulates in tab memory.
  // Uploads are serialized (one promise chain) to keep byte order exact.
  var streamId = null, streamTitle = "", pendingPcm = new Int16Array(65536), pendingLen = 0,
      uploadChain = Promise.resolve(), chunkErrors = 0, totalSamples = 0;
  var workletRegisteredCtx = null; // AudioWorklet module registration is per-AudioContext; register once
  var recog = null, recogFinal = "", recogWanted = false;
  var serverSTT = { available: false, model: "", binary: "" };

  /* Inline AudioWorklet: forwards raw Float32 mono chunks to the main thread.
     A silent gain keeps the node rendering even with no audible output. */
  var WORKLET_SRC =
    "class WavCap extends AudioWorkletProcessor{" +
    "process(i){var c=i[0];if(c&&c[0])this.port.postMessage(c[0].slice(0));return true;}" +
    "}registerProcessor('wav-cap',WavCap);";

  function ensureCtx() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try { actx = new AC({ sampleRate: 16000 }); }
      catch (e) { actx = new AC(); } // older browser: resample below instead
      analyser = actx.createAnalyser();
      analyser.fftSize = 1024;
      analyserData = new Uint8Array(analyser.fftSize);
    }
    if (actx.state === "suspended") actx.resume();
    return true;
  }

  function level01() {
    if (!analyser || !analyserData) return 0;
    analyser.getByteTimeDomainData(analyserData);
    var sum = 0;
    for (var i = 0; i < analyserData.length; i++) {
      var v = (analyserData[i] - 128) / 128;
      sum += v * v;
    }
    var rms = Math.sqrt(sum / analyserData.length);
    return Math.min(1, rms * 3.2);
  }

  function drawMeters() {
    var lvl = level01();
    // slight stereo decorrelation so the two bars feel alive
    var l = Math.min(1, lvl * (0.92 + Math.random() * 0.16));
    var r = Math.min(1, lvl * (0.92 + Math.random() * 0.16));
    setMeter(meterL, l); setMeter(meterR, r);
    meterRAF = requestAnimationFrame(drawMeters);
  }
  function setMeter(el, v) {
    var h = Math.round(v * 170);
    el.setAttribute("height", String(h));
    el.setAttribute("y", String(230 - h));
    el.classList.toggle("hot", v > 0.85);
  }
  function stopMeters() {
    cancelAnimationFrame(meterRAF);
    setMeter(meterL, 0); setMeter(meterR, 0);
  }

  /* ---------------- deck visuals ---------------- */
  function setDeckState(s, opts) {
    opts = opts || {};
    state.transport = s;
    var spinning = s === "recording" || s === "playing";
    reelL.classList.toggle("spinning", spinning);
    reelR.classList.toggle("spinning", spinning);
    reelL.classList.toggle("spinning-fast", s === "recording");
    reelR.classList.toggle("spinning-fast", s === "recording");
    recDot.classList.toggle("on", s === "recording");
    timecodeText.classList.toggle("rec", s === "recording");
    scrubHead.classList.toggle("recording", s === "recording");
    btnRecord.classList.toggle("armed", s === "recording");
    btnRecord.disabled = s === "recording";
    btnStop.disabled = s === "idle";
    btnPlay.disabled = s !== "idle" || !state.currentId;
    nowRec.classList.toggle("show", s === "recording");
    readout.classList.toggle("live", s === "recording");
    if (s === "idle") {
      stopMeters(); cancelAnimationFrame(clockRAF);
      timecodeText.textContent = "00:00:00";
      if (!opts.keepHead) scrubHead.style.left = "0%";
    }
    statusLine.innerHTML =
      s === "recording" ? '<span class="amber">● REC</span> — capturing' :
      s === "playing" ? "▶ PLAYBACK" : "READY";
  }

  function tickClock(getMs) {
    cancelAnimationFrame(clockRAF);
    function frame() {
      var ms = getMs();
      timecodeText.textContent = L.formatTimecode(ms);
      scrubCur.textContent = L.formatDuration(ms);
      if (state.transport === "playing") updatePlaybackProgress();
      if (state.transport === "recording") updateRecordProgress(ms);
      clockRAF = requestAnimationFrame(frame);
    }
    frame();
  }

  function updatePlaybackProgress() {
    var rec = current();
    var dur = rec && rec.duration_ms ? rec.duration_ms : (audioEl.duration * 1000 || 0);
    var ms = audioEl.currentTime * 1000;
    var p = dur ? Math.min(1, ms / dur) : 0;
    scrubHead.style.left = (p * 100).toFixed(2) + "%";
    setFill(fillL, 82 - p * 60);
    setFill(fillR, 30 + p * 52);
  }
  function updateRecordProgress(ms) {
    // while recording, the takeup (right) reel grows slowly; cap the visual
    var p = Math.min(1, ms / 600000);
    scrubHead.style.left = (p * 100).toFixed(2) + "%";
    setFill(fillL, 82 - p * 20);
    setFill(fillR, 30 + p * 20);
  }
  function setFill(el, r) { el.setAttribute("r", String(Math.max(12, Math.round(r)))); }
  function resetReels() { setFill(fillL, 82); setFill(fillR, 30); }

  /* ---------------- recording ---------------- */
  function srSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }
  function showNotice(html) {
    srNotice.innerHTML = html;
    srNotice.classList.add("show");
  }

  async function startRecording() {
    if (state.transport === "recording") return;
    stopPlayback();
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      showNotice("<strong>Microphone blocked.</strong> Grant mic permission to record, or type notes manually below.");
      return;
    }
    micStream = stream;
    if (!ensureCtx()) {
      showNotice("<strong>Audio engine unavailable</strong> in this browser.");
      cleanupMic();
      return;
    }
    var src = actx.createMediaStreamSource(stream);
    src.connect(analyser);
    micSource = src;

    // PCM capture: raw mic samples -> worklet -> Float32 messages, converted to
    // 16-bit and streamed to the server in chunks as recording proceeds.
    // whisper.cpp needs WAV and we ship no ffmpeg, so we record PCM ourselves.
    // The processor name registers once per AudioContext — re-adding throws.
    try {
      if (!actx.audioWorklet) throw new Error("no audioWorklet");
      if (workletRegisteredCtx !== actx) {
        var blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
        try {
          await actx.audioWorklet.addModule(blobUrl);
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
        workletRegisteredCtx = actx;
      }
    } catch (e) {
      showNotice("<strong>Recording not supported</strong> in this browser.");
      cleanupMic();
      return;
    }
    // open the server-side recording before the first chunk arrives
    streamTitle = "Voice note — " + new Date().toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    try {
      var opened = await POST("/api/recordings/stream", {
        title: streamTitle, sampleRate: actx.sampleRate || 16000,
      });
      streamId = opened.recording.id;
    } catch (e) {
      showNotice("<strong>Could not start upload session:</strong> " + esc(e.message));
      cleanupMic();
      return;
    }
    workletNode = new AudioWorkletNode(actx, "wav-cap");
    pendingPcm = new Int16Array(65536);
    pendingLen = 0;
    uploadChain = Promise.resolve();
    chunkErrors = 0;
    totalSamples = 0;
    workletNode.port.onmessage = function (e) { pushPcm(floatTo16(e.data)); };
    src.connect(workletNode);
    // keep the worklet rendering: route through a silent gain to the destination
    var silent = actx.createGain();
    silent.gain.value = 0;
    workletNode.connect(silent);
    silent.connect(actx.destination);

    recogFinal = "";
    interimText.textContent = "";
    startRecognition();

    recStart = Date.now();
    setDeckState("recording");
    drawMeters();
    tickClock(() => Date.now() - recStart);
    renderNotes();
  }

  function startRecognition() {
    if (!srSupported()) {
      showNotice(serverSTT.available
        ? "<strong>Live transcription unavailable</strong> in this browser — offline transcription will transcribe this note automatically after recording."
        : "<strong>Live transcription unavailable:</strong> this needs Chrome or Edge. " +
          "Recording still works — you can type or paste the transcript below.");
      return;
    }
    try {
      var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
      recog = new Ctor();
      recog.continuous = true;
      recog.interimResults = true;
      recog.lang = "en-US";
      recogWanted = true;
      recog.onresult = (e) => {
        var interim = "", finalBits = [];
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var r = e.results[i];
          if (r.isFinal) finalBits.push(r[0].transcript);
          else interim += r[0].transcript;
        }
        if (finalBits.length) {
          recogFinal += (recogFinal ? " " : "") + finalBits.join(" ");
        }
        interimText.textContent = interim;
      };
      recog.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          showNotice("<strong>Transcription blocked:</strong> mic permission or network issue. " +
            "Audio keeps recording; transcript can be typed below.");
          recogWanted = false;
        } else if (e.error === "network") {
          showNotice("<strong>Transcription needs network</strong> (browser speech service). " +
            "Audio keeps recording; transcript can be typed below.");
        }
      };
      recog.onend = () => {
        // Chrome auto-stops after a stretch; keep it alive while recording.
        if (recogWanted && state.transport === "recording") {
          try { recog.start(); } catch (err) { /* already started */ }
        }
      };
      recog.start();
    } catch (e) {
      showNotice("<strong>Could not start transcription.</strong> Recording continues; transcript can be typed below.");
    }
  }

  function stopRecognition() {
    recogWanted = false;
    if (recog) { try { recog.onend = null; recog.stop(); } catch (e) { /* noop */ } recog = null; }
  }

  function cleanupMic() {
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (workletNode) { try { workletNode.disconnect(); } catch (e) { /* noop */ } workletNode = null; }
    if (micSource) { try { micSource.disconnect(); } catch (e) { /* noop */ } micSource = null; }
  }

  function stopRecording() {
    if (state.transport !== "recording") return;
    stopRecognition();
    cleanupMic();
    onWavStop();
  }

  // Float32 mono -> 16-bit PCM, clamped.
  function floatTo16(f32) {
    var out = new Int16Array(f32.length);
    for (var i = 0; i < f32.length; i++) {
      var v = f32[i] < -1 ? -1 : f32[i] > 1 ? 1 : f32[i];
      out[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
    }
    return out;
  }

  // Buffer captured PCM and flush ~2s batches to the server as they arrive.
  function pushPcm(s16) {
    if (pendingLen + s16.length > pendingPcm.length) {
      var bigger = new Int16Array(Math.max(pendingPcm.length * 2, pendingLen + s16.length));
      bigger.set(pendingPcm.subarray(0, pendingLen));
      pendingPcm = bigger;
    }
    pendingPcm.set(s16, pendingLen);
    pendingLen += s16.length;
    totalSamples += s16.length;
    if (pendingLen >= 32000) flushChunks(); // ~2s at 16kHz
  }

  // Upload one batch, serialized behind earlier batches so the server
  // appends bytes in exact order. A failed batch is retried once, then
  // skipped with a warning (a gap beats losing the whole session).
  function flushChunks() {
    if (!pendingLen || !streamId) return Promise.resolve();
    var bytes = new Uint8Array(pendingPcm.buffer, 0, pendingLen * 2);
    pendingPcm = new Int16Array(65536);
    pendingLen = 0;
    var attempt = function (retried) {
      return fetch("/api/recordings/" + streamId + "/chunk", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      })
        .then(function (r) {
          if (!r.ok) throw new Error("chunk rejected: " + r.status);
        })
        .catch(function (e) {
          if (!retried) return attempt(true);
          chunkErrors++;
          console.warn("[desk-recorder] chunk upload failed, continuing with a gap:", e);
        });
    };
    uploadChain = uploadChain.then(function () { return attempt(false); });
    return uploadChain;
  }

  async function onWavStop() {
    // flush any buffered PCM, then wait for every upload to land
    flushChunks();
    try { await uploadChain; } catch (e) { /* counted in chunkErrors */ }
    var durationMs = Date.now() - recStart;

    var interim = interimText.textContent;
    var finalText = (recogFinal + (interim ? " " + interim : "")).trim();
    interimText.textContent = "";

    setDeckState("idle");
    resetReels();
    renderNotes();

    var sid = streamId, title = streamTitle || "Voice note";
    streamId = null;
    streamTitle = "";
    pendingPcm = new Int16Array(65536);
    pendingLen = 0;
    if (!sid || totalSamples < 1600) { // < 0.1s of audio
      if (sid) DEL("/api/recordings/" + sid).catch(function () {});
      showNotice("<strong>Empty recording</strong> — nothing was captured.");
      return;
    }
    try {
      var data = await POST("/api/recordings/" + sid + "/finish", {
        title: title,
        duration_ms: durationMs,
      });
      if (chunkErrors) {
        showNotice("<strong>Saved with gaps:</strong> " + chunkErrors + " audio chunk(s) failed to upload.");
      }
      // Browser interim is only the stored transcript when the offline engine is absent;
      // otherwise the server-side transcript replaces it on completion.
      if (finalText && !serverSTT.available) {
        await POST("/api/transcript/" + data.recording.id, { transcript: finalText });
      }
      await refresh();
      selectRecording(data.recording.id);
      if (serverSTT.available) pollTranscribe(data.recording.id);
      else if (!finalText) showNotice("Saved. " + (srSupported()
        ? "No speech was detected — transcript left empty."
        : "Tip: set up offline transcription (see footer) for automatic transcripts in this browser."));
    } catch (e) {
      showNotice("<strong>Could not save recording:</strong> " + esc(e.message));
    }
  }

  /* ---------------- playback ---------------- */
  function current() {
    return state.recordings.find((r) => r.id === state.currentId) || null;
  }

  function loadCurrent() {
    var rec = current();
    if (!rec) return;
    audioEl.src = "/api/recordings/" + rec.id + "/audio";
    scrubTot.textContent = L.formatDuration(rec.duration_ms || 0);
    scrubCur.textContent = "00:00";
    scrubHead.style.left = "0%";
    resetReels();
    setDeckState("idle", { keepHead: true });
    btnPlay.disabled = false;
  }

  function startPlayback() {
    if (state.transport === "recording" || !state.currentId) return;
    if (!ensureCtx()) return;
    if (!mediaSrc) {
      try {
        mediaSrc = actx.createMediaElementSource(audioEl);
        mediaSrc.connect(analyser);
        analyser.connect(actx.destination);
      } catch (e) { /* source already wired */ }
    }
    audioEl.play().then(() => {
      setDeckState("playing");
      drawMeters();
      tickClock(() => audioEl.currentTime * 1000);
    }).catch(() => { /* user gesture needed */ });
  }

  function stopPlayback() {
    if (state.transport !== "playing") { audioEl.pause(); return; }
    audioEl.pause();
    setDeckState("idle", { keepHead: true });
  }
  audioEl.addEventListener("ended", () => setDeckState("idle"));

  btnRecord.addEventListener("click", startRecording);
  btnStop.addEventListener("click", () => {
    if (state.transport === "recording") stopRecording();
    else stopPlayback();
  });
  btnPlay.addEventListener("click", () => {
    if (state.transport === "playing") stopPlayback();
    else startPlayback();
  });

  /* scrubber */
  function scrubTo(clientX) {
    var rec = current();
    if (!rec || !rec.duration_ms) return;
    var rect = scrubTrack.getBoundingClientRect();
    var p = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (audioEl.src) audioEl.currentTime = (p * rec.duration_ms) / 1000;
    scrubHead.style.left = (p * 100).toFixed(2) + "%";
    scrubCur.textContent = L.formatDuration(p * rec.duration_ms);
    setFill(fillL, 82 - p * 60);
    setFill(fillR, 30 + p * 52);
  }
  var scrubbing = false;
  scrubTrack.addEventListener("pointerdown", (e) => { scrubbing = true; scrubTrack.setPointerCapture(e.pointerId); scrubTo(e.clientX); });
  scrubTrack.addEventListener("pointermove", (e) => { if (scrubbing) scrubTo(e.clientX); });
  scrubTrack.addEventListener("pointerup", () => { scrubbing = false; });

  /* ---------------- offline transcription (whisper.cpp, server-side) ---------------- */
  async function checkServerSTT() {
    try {
      var s = await GET("/api/transcribe/status");
      serverSTT.available = !!s.available;
      serverSTT.model = s.model || "";
      serverSTT.binary = s.binary || "";
    } catch (e) { serverSTT.available = false; }
    if (serverSTT.available) {
      sttNotice.innerHTML = 'OFFLINE TRANSCRIPTION READY <span class="dim">(' + esc(serverSTT.model) + ")</span>";
      sttNotice.classList.add("ok");
    } else {
      sttNotice.innerHTML = "OFFLINE TRANSCRIPTION NOT SET UP — RUN <code>scripts/setup-transcription.sh</code>";
      sttNotice.classList.remove("ok");
    }
  }

  function renderSTT(rec) {
    if (!rec) { btnTranscribe.hidden = true; sttPill.hidden = true; return; }
    var st = rec.transcribe_status || "idle";
    btnTranscribe.hidden = !serverSTT.available || st === "queued" || st === "working" || !!rec.transcript;
    if (st === "idle") {
      sttPill.hidden = true;
    } else {
      sttPill.hidden = false;
      sttPill.className = "stt-pill " + st;
      sttPill.textContent =
        st === "queued" ? "Queued" :
        st === "working" ? "Transcribing…" :
        st === "done" ? "Transcribed ✓" :
        "Error" + (rec.transcribe_error ? ": " + rec.transcribe_error : "");
    }
  }

  btnTranscribe.addEventListener("click", async () => {
    var rec = current();
    if (!rec) return;
    btnTranscribe.hidden = true;
    try {
      await POST("/api/recordings/" + rec.id + "/transcribe");
      pollTranscribe(rec.id);
    } catch (e) {
      showNotice("<strong>Transcribe failed:</strong> " + esc(e.message));
      renderSTT(current());
    }
  });

  var transcribeTimer = 0;
  function pollTranscribe(id) {
    clearInterval(transcribeTimer);
    transcribeTimer = setInterval(async () => {
      try {
        var data = await GET("/api/recordings/" + id);
        var rec = data.recording;
        if (!rec) { clearInterval(transcribeTimer); return; }
        var i = state.recordings.findIndex((r) => r.id === id);
        if (i >= 0) state.recordings[i] = rec;
        if (state.currentId === id) {
          renderSTT(rec);
          // fill the transcript box on completion, unless the user is editing it
          if ((rec.transcribe_status === "done" || rec.transcribe_status === "error") &&
              document.activeElement !== transcriptEdit) {
            if (rec.transcript) transcriptEdit.value = rec.transcript;
          }
        }
        if (rec.transcribe_status === "done" || rec.transcribe_status === "error") {
          clearInterval(transcribeTimer);
          renderNotes();
          if (rec.transcribe_status === "done") loadTodos(state.currentId);
        }
      } catch (e) { clearInterval(transcribeTimer); }
    }, 2000);
  }

  /* ---------------- notes list ---------------- */
  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function renderNotes() {
    notesList.innerHTML = "";
    noteCount.textContent = state.recordings.length ? "(" + state.recordings.length + ")" : "";
    if (!state.recordings.length) {
      notesList.innerHTML = '<div class="notes-empty">No voice notes yet.<br>Hit ● to record your first.</div>';
      return;
    }
    state.recordings.forEach((r) => {
      var b = document.createElement("button");
      b.className = "note-item" + (r.id === state.currentId ? " sel" : "") + (r.archived ? " archived" : "");
      var tags = [];
      try { tags = JSON.parse(r.tags || "[]"); } catch (e) { /* ignore */ }
      b.innerHTML =
        '<div class="t">' + esc(r.title || "Untitled") + "</div>" +
        '<div class="m">' + esc(fmtDate(r.created_at)) + " · " + esc(L.formatDuration(r.duration_ms || 0)) +
        (r.archived ? ' · 📦' : "") +
        (state.transport === "recording" && r.id === state.currentId ? ' · <span style="color:var(--amber)">● REC</span>' : "") + "</div>" +
        (tags.length ? '<div class="tags">' + tags.map((t) => "<span>" + esc(t) + "</span>").join("") + "</div>" : "");
      b.addEventListener("click", () => selectRecording(r.id));
      notesList.appendChild(b);
    });
  }

  function renderChips() {
    tagChips.innerHTML = "";
    state.tags.forEach((t) => {
      var c = document.createElement("button");
      c.className = "chip" + (state.tag === t ? " on" : "");
      c.textContent = t;
      c.addEventListener("click", () => {
        state.tag = state.tag === t ? "" : t;
        refresh();
      });
      tagChips.appendChild(c);
    });
  }

  async function refresh() {
    var params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    if (state.tag) params.set("tag", state.tag);
    if (state.showArchived) params.set("archived", "1");
    var qs = params.toString();
    var data = await GET("/api/recordings" + (qs ? "?" + qs : ""));
    state.recordings = data.recordings || [];
    var tdata = await GET("/api/tags");
    state.tags = tdata.tags || [];
    // keep selection if it still exists
    if (state.currentId && !state.recordings.some((r) => r.id === state.currentId)) {
      state.currentId = null;
    }
    renderNotes();
    renderChips();
    if (state.currentId) fillDetail(); else detailPanel.hidden = true;
    btnPlay.disabled = state.transport !== "idle" || !state.currentId;
  }

  chipArchived.addEventListener("click", () => {
    state.showArchived = !state.showArchived;
    chipArchived.classList.toggle("on", state.showArchived);
    chipArchived.setAttribute("aria-pressed", state.showArchived ? "true" : "false");
    refresh();
  });

  var searchT = 0;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchT);
    searchT = setTimeout(() => { state.q = searchInput.value.trim(); refresh(); }, 250);
  });

  function selectRecording(id) {
    state.currentId = id;
    stopPlayback();
    loadCurrent();
    fillDetail();
    renderNotes();
  }

  /* ---------------- detail panel ---------------- */
  function fillDetail() {
    var rec = current();
    if (!rec) { detailPanel.hidden = true; return; }
    detailPanel.hidden = false;
    detailTitle.value = rec.title || "";
    detailMeta.textContent =
      fmtDate(rec.created_at).toUpperCase() + " · " + L.formatDuration(rec.duration_ms || 0) +
      " · " + Math.round((rec.size || 0) / 1024) + " KB";
    transcriptEdit.value = rec.transcript || "";
    notesEdit.value = rec.md_notes || "";
    renderTagRow(rec);
    renderSTT(rec);
    $("btnArchive").textContent = rec.archived ? "Unarchive" : "Archive";
    showTab(state.detailTab);
    loadTodos(rec.id); // keeps the To-dos badge fresh regardless of active tab
  }

  function renderTagRow(rec) {
    var tags = [];
    try { tags = JSON.parse(rec.tags || "[]"); } catch (e) { /* ignore */ }
    tagList.innerHTML = "";
    tags.forEach((t) => {
      var s = document.createElement("span");
      s.className = "tag";
      s.innerHTML = esc(t) + ' <button aria-label="remove tag">×</button>';
      s.querySelector("button").addEventListener("click", () => {
        var nt = tags.filter((x) => x !== t);
        PATCH("/api/recordings/" + rec.id, { tags: nt }).then(refresh);
      });
      tagList.appendChild(s);
    });
  }
  tagInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    var v = tagInput.value.trim().replace(/,/g, "");
    if (!v || !state.currentId) return;
    var rec = current();
    var tags = [];
    try { tags = JSON.parse(rec.tags || "[]"); } catch (err) { /* ignore */ }
    if (!tags.includes(v)) tags.push(v);
    tagInput.value = "";
    PATCH("/api/recordings/" + rec.id, { tags: tags }).then(refresh);
  });

  function showTab(name) {
    state.detailTab = name;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    $("tab-transcript").hidden = name !== "transcript";
    $("tab-notes").hidden = name !== "notes";
    $("tab-preview").hidden = name !== "preview";
    $("tab-todos").hidden = name !== "todos";
    if (name === "preview") notesPreview.innerHTML = L.renderMarkdown(notesEdit.value);
    if (name === "todos") loadTodos(state.currentId);
  }
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => showTab(b.dataset.tab))
  );
  notesEdit.addEventListener("input", () => {
    if (state.detailTab === "preview") notesPreview.innerHTML = L.renderMarkdown(notesEdit.value);
  });

  /* ---------------- to-dos (deterministic extraction from the transcript) ---------------- */
  async function loadTodos(id) {
    if (!id) { state.todos = []; renderTodos(); return; }
    try {
      var data = await GET("/api/recordings/" + id + "/todos");
      state.todos = data.todos || [];
    } catch (e) { state.todos = []; }
    renderTodos();
  }

  function renderTodos() {
    var rec = current();
    todoList.innerHTML = "";
    todoCount.textContent = state.todos.length ? String(state.todos.length) : "";
    todoCount.classList.toggle("has", state.todos.length > 0);
    if (!state.todos.length) {
      var d = document.createElement("div");
      d.className = "todo-empty";
      d.textContent = (rec && rec.transcript)
        ? "No to-dos found in this transcript. Hit “Extract to-dos” to scan it again."
        : "To-dos appear here after this note is transcribed.";
      todoList.appendChild(d);
      todoHint.textContent = "";
      return;
    }
    var open = state.todos.filter((t) => !t.done).length;
    todoHint.textContent = open ? open + " open" : "all done ✓";
    state.todos.forEach((t) => {
      var row = document.createElement("div");
      row.className = "todo" + (t.done ? " done" : "");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!t.done;
      cb.setAttribute("aria-label", "mark to-do done");
      cb.addEventListener("change", async () => {
        try {
          var data = await PATCH("/api/todos/" + t.id, { done: cb.checked ? 1 : 0 });
          t.done = data.todo.done;
        } catch (e) {
          cb.checked = !cb.checked;
          showNotice("<strong>Could not update to-do:</strong> " + esc(e.message));
          return;
        }
        renderTodos();
      });
      var span = document.createElement("span");
      span.className = "txt";
      span.textContent = t.text;
      span.addEventListener("click", () => cb.click());
      if (t.ascent_task_id) {
        var sent = document.createElement("span");
        sent.className = "sent-tag";
        sent.textContent = "in Ascent";
        sent.title = "sent to Ascent";
        row.appendChild(cb);
        row.appendChild(span);
        row.appendChild(sent);
      } else {
        row.appendChild(cb);
        row.appendChild(span);
      }
      var del = document.createElement("button");
      del.className = "todo-del";
      del.textContent = "×";
      del.setAttribute("aria-label", "remove to-do");
      del.addEventListener("click", async () => {
        try { await DEL("/api/todos/" + t.id); }
        catch (e) { showNotice("<strong>Could not remove to-do:</strong> " + esc(e.message)); return; }
        state.todos = state.todos.filter((x) => x.id !== t.id);
        renderTodos();
      });
      row.appendChild(del);
      todoList.appendChild(row);
    });
  }

  btnExtractTodos.addEventListener("click", async () => {
    var rec = current();
    if (!rec) return;
    btnExtractTodos.disabled = true;
    var old = btnExtractTodos.textContent;
    btnExtractTodos.textContent = "Extracting…";
    try {
      var data = await POST("/api/recordings/" + rec.id + "/todos/extract");
      state.todos = data.todos || [];
      renderTodos();
      if (data.added) todoHint.textContent = "added " + data.added + " new";
    } catch (e) {
      showNotice("<strong>Extract failed:</strong> " + esc(e.message));
    } finally {
      btnExtractTodos.disabled = false;
      btnExtractTodos.textContent = old;
    }
  });

  /* ---------------- send to-dos to Ascent (explicit, per click) ---------------- */
  btnSendAscent.addEventListener("click", async () => {
    var rec = current();
    if (!rec) return;
    btnSendAscent.disabled = true;
    var old = btnSendAscent.textContent;
    btnSendAscent.textContent = "Sending…";
    try {
      var data = await POST("/api/recordings/" + rec.id + "/todos/send-to-ascent");
      state.todos = data.todos || [];
      renderTodos();
      todoHint.textContent = data.sent
        ? "sent " + data.sent + " to Ascent ✓"
        : "nothing new to send";
    } catch (e) {
      showNotice("<strong>Send to Ascent failed:</strong> " + esc(e.message));
    } finally {
      btnSendAscent.disabled = false;
      btnSendAscent.textContent = old;
    }
  });

  detailTitle.addEventListener("change", saveDetail);
  $("btnSave").addEventListener("click", saveDetail);
  async function saveDetail() {
    var rec = current();
    if (!rec) return;
    try {
      var data = await PATCH("/api/recordings/" + rec.id, {
        title: detailTitle.value.trim() || rec.title,
        transcript: transcriptEdit.value,
        md_notes: notesEdit.value,
      });
      var i = state.recordings.findIndex((r) => r.id === rec.id);
      if (i >= 0) state.recordings[i] = data.recording;
      renderNotes();
      var btn = $("btnSave");
      btn.classList.add("saved-flash");
      var old = btn.textContent;
      btn.textContent = "Saved ✓";
      setTimeout(() => { btn.classList.remove("saved-flash"); btn.textContent = old; }, 1200);
    } catch (e) {
      showNotice("<strong>Save failed:</strong> " + esc(e.message));
    }
  }

  $("btnExport").addEventListener("click", () => {
    var rec = current();
    if (!rec) return;
    var md = "# " + (rec.title || "Voice note") + "\n\n" +
      "*" + fmtDate(rec.created_at) + " · " + L.formatDuration(rec.duration_ms || 0) + "*\n\n" +
      "## Transcript\n\n" + (transcriptEdit.value || rec.transcript || "_No transcript._") + "\n\n" +
      "## Notes\n\n" + (notesEdit.value || rec.md_notes || "_No notes._") + "\n";
    var blob = new Blob([md], { type: "text/markdown" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (rec.title || "voice-note").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() + ".md";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });

  /* ---------------- archive / unarchive ---------------- */
  $("btnArchive").addEventListener("click", async () => {
    var rec = current();
    if (!rec) return;
    var btn = $("btnArchive");
    btn.disabled = true;
    try {
      var data = await POST("/api/recordings/" + rec.id + (rec.archived ? "/unarchive" : "/archive"));
      var i = state.recordings.findIndex((r) => r.id === rec.id);
      if (i >= 0) state.recordings[i] = data.recording;
      await refresh(); // archived notes leave the list unless the Archived filter is on
    } catch (e) {
      showNotice("<strong>Archive failed:</strong> " + esc(e.message));
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------------- send to Abba (explicit, per click) ---------------- */
  $("btnSendAbba").addEventListener("click", async () => {
    var rec = current();
    if (!rec) return;
    var btn = $("btnSendAbba");
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = "Sending…";
    try {
      var data = await POST("/api/recordings/" + rec.id + "/send-to-abba");
      var i = state.recordings.findIndex((r) => r.id === rec.id);
      if (i >= 0) state.recordings[i] = data.recording;
      showNotice(data.already_sent
        ? "<strong>Already in Abba</strong> — this note was sent before."
        : "<strong>Sent to Abba</strong> — find it in your Abba notepad ✓");
    } catch (e) {
      showNotice("<strong>Send to Abba failed:</strong> " + esc(e.message));
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  $("btnDelete").addEventListener("click", async () => {
    var rec = current();
    if (!rec) return;
    if (!confirm('Delete "' + rec.title + '"? The audio file is removed too.')) return;
    await DEL("/api/recordings/" + rec.id);
    state.currentId = null;
    audioEl.removeAttribute("src");
    setDeckState("idle");
    resetReels();
    scrubTot.textContent = "00:00";
    await refresh();
  });

  /* ---------------- demo hook (screenshots) ---------------- */
  window.__desk = {
    state: state,
    setDeckState: setDeckState,
    selectRecording: selectRecording,
    refresh: refresh,
    /** Fake a live recording state without a mic (screenshot use only). */
    fakeRecording: function () {
      setDeckState("recording");
      recStart = Date.now() - 75400;
      tickClock(() => Date.now() - recStart);
      // synthetic meter motion
      cancelAnimationFrame(meterRAF);
      var t = 0;
      (function fake() {
        t += 0.18;
        var v = 0.45 + 0.4 * Math.abs(Math.sin(t) * Math.sin(t * 0.37));
        setMeter(meterL, Math.min(1, v));
        setMeter(meterR, Math.min(1, v * 0.9));
        if (state.transport === "recording") meterRAF = requestAnimationFrame(fake);
      })();
      interimText.textContent = "…and the quarterly numbers look strong across";
      statusLine.innerHTML = '<span class="amber">● REC</span> — capturing';
    },
    fakeStop: function () {
      cancelAnimationFrame(meterRAF);
      cancelAnimationFrame(clockRAF);
      interimText.textContent = "";
      setDeckState("idle");
      resetReels();
    },
  };

  /* ---------------- init ---------------- */
  // Status first: renderSTT needs serverSTT before refresh() auto-selects a note.
  (async function () {
    await checkServerSTT();
    try { await refresh(); }
    catch (e) { showNotice("<strong>Could not reach server:</strong> " + esc(e.message)); }
  })();
})();
