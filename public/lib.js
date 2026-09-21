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

  var DeskLib = { formatTimecode: formatTimecode, formatDuration: formatDuration, renderMarkdown: renderMarkdown, escapeHtml: escapeHtml };
  if (typeof window !== "undefined") window.DeskLib = DeskLib;
  if (typeof globalThis !== "undefined") globalThis.DeskLib = DeskLib;
  if (typeof module !== "undefined" && module.exports) module.exports = DeskLib;
})();
