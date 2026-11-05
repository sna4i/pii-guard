// tests/e2e/sc-cover-171.test.mjs — ChatGPT の画面の上に重なる不具合と、フォーカスの戻し方
// (docs/release-1.7.1.md の「ChatGPT の画面の上に重なる不具合と、フォーカスの戻し方」T-SC-27〜28b)
//
// モックの検索の画面: ボタンで開き、入力欄の行に重なる位置に出る普通の表示 (z-index 50)。検索の欄にフォーカスし、
// 画面の外にフォーカスが移ったら検索の欄に戻す (Radix の閉じ込め)。Escape で閉じ、開いたボタンにフォーカスを戻す。
//
// T-SC-27  検索の画面を開くと、保護入力欄の箱が見えなくなり、入力欄の真ん中のいちばん上は検索の画面になる
// T-SC-27b 保護入力欄があった位置の候補をクリックすると、その候補が選ばれる
// T-SC-27c 検索の欄で変換すると、確定した文が検索の欄に入り、フォーカスが外れない
// T-SC-27d 閉じると保護入力欄が元の位置に戻り、打った文は保護入力欄に入る
// T-SC-28  ページが ChatGPT の入力欄にフォーカスを移し、同じ処理の中で文字を入れても、ChatGPT の入力欄に入らない
// T-SC-28b Service Worker を止めた直後 (連絡路をつなぎ直している間) でも同じ
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, sleep } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

async function openChat() {
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await sleep(500);
  return { page, frame };
}
// 入力欄の真ん中 (1 行目の高さの中ほど) と、そこでいちばん上にある要素
const probe = (page) => page.evaluate(() => {
  const host = document.querySelector("[data-pii-guard-secure]");
  const ed = document.querySelector("#prompt-textarea").getBoundingClientRect();
  const x = ed.left + ed.width / 2;
  const y = ed.top + Math.min(ed.height / 2, 18);
  const top = document.elementFromPoint(x, y);
  const hr = host.getBoundingClientRect();
  return {
    x, y, visibility: getComputedStyle(host).visibility,
    host: [hr.left, hr.top, hr.width, hr.height].map(Math.round), editor: [ed.left, ed.top, ed.width, ed.height].map(Math.round),
    topIsDialog: !!(top && top.closest('[data-testid="search-dialog"]')), topIsHost: !!(top && top.closest("[data-pii-guard-secure]")),
    active: document.activeElement ? document.activeElement.getAttribute("data-testid") || document.activeElement.tagName : null,
    nativeText: document.querySelector("#prompt-textarea").textContent,
  };
});
const events = (page) => page.evaluate(() => window.__mock.events.map((e) => ({ type: e.type, index: e.index })));
const draftOf = (frame) => frame.evaluate(() => document.getElementById("editor").value);
async function openSearch(page) {
  await page.click('[data-testid="search-button"]');
  await page.waitForSelector('[data-testid="search-dialog"]');
  await sleep(500);
}
async function stopServiceWorker() {
  const cdp = await h.ctx.newCDPSession(h.ext);
  try { await cdp.send("ServiceWorker.enable"); await cdp.send("ServiceWorker.stopAllWorkers"); }
  finally { await cdp.detach().catch(() => {}); }
}

test("T-SC-27 検索の画面を開くと、保護入力欄の箱が見えなくなり、入力欄の真ん中のいちばん上は検索の画面になる", async () => {
  const { page } = await openChat();
  const before0 = await probe(page);
  await openSearch(page);
  const p = await probe(page);
  await page.close();
  assert.equal(before0.visibility, "visible", "前提: 開く前は保護入力欄が見えている");
  assert.equal(p.visibility, "hidden", `検索の画面の上に保護入力欄が見えている: ${JSON.stringify(p)}`);
  assert.ok(p.topIsDialog && !p.topIsHost, `入力欄の真ん中のいちばん上が検索の画面でない: ${JSON.stringify(p)}`);
});

test("T-SC-27b 保護入力欄があった位置の候補をクリックすると、その候補が選ばれる", async () => {
  const { page, frame } = await openChat();
  await openSearch(page);
  const p = await probe(page);
  const index = await page.evaluate(({ x, y }) => {
    const it = document.elementsFromPoint(x, y).find((e) => e.classList && e.classList.contains("search-item"));
    return it ? Number(it.dataset.index) : null;
  }, p);
  await page.mouse.click(p.x, p.y);
  await sleep(500);
  const ev = await events(page);
  const sc = await frame.evaluate(() => document.hasFocus());
  await page.close();
  assert.notEqual(index, null, "前提: 入力欄の真ん中の位置に検索の候補がある");
  assert.ok(ev.some((e) => e.type === "search-item" && e.index === index), `候補が選ばれない (クリックを保護入力欄が受けた): ${JSON.stringify(ev.slice(-5))}`);
  assert.equal(sc, false, "保護入力欄にフォーカスが移った");
});

test("T-SC-27c 検索の欄で変換すると、確定した文が検索の欄に入り、フォーカスが外れない", async () => {
  const { page, frame } = await openChat();
  await openSearch(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.imeSetComposition", { text: "けんさく", selectionStart: 4, selectionEnd: 4 });
    await sleep(600);
    await cdp.send("Input.insertText", { text: "検索" });
    await sleep(300);
  } finally { await cdp.detach().catch(() => {}); }
  const value = await page.evaluate(() => document.querySelector('[data-testid="search-input"]').value);
  const p = await probe(page);
  const draft = await draftOf(frame);
  await page.close();
  assert.equal(value, "検索", `確定した文が検索の欄に入っていない: ${JSON.stringify(value)}`);
  assert.equal(p.active, "search-input", `検索の欄からフォーカスが外れた: ${p.active}`);
  assert.equal(draft, "", "検索の文が保護入力欄に入った");
});

test("T-SC-27d 閉じると保護入力欄が元の位置に戻り、打った文は保護入力欄に入る", async () => {
  const { page, frame } = await openChat();
  await openSearch(page);
  await page.keyboard.press("Escape");
  await sleep(500);
  const p = await probe(page);
  await h.type(page, frame, "あいう");
  await sleep(300);
  const draft = await draftOf(frame);
  const after0 = await probe(page);
  await page.close();
  assert.equal(p.visibility, "visible", `閉じても保護入力欄が戻らない: ${JSON.stringify(p)}`);
  assert.ok(Math.abs(p.host[1] - p.editor[1]) <= 2 && Math.abs(p.host[0] - p.editor[0]) <= 2, `元の位置に戻らない: ${JSON.stringify(p)}`);
  assert.equal(draft, "あいう", `打った文が保護入力欄に入らない: ${JSON.stringify(draft)}`);
  assert.equal(after0.nativeText.trim(), "", "ChatGPT の入力欄に文字が入った");
});

// ページのスクリプトが ChatGPT の入力欄にフォーカスを移した直後 (同じ処理の中) のフォーカスの場所と、
// そのすぐあとのキー入力 (CDP の Input.insertText はフォーカスのある所に入る) の行き先
async function focusNativeThenType(page, frame, text) {
  const activeRightAfter = await page.evaluate(() => {
    document.querySelector("#prompt-textarea").focus();
    return document.activeElement ? document.activeElement.tagName : null;
  });
  const cdp = await page.context().newCDPSession(page);
  try { await cdp.send("Input.insertText", { text }); } finally { await cdp.detach().catch(() => {}); }
  await sleep(300);
  const native = await page.evaluate(() => document.querySelector("#prompt-textarea").textContent);
  return { activeRightAfter, native, draft: await draftOf(frame) };
}

test("T-SC-28 ページが ChatGPT の入力欄にフォーカスを移しても、その場で保護入力欄に戻り、続けて打った文字は保護入力欄に入る", async () => {
  const { page, frame } = await openChat();
  const r = await focusNativeThenType(page, frame, "ひみつ");
  await page.close();
  assert.equal(r.activeRightAfter, "IFRAME", `フォーカスを移した直後に、保護入力欄に戻っていない (隙がある): ${JSON.stringify(r)}`);
  assert.equal(r.native.trim(), "", `ChatGPT の入力欄に文字が入った: ${JSON.stringify(r)}`);
  assert.equal(r.draft, "ひみつ", `打った文字が保護入力欄に入らない: ${JSON.stringify(r)}`);
});

test("T-SC-28c 送ったあと続けて打った文字は、保護入力欄に入る (送るために ChatGPT の入力欄に移したフォーカスが残らない)", async () => {
  h.server.clear();
  const { page, frame } = await openChat();
  await h.type(page, frame, "一回目の文です");
  await frame.locator("textarea").press("Enter");
  await sleep(2500);
  assert.equal(h.server.byKind("conversation").length, 1, "前提: 送れた");
  const active = await page.evaluate(() => (document.activeElement ? document.activeElement.tagName : null));
  const cdp = await page.context().newCDPSession(page);
  try { await cdp.send("Input.insertText", { text: "つづき" }); } finally { await cdp.detach().catch(() => {}); }
  await sleep(300);
  const native = await page.evaluate(() => document.querySelector("#prompt-textarea").textContent);
  const draft = await draftOf(frame);
  await page.close();
  assert.equal(active, "IFRAME", `送ったあと、フォーカスが保護入力欄に無い: ${active}`);
  assert.equal(native.trim(), "", `送ったあと打った文字が ChatGPT の入力欄に入った: ${JSON.stringify(native)}`);
  assert.equal(draft, "つづき", `送ったあと打った文字が保護入力欄に入らない: ${JSON.stringify(draft)}`);
});

test("T-SC-29 新しい会話を送って ChatGPT が入力欄を作り直し、すぐフォーカスしても、続けて打った文字は保護入力欄に入る", async () => {
  h.server.clear();
  const page = await h.openChat("/?navOnSend=1");
  const frame = await h.waitSecureReady(page, 10000);
  await sleep(500);
  await h.type(page, frame, "新しい会話の一回目です");
  await frame.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__mock.events.some((e) => e.type === "navigated-on-send"), null, { timeout: 8000 });
  const cdp = await page.context().newCDPSession(page);
  let r;
  try {
    await cdp.send("Input.insertText", { text: "にかいめ" }); // 作り直しの直後に、クリックせずに打つ
    await sleep(500);
    const a = { native: await page.evaluate(() => document.querySelector("#prompt-textarea").textContent), draft: await draftOf(frame) };
    await frame.locator("textarea").click();
    await cdp.send("Input.insertText", { text: "さんかいめ" });
    await sleep(300);
    r = { a, native: await page.evaluate(() => document.querySelector("#prompt-textarea").textContent), draft: await draftOf(frame) };
  } finally { await cdp.detach().catch(() => {}); }
  await page.close();
  assert.equal(h.server.byKind("conversation").length, 1, "前提: 1 回目が送れた");
  assert.equal(r.a.native.trim(), "", `作り直した ChatGPT の入力欄に文字が入った: ${JSON.stringify(r)}`);
  assert.equal(r.native.trim(), "", `クリックしたあとも ChatGPT の入力欄に文字が入った: ${JSON.stringify(r)}`);
  assert.equal(r.draft, "にかいめさんかいめ", `続けて打った文字が保護入力欄に入らない: ${JSON.stringify(r)}`);
});

test("T-SC-28b Service Worker を止めた直後でも、フォーカスはその場で保護入力欄に戻り、ChatGPT の入力欄に文字は入らない", async () => {
  const { page, frame } = await openChat();
  await stopServiceWorker();
  const r = await focusNativeThenType(page, frame, "ひみつ");
  await page.close();
  assert.equal(r.activeRightAfter, "IFRAME", `フォーカスを移した直後に、保護入力欄に戻っていない: ${JSON.stringify(r)}`);
  assert.equal(r.native.trim(), "", `ChatGPT の入力欄に文字が入った: ${JSON.stringify(r)}`);
  assert.equal(r.draft, "ひみつ", `打った文字が保護入力欄に入らない: ${JSON.stringify(r)}`);
});
