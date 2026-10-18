// tests/e2e/pii-send-warning.test.mjs — PII 検出時に送信前へ警告を出す (F-SC-12)
//
// WARN-01 PII を含む下書きを Enter すると、送信前に確認が出る。送信を押すとマスクして送られる。
// WARN-02 確認でキャンセルすると送信されず、下書きは残る。
// WARN-03 PII が無い下書きは確認が出ず、そのまま送られる (無駄な確認を出さない)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, piiText, MASKED_BY_ENGINE, sleep, writeEvidence } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

async function confirmShowing(frame) {
  return frame.evaluate(() => document.documentElement.dataset.confirm === "1" || !!document.querySelector('#confirm[data-show="1"]'));
}

test("WARN-01 PII を含むと送信前に確認が出て、送信でマスクして送られる (F-SC-12)", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const canary = makeCanary("WARN1");
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 8000);
  await h.waitScActive(page);
  await h.type(page, frame, piiText(canary));
  await h.enterNoConfirm(page, frame);
  await frame.waitForSelector('#confirm[data-show="1"]', { timeout: 4000 });
  const shown = await confirmShowing(frame);
  await frame.locator('#confirm-send').click();
  await sleep(2500);
  const conv = h.server.byKind("conversation");
  const leaks = h.leaksOf(MASKED_BY_ENGINE);
  writeEvidence("warn-01", { confirmShown: shown, conversations: conv.length, rawLeak: leaks.total });
  await page.close();
  assert.equal(shown, true, "PII があるのに確認が出なかった");
  assert.equal(conv.length, 1, "送信を押したのに送られていない");
  assert.equal(leaks.total, 0, "送られた本文に生の個人情報が残っている");
});

test("WARN-02 確認をキャンセルすると送信されず下書きは残る", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const canary = makeCanary("WARN2");
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 8000);
  await h.waitScActive(page);
  await h.type(page, frame, piiText(canary));
  await h.enterNoConfirm(page, frame);
  await frame.waitForSelector('#confirm[data-show="1"]', { timeout: 4000 });
  await frame.locator('#confirm-cancel').click();
  await sleep(1500);
  const conv = h.server.byKind("conversation");
  const draft = await frame.evaluate(() => document.querySelector("textarea").value);
  writeEvidence("warn-02", { conversations: conv.length, draftKept: draft.includes(canary) });
  await page.close();
  assert.equal(conv.length, 0, "キャンセルしたのに送信された");
  assert.ok(draft.includes(canary), "キャンセルで下書きが消えた");
});

test("WARN-03 PII が無ければ確認を出さずに送る", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const canary = makeCanary("WARN3");
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 8000);
  await h.waitScActive(page);
  await h.type(page, frame, canary + " こんにちは、資料をお願いします"); // PII 無し
  await h.enterNoConfirm(page, frame);
  await sleep(1500);
  const shown = await confirmShowing(frame);
  const conv = h.server.byKind("conversation");
  writeEvidence("warn-03", { confirmShown: shown, conversations: conv.length });
  await page.close();
  assert.equal(shown, false, "PII が無いのに確認が出た (無駄な確認)");
  assert.equal(conv.length, 1, "そのまま送られるべき");
});
