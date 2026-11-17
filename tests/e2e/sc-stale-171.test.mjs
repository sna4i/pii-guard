// tests/e2e/sc-stale-171.test.mjs — 拡張機能が入れ替わったあと、開いたままのタブで送れない (docs/release-1.7.1.md の P-SC-14、T-SC-23)
//
// 拡張機能を読み込み直す・更新する・オフにすると、開いたままのタブの content script は連絡 (chrome.runtime) を失う。
// 入力欄の上の箱は「読み込み直して」と知らせ、送信は止めたまま (fail-closed)。アイコンは黄色で、押すと知らせる。
// 拡張機能の読み込み直しは一時プロファイルの中だけで行う (利用者のブラウザには触れない)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, sleep } from "../fixtures/harness.mjs";

const PILL_HOST = 'div[data-pii-guard="composer-toggle"]';

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

const overlay = (page) => page.evaluate(() => {
  const host = document.querySelector("[data-pii-guard-secure]");
  if (!host) return null;
  const r = host.getBoundingClientRect();
  return {
    shown: getComputedStyle(host).display !== "none" && r.width > 0 && r.height > 0,
    iframe: !!host.querySelector("iframe"),
    stale: host.getAttribute("data-sc-stale"),
    button: host.dataset.staleButton ? JSON.parse(host.dataset.staleButton) : null,
    rect: { left: r.left, top: r.top },
  };
});
const pill = (page) => page.evaluate((sel) => {
  const e = document.querySelector(sel);
  return e ? { tone: e.dataset.tone, notice: e.dataset.notice, layout: e.dataset.layout ? JSON.parse(e.dataset.layout) : null } : null;
}, PILL_HOST);

test("T-SC-23 拡張機能が入れ替わったら、入力欄の上で読み込み直しを知らせ、送信は止めたままにする", async () => {
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await sleep(500);
  h.server.clear();
  await h.type(page, frame, "入れ替わる前の送信です");
  await frame.locator("textarea").press("Enter");
  await sleep(1500);
  assert.equal(h.server.byKind("conversation").length, 1, "前提: 入れ替わる前は送れる");

  await h.ext.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); return true; }).catch(() => {});
  let o = null;
  for (let i = 0; i < 30; i++) { await sleep(100); o = await overlay(page); if (o && o.stale === "1") break; }
  assert.ok(o && o.shown, `入力欄の上の箱が無い: ${JSON.stringify(o)}`);
  assert.equal(o.stale, "1", `知らせに替わっていない: ${JSON.stringify(o)}`);
  assert.equal(o.iframe, false, "古い保護入力欄 (iframe) が残っている");
  assert.ok(o.button && o.button[2] > 0, "読み込み直すボタンが無い");

  // ChatGPT の入力欄にフォーカスを当てても、フォーカスは知らせ (読み込み直すボタン) に移り、文字は入らない
  await page.evaluate(() => document.querySelector("#prompt-textarea").focus());
  const focusInNotice = await page.evaluate(() => !!(document.activeElement && document.activeElement.closest("[data-pii-guard-secure]")));
  assert.ok(focusInNotice, "フォーカスが ChatGPT の入力欄に残った");
  // ChatGPT の入力欄に文があって Enter が来ても送られない (保護されないまま送らない)
  h.server.clear();
  await page.evaluate(() => {
    const ed = document.querySelector("#prompt-textarea");
    ed.innerHTML = "<p>保護されないまま送らない</p>";
    ed.dispatchEvent(new InputEvent("input", { bubbles: true }));
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
  });
  await sleep(1200);
  assert.equal(h.server.byKind("conversation").length, 0, "連絡が切れたあと、保護されないまま送られた");

  // アイコンは黄色。押すと読み込み直すよう知らせる
  let p = null;
  for (let i = 0; i < 30; i++) { p = await pill(page); if (p && p.tone === "warning") break; await sleep(100); }
  assert.equal(p && p.tone, "warning", `アイコンが黄色になっていない: ${JSON.stringify(p)}`);
  const t = p.layout && p.layout.toggle;
  assert.ok(t, "アイコンの位置が分からない");
  await sleep(600); // 動いた直後のクリックは受け付けない (D-29)
  await page.mouse.click(t[0] + t[2] / 2, t[1] + t[3] / 2);
  await sleep(400);
  p = await pill(page);
  assert.equal(p.notice, "stale", `アイコンを押しても知らせが出ない: ${JSON.stringify(p)}`);

  // 「読み込み直す」を押すと、ページが読み込み直される
  await page.evaluate(() => { window.__beforeReload = 1; });
  const b = o.button;
  const loaded = page.waitForEvent("load", { timeout: 8000 });
  await page.mouse.click(o.rect.left + b[0] + b[2] / 2, o.rect.top + b[1] + b[3] / 2);
  await loaded;
  assert.equal(await page.evaluate(() => window.__beforeReload), undefined, "読み込み直されていない");
  await page.close();
});
