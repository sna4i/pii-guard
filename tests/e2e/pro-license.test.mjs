// tests/e2e/pro-license.test.mjs — ExtensionPay の ID が仮のまま (docs/pro-license.md の T-PRO-11、F-PRO-09)
//
// 出荷するまでの状態: ExtPay を同梱して Service Worker が読み込んでも、通信せず、無料版としてすべて動く。
// ポップアップと設定画面には「無料版」「Pro 版は準備中です」が出て、購入のボタンは出ない。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, sleep } from "../fixtures/harness.mjs";

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

test("T-PRO-11b ポップアップと設定画面に「無料版」と「Pro 版は準備中です」が出て、購入のボタンは出ない", async () => {
  for (const file of ["popup.html", "options.html"]) {
    const p = await h.ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(String(e)));
    try {
      await p.goto(`chrome-extension://${h.extId}/${file}`);
      const ids = file === "popup.html"
        ? { status: "#license-status", note: "#license-note", buttons: ["#license-upgrade", "#license-login", "#license-refresh"] }
        : { status: "#pro-status", note: "#pro-note", buttons: ["#pro-upgrade", "#pro-login", "#pro-refresh"] };
      await p.waitForFunction((sel) => document.querySelector(sel).textContent !== "確認中…", ids.status, { timeout: 5000 });
      assert.equal(await p.textContent(ids.status), "無料版", file);
      assert.equal(await p.textContent(ids.note), "Pro 版は準備中です", file);
      for (const b of ids.buttons) assert.equal(await p.isVisible(b), false, `${file} ${b}`);
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
    await sleep(200);
  } finally { await page.close(); }
});
