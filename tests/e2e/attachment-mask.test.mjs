// tests/e2e/attachment-mask.test.mjs — 添付のマスク (F-SC-07) と未マスク添付の警告 (F-SC-08)
//
// AT-01 テキストファイルを添付すると、アップロードされる中身がマスク済みになる (原文の
//        個人情報が出ない・プレースホルダが入る)。attachment-guard が選択時に差し替える。
// AT-02 バイナリ (画像) はマスクできないのでブロックされ、アップロードされない + ピルが警告色。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, FAKE_PII, MASKED_BY_ENGINE, sleep, writeEvidence } from "../fixtures/harness.mjs";

const HOST = 'div[data-pii-guard="composer-toggle"]';
let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

async function openReady() {
  const page = await h.openChat("/");
  await h.waitSecureReady(page, 8000).catch(() => {});
  await sleep(2000); // ISOLATED world の attachment-guard / engine 初期化待ち
  await page.waitForSelector('#mock-file', { timeout: 5000 });
  return page;
}

test("AT-01 テキスト添付はアップロード前にマスクされる (F-SC-07)", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const canary = makeCanary("ATT1");
  const content = `${canary}\n氏名：${FAKE_PII.surname}太郎\n電話：${FAKE_PII.phone}\nメール：${FAKE_PII.email}\n住所：${FAKE_PII.address}`;
  const page = await openReady();
  await page.setInputFiles('#mock-file', { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from(content, "utf8") });
  await sleep(2500);
  const uploaded = h.server.byKind("files-content");
  const body = uploaded.map((r) => r.body).join("\n");
  const leaks = h.leaksOf(MASKED_BY_ENGINE);
  writeEvidence("at-01", {
    uploads: uploaded.length,
    rawLeak: leaks.total,
    hasPlaceholder: /<[A-Z_]+_\d+>/.test(body),
    canaryDelivered: body.includes(canary),
  });
  await page.close();
  assert.equal(uploaded.length, 1, "添付が 1 回アップロードされていない");
  assert.equal(leaks.total, 0, "添付の中身に生の個人情報が残って送られた (F-SC-07 失敗)");
  assert.ok(/<[A-Z_]+_\d+>/.test(body), "マスクのプレースホルダが無い");
  assert.ok(body.includes(canary), "非 PII のカナリアは残るはず (中身が届いた証拠)");
});

test("AT-02 バイナリ添付はブロックされ警告 (F-SC-08)", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const page = await openReady();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
  await page.setInputFiles('#mock-file', { name: "secret.png", mimeType: "image/png", buffer: png });
  await sleep(2500);
  const uploaded = h.server.byKind("files-content");
  const tone = await page.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.dataset.tone : null; }, HOST);
  writeEvidence("at-02", { uploads: uploaded.length, pillTone: tone });
  await page.close();
  assert.equal(uploaded.length, 0, "マスクできないバイナリがアップロードされた (ブロック失敗)");
  assert.equal(tone, "warning", "未マスク添付をブロックしたのにピルが警告色でない");
});
