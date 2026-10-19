// tests/redteam/secrets-isolation.test.mjs — 除外リスト・常に伏せる語を、どのサイトでも MAIN world に出さない (V-02)
//
// これまで MAIN world に機密のリストを出さないのは Secure Composer の効いている ChatGPT だけで、
// Claude / Gemini / Manus (とSC を切った ChatGPT) では、ページのマスクのためにリストを MAIN world へ
// 配っていた。2026-10-18 から全サイトで配らず、ページのマスクは ISOLATED world のエンジンに頼む。
// ここでは SC を切ったモック (= ページ側でマスクする他サイトと同じ経路) で確かめる。
//
// RT-V02-01 リストの値が、ページの設定にもページに届いたメッセージにも一度も出ない
// RT-V02-02 それでも「常に伏せる語」は送信でも送信前の通信でも伏せられる (ISOLATED 経由のマスク)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, sleep, writeEvidence } from "../fixtures/harness.mjs";

let h;
const FORCE_SECRET = "白鳥計画" + makeCanary("F").slice(-6);
const ALLOW_SECRET = makeCanary("ALLOW");
before(async () => {
  h = await launch({
    storage: {
      enabled: true, interactive: false, secureComposerEnabled: false,
      maskForceList: [{ value: FORCE_SECRET, category: "OTHER" }],
      maskAllowlist: [ALLOW_SECRET],
    },
  });
});
after(async () => { if (h) await h.close(); });

async function openWithSniffer() {
  const page = await h.ctx.newPage();
  await page.addInitScript(() => {
    window.__sniffed = [];
    window.addEventListener("message", (e) => { try { window.__sniffed.push(JSON.stringify(e.data)); } catch (_) {} }, true);
  });
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__mock && document.querySelector("#composer-root form"));
  await sleep(2500); // 設定の配布・エンジンの初期化を待つ
  return page;
}

test("RT-V02-01 リストの値がページ (MAIN world) に出ない", async () => {
  const page = await openWithSniffer();
  // ページ側でマスクを走らせる (確認の流れでリストが MAIN に来ないか)
  await page.locator("#prompt-textarea").click();
  await page.locator("#prompt-textarea").pressSequentially(`件名 ${FORCE_SECRET} と ${ALLOW_SECRET}`, { delay: 10 });
  await sleep(1500);
  const r = await page.evaluate(({ f, a }) => {
    const s = (window.__localMaskMCP && window.__localMaskMCP.settings) || {};
    const sniffed = window.__sniffed.join("\n");
    // 届いたメッセージのうち、ページ自身が出したもの (入力中の文を含む) を除いた「拡張からの」ものだけを見る
    const fromExt = window.__sniffed.filter((m) => /"source":"mask-mcp-content"/.test(m)).join("\n");
    return {
      forceInSettings: JSON.stringify(s.maskForceList || []).includes(f),
      allowInSettings: JSON.stringify(s.maskAllowlist || []).includes(a),
      hasSecretLists: s.hasSecretLists === true,
      settingsMsgs: (sniffed.match(/"type":"settings"/g) || []).length,
      // 拡張からのメッセージに出てよいのは、ページ自身が渡した文についての結果だけ。
      // 設定の配布 (type:settings) にリストの値が無いことを見る
      settingsCarryForce: window.__sniffed.filter((m) => /"type":"settings"/.test(m)).some((m) => m.includes(f)),
      settingsCarryAllow: window.__sniffed.filter((m) => /"type":"settings"/.test(m)).some((m) => m.includes(a)),
      extMsgs: fromExt.length,
    };
  }, { f: FORCE_SECRET, a: ALLOW_SECRET });
  writeEvidence("rt-v02-01", r);
  await page.close();
  assert.ok(r.settingsMsgs > 0, "設定の配布を観測できていない");
  assert.equal(r.forceInSettings, false, "常に伏せる語が MAIN world の設定にある");
  assert.equal(r.allowInSettings, false, "除外リストが MAIN world の設定にある");
  assert.equal(r.settingsCarryForce, false, "設定の配布に常に伏せる語が乗った");
  assert.equal(r.settingsCarryAllow, false, "設定の配布に除外リストが乗った");
  assert.equal(r.hasSecretLists, true, "リストがあることだけは知らせる (取れないときに止めるため)");
});

test("RT-V02-02 常に伏せる語は、送信でも送信前の通信でも伏せられる", async () => {
  h.server.clear();
  const page = await openWithSniffer();
  const ed = page.locator("#prompt-textarea");
  await ed.click();
  await ed.pressSequentially(`進捗は ${FORCE_SECRET} の件で`, { delay: 10 });
  await sleep(1200); // prepare (送信前) が出る
  await page.keyboard.press("Enter");
  await sleep(3000);
  const conv = h.server.byKind("conversation");
  const prepare = h.server.byKind("prepare");
  const all = h.server.requests.map((x) => x.body || "").join("\n");
  writeEvidence("rt-v02-02", { conversations: conv.length, prepares: prepare.length, rawAnywhere: all.includes(FORCE_SECRET), placeholder: /USER_DEFINED/.test(conv.map((c) => c.body).join("\n")) });
  await page.close();
  assert.equal(conv.length, 1, "送信が 1 回届いていない");
  assert.ok(!conv[0].body.includes(FORCE_SECRET), "送信に常に伏せる語が生のまま乗った");
  assert.match(conv[0].body, /USER_DEFINED/, "常に伏せる語の伏せ字が無い (ISOLATED 経由のマスクが効いていない)");
  assert.ok(!all.includes(FORCE_SECRET), "どこかの通信 (送信前を含む) に常に伏せる語が生のまま乗った");
});
