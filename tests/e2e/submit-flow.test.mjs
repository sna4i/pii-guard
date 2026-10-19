// tests/e2e/submit-flow.test.mjs — 送信が正しく通ること (P0-08 / P0-09送信時 / 二重送信 / P0-11)
//
// SF-01 マスキング ON: iframe で送信すると、ネイティブにはマスク済みが入り、conversation は
//        マスク済み本文で届き、モックの応答を受け取り、下書きは消え SECURE_READY に戻る (P0-08)
// SF-02 マスキング OFF: 送信操作のときだけ原文が正規送信される (P0-09 の送信時側)
// SF-03 二重送信しない: 続けて Enter を 2 回押しても conversation は 1 本
// SF-04 タブ分離: 2 つのタブの下書き・送信が混ざらない (P0-11)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, piiText, FAKE_PII, MASKED_BY_ENGINE, sleep, writeEvidence } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

test("SF-01 マスキング ON: マスク済みが送られ応答を受け取る (P0-08)", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const canary = makeCanary("SF1");
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 8000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await h.type(page, frame, piiText(canary));
  await h.enter(page, frame);
  await sleep(2500);
  const conv = h.server.byKind("conversation");
  const body = conv.map((r) => r.body).join("\n");
  const native = await h.nativeText(page);
  const draft = await frame.evaluate(() => document.querySelector("textarea").value);
  const st = await frame.evaluate(() => document.documentElement.dataset.state);
  const leaks = h.leaksOf(MASKED_BY_ENGINE);
  writeEvidence("sf-01", {
    conversations: conv.length, bodyHasPlaceholder: /<[A-Z_]+_\d+>/.test(body),
    rawPiiLeak: leaks.total, canaryDelivered: body.includes(canary), state: st, draftCleared: draft.length === 0, nativeEmpty: !native || !native.trim(),
  });
  await page.close();
  assert.equal(conv.length, 1, "conversation がちょうど 1 本ではない");
  assert.equal(leaks.total, 0, "マスク済みのはずが生の個人情報が送信に混入した");
  assert.ok(/<[A-Z_]+_\d+>/.test(body), "送信本文にプレースホルダが無い (マスクされていない)");
  assert.ok(body.includes(canary), "非 PII のカナリアは送られるはず (本文が届いた証拠)");
  assert.equal(draft.length, 0, "送信後に下書きが残っている");
});

test("SF-02 マスキング OFF: 送信操作で原文が正規送信される (P0-09 送信時)", async () => {
  await h.setStorage({ enabled: false });
  h.server.clear();
  const canary = makeCanary("SF2");
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 8000);
  const text = `${canary} 電話 ${FAKE_PII.phone}`;
  await h.type(page, frame, text);
  await h.enter(page, frame);
  await sleep(2500);
  const conv = h.server.byKind("conversation");
  const body = conv.map((r) => r.body).join("\n");
  writeEvidence("sf-02", { conversations: conv.length, hasOriginalPhone: body.includes(FAKE_PII.phone), hasCanary: body.includes(canary) });
  await page.close();
  await h.setStorage({ enabled: true });
  assert.equal(conv.length, 1);
  assert.ok(body.includes(FAKE_PII.phone), "OFF の送信操作後は原文が送られるべき");
});

test("SF-03 二重送信しない", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const canary = makeCanary("SF3");
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 8000);
  await h.type(page, frame, canary + " hello");
  await h.enter(page, frame);
  await h.enter(page, frame); // 連打
  await sleep(2500);
  const conv = h.server.byKind("conversation").filter((r) => r.body.includes(canary));
  writeEvidence("sf-03", { conversations: conv.length });
  await page.close();
  assert.equal(conv.length, 1, "連打で二重送信された");
});

test("SF-04 タブ分離: 2 タブの下書き・送信が混ざらない (P0-11)", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const cA = makeCanary("SF4A"), cB = makeCanary("SF4B");
  const pageA = await h.openChat("/");
  const pageB = await h.openChat("/c/abc123");
  const fA = await h.waitSecureReady(pageA, 8000);
  const fB = await h.waitSecureReady(pageB, 8000);
  assert.ok(fA && fB, "両タブで Secure Composer が立ち上がっていない");
  await h.type(pageA, fA, cA + " タブA");
  await h.type(pageB, fB, cB + " タブB");
  // それぞれの下書きが相手に漏れていない
  const draftA = await fA.evaluate(() => document.querySelector("textarea").value);
  const draftB = await fB.evaluate(() => document.querySelector("textarea").value);
  // A だけ送信
  await h.enter(pageA, fA);
  await sleep(2000);
  const conv = h.server.byKind("conversation");
  const body = conv.map((r) => r.body).join("\n");
  writeEvidence("sf-04", { draftAok: draftA.includes(cA) && !draftA.includes(cB), draftBok: draftB.includes(cB) && !draftB.includes(cA), sentA: body.includes(cA), sentB: body.includes(cB) });
  await pageA.close(); await pageB.close();
  assert.ok(draftA.includes(cA) && !draftA.includes(cB), "タブAの下書きにタブBの内容が混ざった");
  assert.ok(draftB.includes(cB) && !draftB.includes(cA), "タブBの下書きにタブAの内容が混ざった");
  assert.ok(body.includes(cA), "タブAの送信が届いていない");
  assert.ok(!body.includes(cB), "送信していないタブBの内容が届いた");
});
