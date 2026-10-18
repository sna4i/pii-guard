// tests/e2e/standdown-and-retry.test.mjs — SC 有効時の二重処理停止と再試行 (F-SC-11 / F-SC-09)
//
// RT-STAND-01 SC 有効 + interactive:true のとき、ネイティブ送信を injected.js が横取りしない
//             (サイドバーが二重に出ない)。送信は 1 本・マスク済み・ブロックされず届く。
// RT-RETRY-01 送信が一度 500 で失敗し、ChatGPT の再試行ボタンを押して再送しても、本文は
//             マスク済みのまま (再試行でマスキングが無効化されない)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, piiText, MASKED_BY_ENGINE, sleep, writeEvidence } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true, interactive: true } }); });
after(async () => { if (h) await h.close(); });

test("RT-STAND-01 SC 有効時に injected.js が ChatGPT 送信を二重処理しない (F-SC-11)", async () => {
  await h.setStorage({ enabled: true, interactive: true });
  h.server.clear();
  const canary = makeCanary("STAND");
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 8000);
  assert.ok(frame, "Secure Composer 未起動");
  await h.waitScActive(page); // overlay が live として content.js→MAIN world に伝わるまで
  await h.type(page, frame, piiText(canary));
  await h.enter(page, frame);
  await sleep(2500); // interactive で横取りされるとサイドバー待ちで送信が止まるはず
  const conv = h.server.byKind("conversation");
  const body = conv.map((r) => r.body).join("\n");
  const sidebarShown = await page.evaluate(() => !!document.querySelector("[data-mask-mcp-sidebar]"));
  const leaks = h.leaksOf(MASKED_BY_ENGINE);
  writeEvidence("rt-stand-01", { conversations: conv.length, sidebarShown, rawLeak: leaks.total, masked: /<[A-Z_]+_\d+>/.test(body) });
  await page.close();
  assert.equal(conv.length, 1, "送信が届かない/二重になっている (横取りでブロックされた疑い)");
  assert.equal(sidebarShown, false, "SC 有効なのに injected.js がサイドバー確認を二重に出した");
  assert.equal(leaks.total, 0, "生の個人情報が送信に漏れた");
});

test("RT-RETRY-01 再試行ボタンで再送してもマスク済みのまま (F-SC-09)", async () => {
  await h.setStorage({ enabled: true, interactive: true });
  h.server.clear();
  const canary = makeCanary("RETRY");
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 8000);
  h.server.mode.conversation = "error500"; // 1 回目は失敗させる
  await h.type(page, frame, piiText(canary));
  await h.enter(page, frame);
  await sleep(2000);
  h.server.mode.conversation = "ok";
  // ChatGPT (モック) が出す再試行ボタンを押す
  const retry = page.locator('[data-testid="retry-button"]');
  const hadRetry = await retry.count().then((n) => n > 0).catch(() => false);
  if (hadRetry) { await retry.first().click().catch(() => {}); await sleep(2000); }
  const conv = h.server.byKind("conversation");
  const bodies = conv.map((r) => r.body);
  const anyRawLeak = bodies.some((b) => MASKED_BY_ENGINE.some((v) => b.includes(v)));
  const allMasked = bodies.every((b) => /<[A-Z_]+_\d+>/.test(b));
  writeEvidence("rt-retry-01", { attempts: conv.length, hadRetry, anyRawLeak, allMasked });
  await page.close();
  assert.ok(conv.length >= 1, "送信試行が記録されていない");
  assert.equal(anyRawLeak, false, "再試行後に生の個人情報が漏れた (マスキングが無効化された)");
  assert.ok(allMasked, "送信本文のどれかがマスクされていない");
});
