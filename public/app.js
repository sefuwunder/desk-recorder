/* desk-recorder client: transport, tape deck animation, real VU meters via
   WebAudio AnalyserNode, MediaRecorder capture, SpeechRecognition live
   transcription, notes list, markdown notes. Zero deps. */
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
    transport: "idle", // idle | recording | playing
    detailTab: "transcript",
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
  var tagChips = $("tagChips"), nowRec = $("nowRec");
  var detailPanel = $("detailPanel"), detailTitle = $("detailTitle"), detailMeta = $("detailMeta");
  var transcriptEdit = $("transcriptEdit"), notesEdit = $("notesEdit"), notesPreview = $("notesPreview");
  var tagList = $("tagList"), tagInput = $("tagInput");

  $("topDate").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  }).toUpperCase();

  /* ---------------- audio engine ---------------- */
  var audioEl = new Audio();
  audioEl.preload = "metadata";
  var actx = null, analyser = null, analyserData = null, mediaSrc = null;
  var meterRAF = 0, clockRAF = 0;
  var micStream = null, recorder = null, recChunks = [], recStart = 0;
  var recMime = "";
  var recog = null, recogFinal = "", recogWanted = false;

  function ensureCtx() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      actx = new AC();
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

    recMime = "audio/webm";
    var mr;
    try {
      var mime = "audio/webm;codecs=opus";
      if (window.MediaRecorder && !MediaRecorder.isTypeSupported(mime)) mime = "audio/webm";
      mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recMime = mr.mimeType || mime;
    } catch (e) {
      showNotice("<strong>Recording not supported</strong> in this browser.");
      cleanupMic();
      return;
    }
    recorder = mr;
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = onRecorderStop;
    try { recorder.start(250); } catch (e) { cleanupMic(); return; }

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
      showNotice("<strong>Live transcription unavailable:</strong> this needs Chrome or Edge. " +
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
  }

  function stopRecording() {
    if (state.transport !== "recording" || !recorder) return;
    stopRecognition();
    try { recorder.stop(); } catch (e) { onRecorderStop(); }
    cleanupMic();
  }

  async function onRecorderStop() {
    var blob = new Blob(recChunks, { type: recMime || "audio/webm" });
    var durationMs = Date.now() - recStart;
    recChunks = [];
    var interim = interimText.textContent;
    var finalText = (recogFinal + (interim ? " " + interim : "")).trim();
    interimText.textContent = "";

    setDeckState("idle");
    resetReels();
    renderNotes();

    if (!blob.size) {
      showNotice("<strong>Empty recording</strong> — nothing was captured.");
      return;
    }
    var title = "Voice note — " + new Date().toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    try {
      var fd = new FormData();
      fd.append("audio", blob, "note.webm");
      fd.append("title", title);
      fd.append("duration_ms", String(durationMs));
      var data = await api("/api/recordings", { method: "POST", body: fd });
      if (finalText) await POST("/api/transcript/" + data.recording.id, { transcript: finalText });
      await refresh();
      selectRecording(data.recording.id);
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
      b.className = "note-item" + (r.id === state.currentId ? " sel" : "");
      var tags = [];
      try { tags = JSON.parse(r.tags || "[]"); } catch (e) { /* ignore */ }
      b.innerHTML =
        '<div class="t">' + esc(r.title || "Untitled") + "</div>" +
        '<div class="m">' + esc(fmtDate(r.created_at)) + " · " + esc(L.formatDuration(r.duration_ms || 0)) +
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
    showTab(state.detailTab);
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
    if (name === "preview") notesPreview.innerHTML = L.renderMarkdown(notesEdit.value);
  }
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => showTab(b.dataset.tab))
  );
  notesEdit.addEventListener("input", () => {
    if (state.detailTab === "preview") notesPreview.innerHTML = L.renderMarkdown(notesEdit.value);
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
  refresh().catch((e) => showNotice("<strong>Could not reach server:</strong> " + esc(e.message)));
})();
