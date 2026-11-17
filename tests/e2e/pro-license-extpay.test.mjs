// tests/e2e/pro-license-extpay.test.mjs — 同梱した本物の ExtPay を、extensionpay.com を名乗る模擬のサーバにつないで動かす
// (docs/pro-license.md の T-PRO-12)
//
// 拡張機能の写しを作って license/config.js の ID だけをテスト用に替え、extensionpay.com を模擬のサーバに向ける
// (tests/fixtures/pro-ext.mjs の launchPro)。確かめること:
//   - 購入のページを開くまで、extensionpay.com と通信しない (入れた直後はお試しの Pro)
//   - 「Pro にアップグレード」で、ExtPay が API キーを作り、購入のページを開く
//   - 「購入状態を更新」で購入済みが届き、「Pro (プラン名)」になる。ページの世界のエンジンにも Pro が届く
//   - 通信に失敗しても、7 日以内なら Pro のまま注記が出る
//   - お試しはインストールから 7 日で終わる
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchPro, TEST_ID, API_KEY } from "../fixtures/pro-ext.mjs";

let h;
let pay;
let close;
before(async () => {
  ({ h, pay, close } = await launchPro({ storage: { enabled: true } }));
});
after(async () => {
  if (close) await close();
});

const ask = (msg) => h.ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
async function openPage(file) {
  const p = await h.ctx.newPage();
  await p.goto(`chrome-extension://${h.extId}/${file}`);
  return p;
}
// 「購入状態を更新」を押し、描き直されるまで待つ (押す前に印の文字を入れておき、それが替わるのを待つ)
async function statusAfterRefresh(p) {
  await p.waitForSelector("#pro-refresh:not([hidden])", { timeout: 5000 });
  await p.evaluate(() => { document.querySelector("#pro-status").textContent = "__waiting__"; });
  await p.click("#pro-refresh");
  await p.waitForFunction(() => document.querySelector("#pro-status").textContent !== "__waiting__", null, { timeout: 15000 });
  return { status: await p.textContent("#pro-status"), note: (await p.isVisible("#pro-note")) ? await p.textContent("#pro-note") : "" };
}

test("T-PRO-12 入れた直後はお試しの Pro で、購入のページを開くまで extensionpay.com と通信しない", async () => {
  const s = await ask({ type: "license:get", refresh: true });
  assert.equal(s.configured, true);
  assert.equal(s.paid, false);
  assert.equal(s.trial, true);
  assert.equal(s.pro, true);
  assert.ok(s.trialEndsAt > Date.now() + 6 * 24 * 3600 * 1000, "お試しは 7 日");
  assert.deepEqual(pay.state.requests, [], "通信しない");
  const alarms = await h.ext.evaluate(() => chrome.alarms.getAll());
  assert.deepEqual(alarms.filter((a) => a.name === "license-revalidate").map((a) => a.periodInMinutes), [60]);
});

test("T-PRO-12b 「Pro にアップグレード」で、ExtPay が API キーを作って購入のページを開く", async () => {
  const p = await openPage("popup.html");
  try {
    await p.waitForSelector("#license-upgrade:not([hidden])", { timeout: 5000 });
    assert.match(await p.textContent("#license-status"), /^Pro \(お試し中、あと 7 日\)$/);
    assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector("#license-box > .row")).borderBottomStyle), "solid",
      "プランの行の下の線が、.row:last-of-type に消されない");
    const [tab] = await Promise.all([h.ctx.waitForEvent("page", { timeout: 8000 }), p.click("#license-upgrade")]);
    await tab.waitForLoadState("domcontentloaded");
    assert.equal(new URL(tab.url()).pathname, `/extension/${TEST_ID}/choose-plan`);
    assert.equal(new URL(tab.url()).searchParams.get("api_key"), API_KEY);
    await tab.close();
    assert.deepEqual(pay.state.requests.map((r) => `${r.method} ${r.path}`).slice(0, 1), [`POST /extension/${TEST_ID}/api/new-key`]);
    const sync = await h.ext.evaluate(() => chrome.storage.sync.get("extensionpay_api_key"));
    assert.equal(sync.extensionpay_api_key, API_KEY);
  } finally { await p.close(); }
});

test("T-PRO-12c 購入のあと「購入状態を更新」で「Pro (プラン名)」になり、ページの世界のエンジンにも Pro が届く", async () => {
  pay.state.mode = "paid";
  const p = await openPage("options.html");
  try {
    const v = await statusAfterRefresh(p);
    assert.equal(v.status, "Pro (Pro 月額)");
    assert.equal(v.note, "");
    assert.equal(await p.isVisible("#pro-upgrade"), false);
    const cached = (await h.getStorage(["licenseState"])).licenseState;
    assert.equal(cached.paid, true);
    assert.equal(cached.email, "buyer@example.test");
    assert.ok(pay.state.requests.some((r) => r.path === `/extension/${TEST_ID}/api/v2/user` && r.apiKey === API_KEY));
  } finally { await p.close(); }
  const chat = await h.openChat("/");
  try {
    await chat.waitForFunction(() => window.__localMaskMCP && window.__localMaskMCP.settings && window.__localMaskMCP.settings.pro === true, null, { timeout: 8000 });
    assert.equal(await chat.evaluate(() => window.__localMaskMCP.engine.isProEnabled()), true);
  } finally { await chat.close(); }
});

const PRO_TEXT = "社内コード QA-PRO-7781 の件で相談です";
function sentText() {
  const conv = h.server.byKind("conversation");
  return conv.length ? JSON.parse(conv[conv.length - 1].body).messages[0].content.parts.join("") : null;
}

test("T-PRO-12f Pro のとき、保護入力欄 (ChatGPT) から送る文に Pro のルールが効く", async () => {
  h.server.clear();
  const page = await h.openChat("/");
  try {
    const frame = await h.waitSecureReady(page, 10000);
    assert.ok(frame, "保護入力欄が立ち上がる");
    // 保護入力欄が Service Worker から Pro を受け取り、エンジンに渡し終えるまで待つ
    await frame.waitForFunction(() => {
      const e = window.__localMaskMCP && window.__localMaskMCP.engine;
      return !!(e && typeof e.isProEnabled === "function" && e.isProEnabled());
    }, null, { timeout: 8000 });
    await h.type(page, frame, PRO_TEXT);
    await h.enter(page, frame);
    await page.waitForFunction(() => window.__mock.events.some((e) => e.type === "conversation-ok"), null, { timeout: 10000 });
    const body = sentText();
    assert.ok(body && !body.includes("QA-PRO-7781") && /<PRO_TEST_\d+>/.test(body), `届いた文 (${body})`);
  } finally { await page.close(); }
});

test("T-PRO-12g Pro のとき、content script (ISOLATED world) のエンジンで伏せる経路にも Pro のルールが効く", async () => {
  // 保護入力欄を切り、確認を出さず、除外リストを置く (リストがあると、ページの世界は ISOLATED world に伏せるのを頼む)
  await h.setStorage({ secureComposerEnabled: false, interactive: false, maskAllowlist: ["dummy@example.test"] });
  h.server.clear();
  const page = await h.openChat("/");
  try {
    await page.waitForFunction(() => window.__localMaskMCP && window.__localMaskMCP.settings && window.__localMaskMCP.settings.pro === true && window.__localMaskMCP.settings.hasSecretLists === true, null, { timeout: 8000 });
    await h.type(page, null, PRO_TEXT);
    await h.enter(page, null);
    await page.waitForFunction(() => window.__mock.events.some((e) => e.type === "conversation-ok"), null, { timeout: 10000 });
    const body = sentText();
    assert.ok(body && !body.includes("QA-PRO-7781") && /<PRO_TEST_\d+>/.test(body), `届いた文 (${body})`);
  } finally {
    await page.close();
    await h.setStorage({ secureComposerEnabled: true, interactive: true, maskAllowlist: [] });
  }
});

test("T-PRO-12d 通信に失敗しても、最後に確かめてから 7 日以内なら Pro のままで、注記が出る", async () => {
  pay.state.mode = "error";
  const p = await openPage("options.html");
  try {
    const v = await statusAfterRefresh(p);
    assert.equal(v.status, "Pro (Pro 月額)");
    assert.match(v.note, /^購入状態を確認できませんでした \(最後に確認: .+\)$/);
  } finally { await p.close(); }
});

test("T-PRO-12e お試しはインストールから 7 日で終わり、未購入なら無料版に戻る", async () => {
  pay.state.mode = "unpaid";
  await h.ext.evaluate(() => chrome.storage.sync.set({ extensionpay_installed_at: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() }));
  const s = await ask({ type: "license:get", refresh: true });
  assert.equal(s.paid, false);
  assert.equal(s.trial, false);
  assert.equal(s.pro, false);
  const p = await openPage("popup.html");
  try {
    await p.waitForSelector("#license-box:not([hidden])", { timeout: 5000 });
    assert.equal(await p.textContent("#license-status"), "無料版");
  } finally { await p.close(); }
});

test("T-PRO-12h ポップアップは開いたらすぐキャッシュで出し、裏の確かめ直しが終わったら出し直す", async () => {
  // 12e のあと: キャッシュは無料版。最後に確かめたのを 2 時間前にして (60 分を過ぎ、7 日以内)、購入済みに替える
  pay.state.mode = "paid";
  let release = () => {};
  let p = null;
  try {
    pay.state.gate = new Promise((r) => { release = r; });
    await h.ext.evaluate(async () => {
      const { licenseState } = await chrome.storage.local.get("licenseState");
      await chrome.storage.local.set({ licenseState: { ...licenseState, checkedAt: Date.now() - 2 * 3600 * 1000 } });
    });
    p = await openPage("popup.html");
    await p.waitForSelector("#license-box:not([hidden])", { timeout: 5000 });
    assert.equal(await p.textContent("#license-status"), "無料版", "確かめ直しの答えを待たずに、キャッシュで出す");
    release();
    await p.waitForFunction(() => document.querySelector("#license-status").textContent === "Pro (Pro 月額)", null, { timeout: 15000 });
  } finally {
    pay.state.gate = null;
    release();
    if (p) await p.close();
  }
});

test("T-PRO-12i キャッシュで先に出したあと、裏の確かめ直しが失敗したら、注記を出す", async () => {
  // 12h のあと: キャッシュは購入済み。最後に確かめたのを 2 時間前にして、問い合わせを失敗させる
  pay.state.mode = "error";
  let release = () => {};
  let p = null;
  try {
    pay.state.gate = new Promise((r) => { release = r; });
    await h.ext.evaluate(async () => {
      const { licenseState } = await chrome.storage.local.get("licenseState");
      await chrome.storage.local.set({ licenseState: { ...licenseState, checkedAt: Date.now() - 2 * 3600 * 1000 } });
    });
    p = await openPage("popup.html");
    await p.waitForSelector("#license-box:not([hidden])", { timeout: 5000 });
    assert.equal(await p.textContent("#license-status"), "Pro (Pro 月額)");
    assert.equal(await p.isVisible("#license-note"), false, "答えが届くまでは注記を出さない");
    release();
    await p.waitForSelector("#license-note:not([hidden])", { timeout: 15000 });
    assert.match(await p.textContent("#license-note"), /^購入状態を確認できませんでした \(最後に確認: .+\)$/);
    assert.equal(await p.textContent("#license-status"), "Pro (Pro 月額)", "7 日以内なので Pro のまま");
  } finally {
    pay.state.gate = null;
    release();
    if (p) await p.close();
    pay.state.mode = "paid";
  }
});

test("T-PRO-12j ポップアップを開いているあいだに購入状態が書き換わったら、出し直す (60 分ごとの確かめ直しなど)", async () => {
  let p = null;
  try {
    // 12i のあと: 模擬のサーバは購入済み。確かめ直して、新しいキャッシュ (Pro) にしておく
    await ask({ type: "license:get", refresh: true });
    p = await openPage("popup.html");
    await p.waitForFunction(() => document.querySelector("#license-status").textContent === "Pro (Pro 月額)", null, { timeout: 5000 });
    // 裏の確かめ直しが書き換えたのと同じ形で、購入を取り消した状態を書く (ポップアップ自身は何も問い合わせない)
    await h.ext.evaluate(async () => {
      const { licenseState } = await chrome.storage.local.get("licenseState");
      await chrome.storage.local.set({ licenseState: { ...licenseState, paid: false, plan: null, checkedAt: Date.now() } });
    });
    await p.waitForFunction(() => document.querySelector("#license-status").textContent !== "Pro (Pro 月額)", null, { timeout: 5000 });
  } finally {
    if (p) await p.close();
  }
});
