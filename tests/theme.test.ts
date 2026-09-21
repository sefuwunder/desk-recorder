// desk-recorder theme tests: resolveTheme pure mapping (stored value ->
// effective theme), loaded via stubbed-document eval of public/lib.js.
// DOM behavior (data-theme attribute, button state) is covered by the
// CDP browser review instead of heavy DOM scaffolding.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/lib.js", import.meta.url), "utf8");
const stubWindow = {};
const stubDocument = { createElement: () => { throw new Error("no DOM in lib"); } };
const stubModule = { exports: {} };
const L = new Function("window", "document", "module", src + "\nreturn DeskLib;")(
  stubWindow, stubDocument, stubModule
);

describe("resolveTheme", () => {
  test("stored night wins even if OS prefers light", () =>
    expect(L.resolveTheme("tokyo-night", true)).toBe("tokyo-night"));
  test("stored dawn wins even if OS prefers dark", () =>
    expect(L.resolveTheme("tokyo-dawn", false)).toBe("tokyo-dawn"));
  test("no stored + light OS -> dawn", () =>
    expect(L.resolveTheme(null, true)).toBe("tokyo-dawn"));
  test("no stored + dark OS -> night", () =>
    expect(L.resolveTheme(null, false)).toBe("tokyo-night"));
  test("undefined stored -> night on dark OS", () =>
    expect(L.resolveTheme(undefined, false)).toBe("tokyo-night"));
  test("empty string stored -> falls back to media", () =>
    expect(L.resolveTheme("", true)).toBe("tokyo-dawn"));
  test("garbage stored value -> falls back to media", () => {
    expect(L.resolveTheme("hotdog", true)).toBe("tokyo-dawn");
    expect(L.resolveTheme("hotdog", false)).toBe("tokyo-night");
  });
  test("THEMES lists exactly the two supported themes", () =>
    expect(L.THEMES).toEqual(["tokyo-night", "tokyo-dawn"]));
});
