// tests/e2e/sc-sw-restart-171.test.mjs — 拡張機能の Service Worker が止まったあとの保護入力欄
// (docs/release-1.7.1.md の「Service Worker が止まると、保護入力欄から送れなくなる」T-SC-26、T-SC-26b)
//
// Chrome は、拡張機能の Service Worker を 30 秒ほど出来事が無いと止める。テストでは CDP の
// ServiceWorker.stopAllWorkers で止める (拡張機能のページに付けたセッションから)。
//
// T-SC-26  止めたあとに個人情報を含む文を送ると 1 回送られ (伏せ字)、「送信できなかった」は出ず、send.failed も残らない
// T-SC-26b 止めたあとも高さの知らせ (4 行で入力欄が伸びる) とオフの警告 (アイコンが黄色) が届く
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, FAKE_PII, sleep } from "../fixtures/harness.mjs";

const PILL_HOST = 'div[data-pii-guard="composer-toggle"]';
const LINE = 24;

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

async function stopServiceWorker() {
  const cdp = await h.ctx.newCDPSession(h.ext);
  try {
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
  } finally { await cdp.detach().catch(() => {}); }
  await sleep(1000);
}
async function logsOf(code) {
  const all = await h.getStorage(null);
  return Object.entries(all).filter(([k]) => k.startsWith("diagLog:")).flatMap(([, v]) => (Array.isArray(v) ? v : [])).filter((e) => e && e.code === code);
}
const statusOf = (frame) => frame.evaluate(() => document.getElementById("status").textContent);

test("T-SC-26 Service Worker が止まったあとも、保護入力欄から伏せて送れる", async () => {
  h.server.clear();
  const failedBefore = (await logsOf("send.failed")).length;
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 10000);
  await sleep(500);
  await h.type(page, frame, "止める前の文です");
  await h.enter(page, frame);
  await sleep(2000);
  assert.equal(h.server.byKind("conversation").length, 1, "前提: 止める前に 1 回送れた");
  await stopServiceWorker();
  await h.type(page, frame, `${FAKE_PII.surname}さんの電話は ${FAKE_PII.phone} です`);
  await h.enter(page, frame);
  await sleep(3000);
  const conv = h.server.byKind("conversation");
  const status = await statusOf(frame);
  const draft = await frame.evaluate(() => document.getElementById("editor").value);
  const failed = (await logsOf("send.failed")).length - failedBefore;
  await page.close();
  assert.equal(conv.length, 2, `止めたあとの送信が届かない: ${JSON.stringify({ status, draftLeft: draft.length })}`);
  assert.ok(!conv[1].body.includes(FAKE_PII.phone), "伏せ字になっていない");
  assert.doesNotMatch(status, /送信できなかった/, `「送信できなかった」が出た: ${status}`);
  assert.equal(draft, "", "送ったのに下書きが残っている");
  assert.equal(failed, 0, "動作ログに send.failed が残った");
});

test("T-SC-30 つなぎ直しても、保護入力欄の文の欄に触らない (属性・高さ・フォーカス)。変換も切れない", async () => {
  h.server.clear();
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 10000);
  await sleep(500);
  const ta = frame.locator("textarea");
  await ta.click();
  await ta.pressSequentially("あいう", { delay: 3 });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.imeSetComposition", { text: "かんじ", selectionStart: 3, selectionEnd: 3 });
    await sleep(400);
    // ここから、文の欄への手出しを数える (属性と style の書き換え、focus() の呼び出し、変換の終わり、フォーカスの外れ)
    await frame.evaluate(() => {
      const ed = document.getElementById("editor");
      window.__touch = { attrs: [], focusCalls: 0, compositionEnd: 0, blur: 0 };
      new MutationObserver((ms) => { for (const m of ms) window.__touch.attrs.push(m.attributeName); }).observe(ed, { attributes: true });
      const f = ed.focus.bind(ed);
      ed.focus = (...a) => { window.__touch.focusCalls++; return f(...a); };
      ed.addEventListener("compositionend", () => { window.__touch.compositionEnd++; });
      ed.addEventListener("blur", () => { window.__touch.blur++; });
    });
    await stopServiceWorker();
    await sleep(2000); // 50ms ほどでつなぎ直し、相手がそろう
    const touch = await frame.evaluate(() => window.__touch);
    await cdp.send("Input.insertText", { text: "漢字" });
    await sleep(300);
    const value = await frame.evaluate(() => document.getElementById("editor").value);
    await ta.press("Enter");
    await sleep(2500);
    const sent = h.server.byKind("conversation").length;
    await page.close();
    assert.equal(sent, 1, "つなぎ直したあとに送れない (つなぎ直しが確かめられない)");
    assert.deepEqual(touch.attrs, [], `つなぎ直しで文の欄の属性を書き換えた: ${JSON.stringify(touch)}`);
    assert.equal(touch.focusCalls, 0, `つなぎ直しで文の欄に focus() を呼んだ: ${JSON.stringify(touch)}`);
    assert.equal(touch.compositionEnd, 0, "つなぎ直しで変換が切れた");
    assert.equal(touch.blur, 0, "つなぎ直しで文の欄からフォーカスが外れた");
    assert.equal(value, "あいう漢字", `確定した文が入っていない: ${JSON.stringify(value)}`);
  } finally { await cdp.detach().catch(() => {}); }
});

test("T-SC-26b Service Worker が止まったあとも、高さの知らせとオフの警告が届く", async () => {
  await h.setStorage({ enabled: false });
  try {
    const page = await h.openChat("/?variant=thread2026");
    const frame = await h.waitSecureReady(page, 10000);
    await sleep(500);
    await stopServiceWorker();
    const ta = frame.locator("textarea");
    await ta.click();
    for (let i = 1; i <= 4; i++) {
      await ta.pressSequentially(i === 1 ? `電話は ${FAKE_PII.phone} です` : `${i} 行目の文です`, { delay: 2 });
      if (i < 4) await ta.press("Shift+Enter");
    }
    await sleep(1500);
    const hostH = await page.evaluate(() => document.querySelector("[data-pii-guard-secure]").getBoundingClientRect().height);
    const tone = await page.evaluate((sel) => { const e = document.querySelector(sel); return e ? e.dataset.tone : null; }, PILL_HOST);
    await page.close();
    assert.ok(hostH >= 4 * LINE, `止めたあと、4 行で入力欄が伸びない (高さの知らせが届かない): ${hostH}`);
    assert.equal(tone, "warning", `止めたあと、オフの警告でアイコンが黄色にならない: ${tone}`);
  } finally {
    await h.setStorage({ enabled: true });
  }
});
