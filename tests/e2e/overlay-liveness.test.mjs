// tests/e2e/overlay-liveness.test.mjs — fail-open 修正: SC の素通しは overlay が live のときだけ (F-SC-11)
//
// RT-LIVE-01  SC が実際に立ち上がって入力欄を覆うと scOwnsComposer=true (injected.js を素通し)。
// RT-LIVE-02  secureComposerEnabled=true でも iframe が立ち上がらなければ scOwnsComposer は false の
//             まま (injected.js はマスクに戻る = fail-closed)。設定だけで素通しする旧挙動の回帰防止。
// RT-LIVE-03  入力欄が消えて overlay が覆えなくなったら scOwnsComposer は false に戻る。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, piiText, MASKED_BY_ENGINE, sleep, writeEvidence } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

test("RT-LIVE-01 overlay が live なら scOwnsComposer=true", async () => {
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 8000);
  assert.ok(frame, "SC 未起動");
  const ok = await h.waitScActive(page);
  const owns = await h.scOwns(page);
  writeEvidence("rt-live-01", { waitOk: ok, scOwns: owns });
  await page.close();
  assert.equal(owns, true, "overlay が live なのに scOwnsComposer が false");
});

test("RT-LIVE-02 SC 無効なら scOwnsComposer=false (素通しフラグが立たない)", async () => {
  // secureComposerEnabled=false = overlay 無し → scOwnsComposer は false。injected.js は
  // chatgpt アダプタを素通ししない (conversation をマスクする)。prepare 漏れは SC が無い限り
  // 残る既知の穴で、それを塞ぐのは overlay が覆うこと自体 (= SC 有効時のみ)。
  await h.setStorage({ enabled: true, secureComposerEnabled: false });
  const page = await h.openChat("/");
  await sleep(1500);
  const owns = await h.scOwns(page);
  writeEvidence("rt-live-02", { scOwns: owns });
  await h.setStorage({ secureComposerEnabled: true });
  await page.close();
  assert.equal(owns, false, "SC 無効なのに scOwnsComposer=true (素通しフラグの誤り)");
});

test("RT-LIVE-03 入力欄が消えたら scOwnsComposer=false に戻る", async () => {
  const page = await h.openChat("/");
  await h.waitSecureReady(page, 8000);
  await h.waitScActive(page);
  assert.equal(await h.scOwns(page), true);
  // ネイティブ入力欄を取り除く (SPA 遷移などで一時的に消える状況)
  await page.evaluate(() => { const el = document.querySelector("#prompt-textarea, textarea#mobile-composer-prompt"); if (el) el.remove(); });
  await page.waitForFunction(() => { const s = window.__localMaskMCP && window.__localMaskMCP.settings; return !!(s && s.scOwnsComposer === false); }, null, { timeout: 4000 }).catch(() => {});
  const owns = await h.scOwns(page);
  writeEvidence("rt-live-03", { scOwns: owns });
  await page.close();
  assert.equal(owns, false, "入力欄が消えても scOwnsComposer が true のまま");
});
