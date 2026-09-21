// desk-recorder lib tests: timecode formatter + markdown renderer,
// loaded via stubbed-document eval of public/lib.js (no real DOM needed).
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/lib.js", import.meta.url), "utf8");
// lib.js touches no DOM; eval it with stubbed window/document/module anyway.
const stubWindow = {};
const stubDocument = { createElement: () => { throw new Error("no DOM in lib"); } };
const stubModule = { exports: {} };
const L = new Function("window", "document", "module", src + "\nreturn DeskLib;")(
  stubWindow, stubDocument, stubModule
);

describe("formatTimecode", () => {
  test("zero", () => expect(L.formatTimecode(0)).toBe("00:00:00"));
  test("75.4s -> 01:15:40", () => expect(L.formatTimecode(75400)).toBe("01:15:40"));
  test("61s -> 01:01:00", () => expect(L.formatTimecode(61000)).toBe("01:01:00"));
  test("pads minutes", () => expect(L.formatTimecode(600000)).toBe("10:00:00"));
  test("negative clamps", () => expect(L.formatTimecode(-500)).toBe("00:00:00"));
  test("non-numeric -> zero", () => expect(L.formatTimecode("junk")).toBe("00:00:00"));
});

describe("formatDuration", () => {
  test("compact m:ss", () => {
    expect(L.formatDuration(0)).toBe("0:00");
    expect(L.formatDuration(75400)).toBe("1:15");
    expect(L.formatDuration(60000)).toBe("1:00");
  });
});

describe("renderMarkdown", () => {
  test("headings", () => {
    expect(L.renderMarkdown("# Title")).toContain("<h1>Title</h1>");
    expect(L.renderMarkdown("### Sub")).toContain("<h3>Sub</h3>");
  });
  test("bold / italic / code / link", () => {
    expect(L.renderMarkdown("a **bold** word")).toContain("<strong>bold</strong>");
    expect(L.renderMarkdown("a *fine* word")).toContain("<em>fine</em>");
    expect(L.renderMarkdown("run `x()` now")).toContain("<code>x()</code>");
    expect(L.renderMarkdown("[hi](https://example.com)")).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener">hi</a>'
    );
  });
  test("lists", () => {
    const out = L.renderMarkdown("- one\n- two\n\n1. first\n2. second");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<ol>");
    expect(out).toContain("<li>first</li>");
  });
  test("fenced code + quote + hr", () => {
    const out = L.renderMarkdown("```\nlet x = 1;\n```\n> quoted\n\n---");
    expect(out).toContain("<pre><code>let x = 1;</code></pre>");
    expect(out).toContain("<blockquote>quoted</blockquote>");
    expect(out).toContain("<hr>");
  });
  test("paragraphs", () => {
    expect(L.renderMarkdown("hello\n\nworld")).toBe("<p>hello</p>\n<p>world</p>");
  });
  test("escapes HTML (XSS)", () => {
    const out = L.renderMarkdown('<script>alert(1)</script> **bold**');
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("<strong>bold</strong>");
  });
  test("code span content not parsed", () => {
    expect(L.renderMarkdown("`**x**`")).toContain("<code>**x**</code>");
  });
  test("empty input", () => expect(L.renderMarkdown("")).toBe(""));
});
