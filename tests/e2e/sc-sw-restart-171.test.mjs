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
