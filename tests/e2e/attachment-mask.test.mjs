// tests/e2e/attachment-mask.test.mjs — 添付のマスク (F-SC-07) と未マスク添付の警告 (F-SC-08)
//
// AT-01 テキストファイルを添付すると、アップロードされる中身がマスク済みになる (原文の
//        個人情報が出ない・プレースホルダが入る)。attachment-guard が選択時に差し替える。
// AT-02 バイナリ (画像) はマスクできないのでブロックされ、アップロードされない + ピルが警告色。
// AT-03 Shift_JIS のテキスト (日本の CSV に多い) も正しく読んでマスクし、UTF-8 で渡す。
// AT-04 BOM 付き UTF-16 も同じ。BOM 無し UTF-16 (NUL が混ざる) は読めない扱いでブロック。
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

// Python で作った Shift_JIS のバイト列 (Node には Shift_JIS のエンコーダが無い)。中身は架空:
// PII_GUARD_SJIS_CANARY / メモ：テスト用の架空データ / 氏名：山田太郎 / 電話：090-1234-5678 /
// メール：taro.yamada@example.test / 住所：東京都渋谷区テスト町3丁目12番8号
const SJIS_HEX = "5049495f47554152445f534a49535f43414e4152590a838183828146836583588367977082cc89cb8bf38366815b835e0a8e8196bc81468e52936391be98590a9364986281463039302d313233342d353637380a8381815b838b81467461726f2e79616d616461406578616d706c652e746573740a8f5a8f8a8146938c8b9e93738f61924a8be683658358836792ac33929a96da313294d4388d860a";
const UTF16_TEXT = `PII_GUARD_UTF16_CANARY\nメモ：テスト用の架空データ\n氏名：${FAKE_PII.surname}太郎\n電話：${FAKE_PII.phone}\nメール：${FAKE_PII.email}\n住所：${FAKE_PII.address}\n`;

async function uploadAndRead(name, mimeType, buffer) {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const page = await openReady();
  await page.setInputFiles('#mock-file', { name, mimeType, buffer });
  await sleep(2500);
  const uploaded = h.server.byKind("files-content");
  const tone = await page.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.dataset.tone : null; }, HOST);
  await page.close();
  return { uploaded, body: uploaded.map((r) => r.body).join("\n"), leaks: h.leaksOf(MASKED_BY_ENGINE), tone };
}

test("AT-03 Shift_JIS のテキストも読んでマスクする", async () => {
  const r = await uploadAndRead("meibo.csv", "text/csv", Buffer.from(SJIS_HEX, "hex"));
  writeEvidence("at-03", { uploads: r.uploaded.length, rawLeak: r.leaks.total, readable: r.body.includes("テスト用の架空データ") });
  assert.equal(r.uploaded.length, 1, "Shift_JIS の添付がアップロードされていない");
  assert.equal(r.leaks.total, 0, "Shift_JIS の添付に生の個人情報が残った");
  assert.ok(!r.body.includes("山田太郎"), "氏名が伏せられていない");
  assert.ok(r.body.includes("テスト用の架空データ"), "日本語が文字化けした (Shift_JIS を UTF-8 として読んだ)");
  assert.ok(r.body.includes("PII_GUARD_SJIS_CANARY"));
});

test("AT-04 UTF-16: BOM 付きはマスク、BOM 無し (NUL 混じり) はブロック", async () => {
  const bom = await uploadAndRead("note16.txt", "text/plain", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(UTF16_TEXT, "utf16le")]));
  writeEvidence("at-04-bom", { uploads: bom.uploaded.length, rawLeak: bom.leaks.total, readable: bom.body.includes("テスト用の架空データ") });
  assert.equal(bom.uploaded.length, 1);
  assert.equal(bom.leaks.total, 0, "UTF-16 の添付に生の個人情報が残った");
  assert.ok(bom.body.includes("テスト用の架空データ"), "UTF-16 を正しく読めていない");
  const raw = await uploadAndRead("note16raw.txt", "text/plain", Buffer.from(UTF16_TEXT, "utf16le"));
  writeEvidence("at-04-nobom", { uploads: raw.uploaded.length, pillTone: raw.tone });
  assert.equal(raw.uploaded.length, 0, "読めない (NUL 混じり) テキストがそのままアップロードされた");
  assert.equal(raw.tone, "warning");
});
