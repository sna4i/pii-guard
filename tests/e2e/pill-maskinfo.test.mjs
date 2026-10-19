// tests/e2e/pill-maskinfo.test.mjs — 確認機能 OFF のとき、SC がマスクしたらピルを黄色に (F-SC-10)
//
// RT-PILL-01  interactive:false + SC 有効で PII を送ると、ピル (data-pii-guard=composer-toggle) が
//             tone=warning (黄色) になり、enabled は true のまま。確認画面の代わりの気づき。
// RT-PILL-02  interactive:true のときは黄色にしない (確認経路がある想定)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, piiText, sleep, writeEvidence } from "../fixtures/harness.mjs";

const HOST = 'div[data-pii-guard="composer-toggle"]';
let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

async function pillTone(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? { tone: el.dataset.tone, enabled: el.dataset.enabled } : null;
  }, HOST);
}

async function sendPii(page, label, interactive) {
  await h.setStorage({ enabled: true, interactive });
  const canary = makeCanary(label);
  const frame = await h.waitSecureReady(page, 8000);
  assert.ok(frame, "Secure Composer 未起動");
  // ピルが composer に付くまで待つ
  await page.waitForSelector(HOST, { timeout: 8000 });
  await h.type(page, frame, piiText(canary));
  await h.enter(page, frame);
  await sleep(2500);
}

test("RT-PILL-01 確認 OFF + SC マスクでピルが黄色 (F-SC-10)", async () => {
  h.server.clear();
  const page = await h.openChat("/");
  await sendPii(page, "PILL1", false);
  const tone = await pillTone(page);
  writeEvidence("rt-pill-01", tone);
  await page.close();
  assert.ok(tone, "ピルが見つからない");
  assert.equal(tone.enabled, "true", "オンのままであるべき");
  assert.equal(tone.tone, "warning", "確認 OFF + マスク済みデータでピルが黄色になっていない");
});

test("RT-PILL-02 確認 ON のときは黄色にしない", async () => {
  h.server.clear();
  const page = await h.openChat("/");
  await sendPii(page, "PILL2", true);
  const tone = await pillTone(page);
  writeEvidence("rt-pill-02", tone);
  await page.close();
  assert.ok(tone);
  assert.notEqual(tone.tone, "warning", "確認 ON なのに黄色になった");
});
