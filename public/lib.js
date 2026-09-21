/* desk-recorder shared lib: timecode formatter + zero-dep markdown renderer.
   No DOM dependencies; loaded via <script> and exposed as window.DeskLib.
   Tests eval this file with a stubbed document. */
(function () {
  "use strict";

  /** Format milliseconds as MM:SS:CS (centiseconds), like the deck timecode. */
  function formatTimecode(ms) {
    ms = Math.max(0, Math.floor(Number(ms) || 0));
    var cs = Math.floor(ms / 10) % 100;
    var s = Math.floor(ms / 1000) % 60;
    var m = Math.floor(ms / 60000);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(m) + ":" + p(s) + ":" + p(cs);
  }

  /** Format milliseconds as a compact human duration, e.g. 1:04 or 12:03. */
  function formatDuration(ms) {
    ms = Math.max(0, Math.floor(Number(ms) || 0));
    var s = Math.floor(ms / 1000) % 60;
    var m = Math.floor(ms / 60000);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Inline markdown: `code`, **bold**, *italic*, [text](url). Input must be HTML-escaped first. */
  function inlineMd(escaped) {
    var out = escaped;
    // code spans first so their contents are not parsed further
    var codes = [];
    out = out.replace(/`([^`]+)`/g, function (_, c) {
      codes.push(c);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    out = out
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    out = out.replace(/\u0000(\d+)\u0000/g, function (_, i) {
      return "<code>" + codes[Number(i)] + "</code>";
    });
    return out;
  }

  /** Block-level zero-dep markdown: headings, lists, paragraphs, fenced code, quotes, hr. */
  function renderMarkdown(src) {
    var lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    var html = [];
    var inList = false;
    var listTag = "";
    var inCode = false;
    var codeBuf = [];
    var para = [];

    function closePara() {
      if (para.length) {
        html.push("<p>" + inlineMd(escapeHtml(para.join(" "))) + "</p>");
        para = [];
      }
    }
    function closeList() {
      if (inList) { html.push("</" + listTag + ">"); inList = false; listTag = ""; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^```/.test(line)) {
        if (inCode) {
          html.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
          codeBuf = [];
          inCode = false;
        } else {
          closePara(); closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      var h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        closePara(); closeList();
        html.push("<h" + h[1].length + ">" + inlineMd(escapeHtml(h[2])) + "</h" + h[1].length + ">");
        continue;
      }
      if (/^\s*---\s*$/.test(line)) { closePara(); closeList(); html.push("<hr>"); continue; }
      var q = line.match(/^\s*>\s?(.*)$/);
      if (q) {
        closePara(); closeList();
        html.push("<blockquote>" + inlineMd(escapeHtml(q[1])) + "</blockquote>");
        continue;
      }
      var ul = line.match(/^\s*[-*]\s+(.*)$/);
      var ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ul || ol) {
        closePara();
        var tag = ul ? "ul" : "ol";
        var item = ul ? ul[1] : ol[1];
        if (!inList || listTag !== tag) { closeList(); html.push("<" + tag + ">"); inList = true; listTag = tag; }
        html.push("<li>" + inlineMd(escapeHtml(item)) + "</li>");
        continue;
      }
      if (/^\s*$/.test(line)) { closePara(); closeList(); continue; }
      closeList();
      para.push(line.trim());
    }
    closePara(); closeList();
    if (inCode) html.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
    return html.join("\n");
  }

  /** Downsample a Float32 mono buffer from sourceRate to 16kHz (linear interpolation).
      whisper.cpp wants 16kHz mono. Returns a new Float32Array. */
  function downsampleTo16k(input, sourceRate) {
    var TARGET = 16000;
    if (!input || !input.length) return new Float32Array(0);
    sourceRate = Math.max(1, Math.floor(Number(sourceRate) || 48000));
    if (sourceRate === TARGET) return Float32Array.from(input);
    var ratio = sourceRate / TARGET;
    var outLen = Math.floor(input.length / ratio);
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var i1 = Math.min(i0 + 1, input.length - 1);
      var frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  /** Encode a Float32 mono 16kHz buffer as 16-bit PCM WAV. Returns Uint8Array. */
  function encodeWavPcm16(mono16k) {
    var n = mono16k ? mono16k.length : 0;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    function wstr(off, s) {
      for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    }
    wstr(0, "RIFF");
    v.setUint32(4, 36 + n * 2, true);
    wstr(8, "WAVE");
    wstr(12, "fmt ");
    v.setUint32(16, 16, true);   // fmt chunk size
    v.setUint16(20, 1, true);    // PCM
    v.setUint16(22, 1, true);    // mono
    v.setUint32(24, 16000, true);// sample rate
    v.setUint32(28, 32000, true);// byte rate
    v.setUint16(32, 2, true);    // block align
    v.setUint16(34, 16, true);   // bits per sample
    wstr(36, "data");
    v.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, mono16k[i]));
      v.setInt16(44 + i * 2, Math.round(s * 32767), true);
    }
    return new Uint8Array(buf);
  }

  /** Color themes. Stored values are exactly "tokyo-night" / "tokyo-dawn". */
  var THEMES = ["tokyo-night", "tokyo-dawn"];

  /** Resolve the effective theme: a valid stored value wins; otherwise the
      OS color-scheme preference decides (light -> dawn, else night). */
  function resolveTheme(stored, prefersLight) {
    if (stored === "tokyo-night" || stored === "tokyo-dawn") return stored;
    return prefersLight ? "tokyo-dawn" : "tokyo-night";
  }

  var DeskLib = { formatTimecode: formatTimecode, formatDuration: formatDuration, renderMarkdown: renderMarkdown, escapeHtml: escapeHtml, downsampleTo16k: downsampleTo16k, encodeWavPcm16: encodeWavPcm16, resolveTheme: resolveTheme, THEMES: THEMES };
  if (typeof window !== "undefined") window.DeskLib = DeskLib;
  if (typeof globalThis !== "undefined") globalThis.DeskLib = DeskLib;
  if (typeof module !== "undefined" && module.exports) module.exports = DeskLib;
})();
