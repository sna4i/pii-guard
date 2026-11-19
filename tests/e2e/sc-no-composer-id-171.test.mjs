// tests/e2e/sc-no-composer-id-171.test.mjs — 2026-11-19 の ChatGPT は入力欄から id を外した
// (#prompt-textarea も textarea#mobile-composer-prompt も 0 件。実サイトで確認)。そのときを真似たモック
// (?noComposerId=1) で、保護入力欄が入力欄を見つけられるかを見る (T-SC-32)
//
// 入力欄は div.ProseMirror[contenteditable=true] aria-label="ChatGPT に聞く"。id が無いので、拡張機能は class と
// aria-label で送信の欄を見分ける。会話の中の文章の欄も同じ class なので、そちらを掴まないことも見る
//
// T-SC-32  入力欄に id が無くても、保護入力欄は入力欄に重なり、送信を受け持ち、打った文は伏せ字で届く
// T-SC-32b 回答の中に同じ class の文章の欄が出ても、保護入力欄は送信の入力欄の上に残り、文章の欄は覆われない
// T-SC-32c 入力欄に id が無いまま、2 回目も保護入力欄から送れる (見回りで入力欄を見失わない)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, FAKE_PII, MASKED_BY_ENGINE, sleep } from "../fixtures/harness.mjs";

const PII_TEXT = `${FAKE_PII.surname}さんの電話は ${FAKE_PII.phone}、メールは ${FAKE_PII.email} です`;
// 入力欄は id で引けないので、入力欄の form の中の編集欄で引く
const COMPOSER = "#composer-root form div.ProseMirror[contenteditable='true']";

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

const rect = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return [r.left, r.top, r.width, r.height].map(Math.round);
}, sel);

test("T-SC-32 入力欄に id が無くても、保護入力欄は入力欄に重なり、打った文は伏せ字で届く", async () => {
  h.server.clear();
  const page = await h.openChat("/?noComposerId=1");
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない (id の無い入力欄を見つけられていない)");
  await sleep(600);
  const host = await rect(page, "[data-pii-guard-secure]");
  const composer = await rect(page, COMPOSER);
  assert.ok(host && composer, `保護入力欄か入力欄が無い (host=${JSON.stringify(host)}, composer=${JSON.stringify(composer)})`);
  // 左・上・幅 (高さは下書きで変わる)
  assert.ok([0, 1, 2].every((i) => Math.abs(host[i] - composer[i]) <= 2), `保護入力欄が入力欄に重なっていない (host=${JSON.stringify(host)}, composer=${JSON.stringify(composer)})`);
  assert.equal(await h.scOwns(page), true, "保護入力欄が送信を受け持っていない");

  await h.type(page, frame, PII_TEXT);
  await h.enter(page, frame);
  await sleep(2500);
  const conv = h.server.byKind("conversation");
  const body = conv.map((r) => r.body).join("\n");
  const leaks = h.leaksOf(MASKED_BY_ENGINE);
  const draft = await frame.evaluate(() => document.getElementById("editor").value);
  await page.close();
  assert.equal(conv.length, 1, "送れていない");
  assert.ok(MASKED_BY_ENGINE.every((v) => !body.includes(v)), `生の個人情報が届いた: ${body}`);
  assert.ok(/<[A-Z_]+_\d+>/.test(body), "伏せ字が届いていない");
  assert.equal(leaks.total, 0, "送信に生の個人情報が混じった");
  assert.equal(draft, "", "送ったあと保護入力欄が空になっていない");
});

test("T-SC-32b 回答の中の文章の欄を入力欄と取り違えず、保護入力欄は入力欄の上に残る", async () => {
  h.server.clear();
  const page = await h.openChat("/?noComposerId=1&writingBlock=1");
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await sleep(500);
  await h.type(page, frame, "メールの下書きを書いて");
  await frame.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__mock.events.some((e) => e.type === "writing-block"), null, { timeout: 10000 });
  await sleep(1600); // 見回り (1 秒おき) のあと
  const host = await rect(page, "[data-pii-guard-secure]");
  const composer = await rect(page, COMPOSER);
  const wbTop = await page.evaluate(() => {
    const wb = document.querySelector('[data-testid="writing-block-editor"]');
    const r = wb.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 18));
    return !!(top && wb.contains(top));
  });
  const wbText = await page.evaluate(() => document.querySelector('[data-testid="writing-block-editor"]').innerText);
  await page.close();
  assert.ok([0, 1, 2].every((i) => Math.abs(host[i] - composer[i]) <= 2), `保護入力欄が入力欄の上にない (host=${JSON.stringify(host)}, composer=${JSON.stringify(composer)})`);
  assert.ok(wbTop, "文章の欄が覆われている");
  assert.match(wbText, /打ち合わせの日程/, "文章の欄の中身が変わった");
});

test("T-SC-32c 入力欄に id が無いまま、2 回目も保護入力欄から送れる", async () => {
  h.server.clear();
  const page = await h.openChat("/?noComposerId=1");
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await h.type(page, frame, "一通目の質問です");
  await h.enter(page, frame);
  await page.waitForFunction(() => window.__mock.events.some((e) => e.type === "conversation-ok"), null, { timeout: 10000 });
  await sleep(1500); // 見回りのあと
  await h.type(page, frame, "二通目の質問です");
  await frame.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__mock.events.filter((e) => e.type === "conversation-ok").length >= 2, null, { timeout: 10000 }).catch(() => {});
  await sleep(600);
  const conv = h.server.byKind("conversation");
  const draft = await frame.evaluate(() => document.getElementById("editor").value);
  const host = await rect(page, "[data-pii-guard-secure]");
  await page.close();
  assert.equal(conv.length, 2, `2 回目が送れない (下書き: ${JSON.stringify(draft)})`);
  assert.ok(conv[1].body.includes("二通目の質問です"), "2 回目の文が届いていない");
  assert.ok(host, "送ったあと保護入力欄が消えた");
});
