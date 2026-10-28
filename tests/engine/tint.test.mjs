// tests/engine/tint.test.mjs — マスキングがオンのときにチャットの背景に付ける色の計算
//
// 設計は docs/composer-toggle.md の D-23〜D-26、T-12。
// Run: node --test tests/engine/tint.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../../browser-extension/tint.js");

test("T-12 normalizeTint accepts #rrggbb and #rgb, and nothing else", () => {
  assert.equal(T.normalizeTint("#3B82F6"), "#3b82f6");
  assert.equal(T.normalizeTint("  #FFFFFF "), "#ffffff");
  assert.equal(T.normalizeTint("#abc"), "#aabbcc");
  for (const bad of ["red", "#12345", "#1234567", "3b82f6", "", null, undefined, 42, "#3b82f6; color: red", "url(x)"]) {
    assert.equal(T.normalizeTint(bad), null, `${JSON.stringify(bad)} は「なし」として扱う`);
  }
});

test("T-12h flatten composites translucent layers over an opaque base (docs/release-1.7.1.md の D-SC-01)", () => {
  const black = { r: 0, g: 0, b: 0, a: 1 };
  assert.deepEqual(T.flatten([], black), black, "重ねるものが無ければ土台の色");
  assert.deepEqual(T.flatten([{ r: 48, g: 48, b: 48, a: 1 }], black), { r: 48, g: 48, b: 48, a: 1 }, "不透明な色はそのまま");
  assert.deepEqual(T.flatten([{ r: 255, g: 255, b: 255, a: 0.05 }], black), { r: 13, g: 13, b: 13, a: 1 }, "5% の白を黒に重ねる");
  // 下から上の順: 黒の上に半透明の灰、その上に 50% の白
  assert.deepEqual(T.flatten([{ r: 100, g: 100, b: 100, a: 0.5 }, { r: 255, g: 255, b: 255, a: 0.5 }], black), { r: 153, g: 153, b: 153, a: 1 });
  assert.deepEqual(T.flatten([null, { r: 10, g: 20, b: 30, a: 0 }], { r: 1, g: 2, b: 3, a: 1 }), { r: 1, g: 2, b: 3, a: 1 }, "透明と空は無視する");
});

test("T-12b parseColor reads the formats getComputedStyle returns", () => {
  assert.deepEqual(T.parseColor("rgb(252, 252, 252)"), { r: 252, g: 252, b: 252, a: 1 });
  assert.deepEqual(T.parseColor("rgba(0, 0, 0, 0)"), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(T.parseColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(T.parseColor("rgb(1 2 3 / 50%)"), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepEqual(T.parseColor("#000000"), { r: 0, g: 0, b: 0, a: 1 });
  assert.equal(T.parseColor("oklch(0.9 0 0)"), null, "rgb 以外はブラウザ側で変換する");
  assert.equal(T.parseColor("rgb(300, 0, 0)"), null);
  assert.equal(T.parseColor(""), null);
});

test("T-12c the tint is mixed into a light background at 15%", () => {
  assert.equal(T.tintedBackground("#3b82f6", "rgb(252, 252, 252)"), "rgb(223, 234, 251)");
  assert.equal(T.tintedBackground("#22c55e", "rgb(252, 252, 252)"), "rgb(219, 244, 228)");
});

test("T-12d the tint is mixed into a dark background at 25%", () => {
  assert.equal(T.tintedBackground("#3b82f6", "rgb(0, 0, 0)"), "rgb(15, 33, 62)");
  assert.equal(T.tintedBackground("#3b82f6", { r: 33, g: 33, b: 33, a: 1 }), "rgb(40, 57, 86)");
});

test("T-12e no tint for an invalid colour or a background that is not opaque", () => {
  assert.equal(T.tintedBackground(null, "rgb(252, 252, 252)"), null);
  assert.equal(T.tintedBackground("blue", "rgb(252, 252, 252)"), null);
  assert.equal(T.tintedBackground("#3b82f6", "rgba(0, 0, 0, 0)"), null);
  assert.equal(T.tintedBackground("#3b82f6", "not a colour"), null);
});

test("T-12f sameColor tolerates rounding but not a different colour", () => {
  assert.equal(T.sameColor({ r: 252, g: 252, b: 252, a: 1 }, { r: 251, g: 253, b: 252, a: 1 }), true);
  assert.equal(T.sameColor({ r: 252, g: 252, b: 252, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }), false);
  assert.equal(T.sameColor(null, { r: 0, g: 0, b: 0, a: 1 }), false);
});

test("T-12g the palette has eight distinct valid colours with Japanese names", () => {
  assert.equal(T.PRESETS.length, 8);
  assert.equal(new Set(T.PRESETS.map((p) => p.hex)).size, 8);
  for (const p of T.PRESETS) {
    assert.equal(T.normalizeTint(p.hex), p.hex);
    assert.match(p.name, /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u);
  }
});
