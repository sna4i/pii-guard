// tint.js — マスキングがオンのときにチャットの背景に付ける色の計算。
// 設計は docs/composer-toggle.md の D-23〜D-26。
//
// content script (composer-toggle.js) と設定画面 (options.js) の両方から使う。
// DOM に触れない純粋な関数だけを置き、Node でもテストできるようにする
// (tests/engine/tint.test.mjs)。
"use strict";

(function attach(root) {
  // 設定画面のパレット。名前は利用者に見せる
  const PRESETS = [
    { id: "blue", name: "青", hex: "#3b82f6" },
    { id: "cyan", name: "水色", hex: "#06b6d4" },
    { id: "green", name: "緑", hex: "#22c55e" },
    { id: "yellow", name: "黄", hex: "#eab308" },
    { id: "orange", name: "橙", hex: "#f97316" },
    { id: "red", name: "赤", hex: "#ef4444" },
    { id: "pink", name: "桃", hex: "#ec4899" },
    { id: "purple", name: "紫", hex: "#8b5cf6" },
  ];

  // 選んだ色そのものではなく、元の背景に混ぜる割合 (D-25)。暗い背景では
  // 同じ割合だと色が見えにくいので多めにする。文字の色はサイトのまま読める
  const LIGHT_RATIO = 0.15;
  const DARK_RATIO = 0.25;

  // "#rrggbb" か "#rgb" を小文字の "#rrggbb" にする。それ以外は null (「なし」)。
  // 保存値をそのまま CSS に書くので、ここで形を厳しく限る
  function normalizeTint(value) {
    if (typeof value !== "string") return null;
    const s = value.trim().toLowerCase();
    let m = /^#([0-9a-f]{6})$/.exec(s);
    if (m) return "#" + m[1];
    m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
    if (m) return "#" + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
    return null;
  }

  // "#rrggbb"、"rgb(r, g, b)"、"rgba(r, g, b, a)"、"rgb(r g b / a)" を
  // { r, g, b, a } にする。読めなければ null。oklch() などは呼び出し側
  // (ブラウザ) で sRGB に直してから渡す
  function parseColor(value) {
    if (typeof value !== "string") return null;
    const s = value.trim().toLowerCase();
    const hex = normalizeTint(s);
    if (hex) {
      return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a: 1 };
    }
    const m = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(s);
    if (!m) return null;
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if (![r, g, b].every((x) => Number.isFinite(x) && x >= 0 && x <= 255)) return null;
    let a = 1;
    if (m[4] !== undefined) {
      a = Number(m[4]) / (m[5] === "%" ? 100 : 1);
      if (!Number.isFinite(a) || a < 0 || a > 1) return null;
    }
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
  }

  function luminance(c) {
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  }

  // 丸めの差は同じ色とみなす
  function sameColor(x, y, tolerance) {
    if (!x || !y) return false;
    const t = tolerance == null ? 2 : tolerance;
    return Math.abs(x.r - y.r) <= t && Math.abs(x.g - y.g) <= t && Math.abs(x.b - y.b) <= t;
  }

  // 背景に付ける色 ("rgb(r, g, b)")。色が無効か、元の背景が読めないか不透明で
  // なければ null (色を付けない)
  function tintedBackground(tint, base) {
    const t = parseColor(normalizeTint(tint) || "");
    const b = typeof base === "string" ? parseColor(base) : base;
    if (!t || !b || !(b.a >= 0.99)) return null;
    const ratio = luminance(b) < 0.5 ? DARK_RATIO : LIGHT_RATIO;
    const mix = (from, to) => Math.round(from + (to - from) * ratio);
    return `rgb(${mix(b.r, t.r)}, ${mix(b.g, t.g)}, ${mix(b.b, t.b)})`;
  }

  // 下から上へ並べた色 (layers[0] がいちばん下) を、不透明な土台 base の上に重ねた色。
  // ChatGPT の保護入力欄の面の色を、半透明の箱とその下の色から求めるのに使う (docs/release-1.7.1.md の D-SC-01)
  function flatten(layers, base) {
    let r = base.r, g = base.g, b = base.b;
    for (const c of layers || []) {
      if (!c) continue;
      const a = Math.max(0, Math.min(1, typeof c.a === "number" ? c.a : 1));
      r = c.r * a + r * (1 - a);
      g = c.g * a + g * (1 - a);
      b = c.b * a + b * (1 - a);
    }
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: 1 };
  }

  const api = { PRESETS, LIGHT_RATIO, DARK_RATIO, normalizeTint, parseColor, luminance, sameColor, tintedBackground, flatten };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PiiGuardTint = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
