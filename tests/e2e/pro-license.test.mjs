// tests/e2e/pro-license.test.mjs — ExtensionPay の ID が仮のまま (docs/pro-license.md の T-PRO-11、F-PRO-09)
//
// 出荷するまでの状態: ExtPay を同梱して Service Worker が読み込んでも、通信せず、無料版としてすべて動く。
// ポップアップと設定画面には、Pro の表示そのものを出さない (D-PRO-12)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch({ storage: { enabled: true } }); });
after(async () => { if (h) await h.close(); });

const ask = (page, msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);

test("T-PRO-11 ID が仮なら、ライセンスは無料版 (unconfigured) で、再確認のアラームも作らない", async () => {
  const s = await ask(h.ext, { type: "license:get" });
  assert.equal(s.configured, false);
  assert.equal(s.source, "unconfigured");
  assert.equal(s.pro, false);
  const alarms = await h.ext.evaluate(() => chrome.alarms.getAll());
  assert.deepEqual(alarms.map((a) => a.name).filter((n) => n.startsWith("license")), []);
  const stored = await h.getStorage(["licenseState"]);
  assert.equal(stored.licenseState, undefined, "何も残さない");
  const sync = await h.ext.evaluate(() => chrome.storage.sync.get(null));
  assert.deepEqual(Object.keys(sync).filter((k) => k.startsWith("extensionpay")), [], "ExtPay も何も残さない");
  assert.deepEqual(await ask(h.ext, { type: "license:openPayment" }), { ok: false, reason: "unconfigured" });
});

test("T-PRO-11b ポップアップと設定画面には、Pro の表示を出さない (エラーも出さない)", async () => {
  for (const [file, box] of [["popup.html", "#license-box"], ["options.html", "#pro-card"]]) {
    const p = await h.ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(String(e)));
    try {
      await p.goto(`chrome-extension://${h.extId}/${file}`);
      // 答えが届いて描き終わるまで待つ (Service Worker への問い合わせを 1 往復させてから見る)
      await p.evaluate(() => chrome.runtime.sendMessage({ type: "license:get" }));
      await p.waitForTimeout(200);
      assert.equal(await p.isVisible(box), false, `${file} ${box}`);
      assert.deepEqual(errors, [], file);
    } finally { await p.close(); }
  }
});

test("T-PRO-11c 対応サイトのページの世界に、Pro はオフとして配られ、エンジンも Pro のルールを使わない", async () => {
  const page = await h.openChat("/");
  try {
    await page.waitForFunction(() => window.__localMaskMCP && window.__localMaskMCP.settings && "pro" in window.__localMaskMCP.settings, null, { timeout: 8000 });
    const st = await page.evaluate(() => ({ pro: window.__localMaskMCP.settings.pro, engine: window.__localMaskMCP.engine && window.__localMaskMCP.engine.isProEnabled && window.__localMaskMCP.engine.isProEnabled() }));
    assert.deepEqual(st, { pro: false, engine: false });
  } finally { await page.close(); }
});
