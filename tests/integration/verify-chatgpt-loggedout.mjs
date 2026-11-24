// tests/integration/verify-chatgpt-loggedout.mjs — 実際の ChatGPT (ログインなし) で、
// アイコンの位置と、オンのときの背景色と、アイコンでのオン/オフを確かめる
// (docs/composer-toggle.md T-18)。ログインなしの画面は入力欄の段に隙間が無いので、
// アイコンは下の段ではなく入力欄の箱の右の外側に浮かせる (D-30)。
//
// ログインなしの https://chatgpt.com/ を、拡張機能を読み込んだブラウザで開く。
// 入力欄には何も書かず、何も送信しない。ログイン後の画面は作りが違うので、
// そちらはモックの E2E (e2e-composer-toggle.mjs) と利用者の目視で確かめる。
//
// 外部のサイトに依存するので、通常のテスト一式には入れない。リリース前に流す。
//
// 使い方: node tests/integration/verify-chatgpt-loggedout.mjs <unpacked 拡張機能ディレクトリ> [スクリーンショットの保存先ディレクトリ]
// 終了コード: 0 = 合格 / 1 = 失敗
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TINT = require("../../browser-extension/tint.js");

const [EXT_ARG, SHOT_DIR] = process.argv.slice(2);
if (!EXT_ARG) { console.error("usage: node tests/integration/verify-chatgpt-loggedout.mjs <unpacked-dir> [screenshot-dir]"); process.exit(2); }
const EXT = path.resolve(EXT_ARG);
const HOST = 'div[data-pii-guard="composer-toggle"]';
const COLOR = "#3b82f6";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-chatgpt-"));
let ctx;
let failed = false;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed = true; };

const state = (p) => p.evaluate((sel) => {
  const h = document.querySelector(sel);
  const sp = document.querySelector('span[data-pii-guard="dock"]');
  const add = document.querySelector('[data-composer-navigation-target="add-context"], button[data-composer-action]');
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const lay = h && h.dataset.layout ? JSON.parse(h.dataset.layout) : null;
  return {
    host: !!h, docked: h ? h.dataset.docked : null, enabled: h ? h.dataset.enabled : null,
    toggle: lay && lay.toggle, spacer: r(sp), add: r(add),
  };
}, HOST);

try {
  ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
    channel: "chromium", headless: true, viewport: { width: 1280, height: 800 }, locale: "ja-JP",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 25000 }));
  await sw.evaluate(async () => { for (let i = 0; i < 100; i++) { const s = await chrome.storage.local.get(["enabled"]); if (typeof s.enabled === "boolean") return; await new Promise((r) => setTimeout(r, 100)); } });
  await sw.evaluate(() => chrome.storage.local.set({ __pii_guard_e2e: true, enabled: true, chatTint: null }));
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => { if (String(e).includes("pii-guard") || String(e).includes("chrome-extension://")) errs.push(String(e)); });
  await p.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await p.waitForTimeout(10000);

  console.log("アイコンの位置:");
  // ログインなしの画面は、入力欄の段が列の幅を決め打ちした CSS Grid で、下の段に場所取りを
  // 入れる隙間が無い。入力欄の箱の右の外側に浮かせる (下の段への配置はログイン後の画面だけ)
  let s = await state(p);
  const box = await p.evaluate(() => {
    const ta = document.querySelector("textarea#mobile-composer-prompt");
    const f = ta && ta.closest("form");
    if (!f) return null;
    const b = f.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
  });
  check(s.host, "アイコンが出る");
  check(s.docked === "false" && !s.spacer, `下の段には何も入れず、浮かせる (docked=${s.docked})`);
  check(s.toggle && box && s.toggle[0] >= box[0] + box[2], `入力欄の箱に重ならず、その右の外側に出る (toggle=${JSON.stringify(s.toggle)} 箱=${JSON.stringify(box)})`);
  check(s.toggle && box && Math.abs((s.toggle[1] + s.toggle[3] / 2) - (box[1] + box[3] / 2)) <= 2, "縦は入力欄の箱の中央にそろう");
  if (SHOT_DIR && box) {
    await p.screenshot({ path: path.join(SHOT_DIR, "chatgpt-on.png"), clip: { x: box[0] - 20, y: Math.max(0, box[1] - 60), width: box[2] + 80, height: box[3] + 80 } });
  }

  console.log("オンのときの背景色:");
  // 背景を塗っている要素は製品が選ぶ (body/html が透明なら sample point を覆う大きな要素)。
  // 「選んだ色を混ぜた色」はその要素自身のもとの背景から計算する。main は透明なので、
  // main を読む検査は何も証明しない。
  const readBg = (h) => h.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      bg: getComputedStyle(el).backgroundColor,
      w: Math.round(r.width),
      h: Math.round(r.height),
      tagged: el.hasAttribute("data-pii-guard-tint"),
    };
  });
  await sw.evaluate((c) => chrome.storage.local.set({ chatTint: c }), COLOR);
  await p.waitForTimeout(1500);
  const tintEl = await p.evaluateHandle(() => document.querySelector("[data-pii-guard-tint]"));
  const on = await readBg(tintEl);
  check(!!on, "背景を塗っている要素に印が付いている");
  check(on && on.w >= 1280 * 0.4 && on.h >= 800 * 0.4, `印の要素がチャット部分を塗る大きさ (${on && on.w}x${on && on.h})`);
  if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, "chatgpt-tinted.png") });

  console.log("アイコンでオフにする:");
  await p.waitForTimeout(600);
  s = await state(p);
  await p.mouse.click(s.toggle[0] + s.toggle[2] / 2, s.toggle[1] + s.toggle[3] / 2);
  await p.waitForTimeout(1200);
  s = await state(p);
  check(s.enabled === "false" && (await sw.evaluate(() => chrome.storage.local.get("enabled").then((x) => x.enabled))) === false, "本物のクリックでオフになる");
  // 同じ要素をオフの状態で読む。印が外れたあとの背景が、この要素のもとの背景。
  const off = await readBg(tintEl);
  check(off && !off.tagged, "オフにすると印が外れる");
  const expected = off ? TINT.tintedBackground(COLOR, off.bg) : null;
  check(expected && on && on.bg === expected,
    `チャットの背景が選んだ色を混ぜた色になる (${off && off.bg} → ${on && on.bg}、期待 ${expected})`);
  if (SHOT_DIR && box) {
    await p.screenshot({ path: path.join(SHOT_DIR, "chatgpt-off.png"), clip: { x: box[0] - 20, y: Math.max(0, box[1] - 60), width: box[2] + 80, height: box[3] + 80 } });
  }
  check(errs.length === 0, `拡張機能による JS エラーなし${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);
} catch (e) {
  console.error("実行エラー:", e?.message || e);
  failed = true;
} finally {
  if (ctx) await ctx.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? "\n✗ FAILED" : "\n✓ PASSED");
process.exit(failed ? 1 : 0);
