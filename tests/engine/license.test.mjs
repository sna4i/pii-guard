// tests/engine/license.test.mjs — Pro 版のライセンス管理 (docs/pro-license.md の T-PRO-01〜07)
//
// ExtPay・chrome.storage.local・chrome.alarms・chrome.runtime・時計を偽物に替えて、
// browser-extension/license/license.js の createLicenseManager() を動かす。通信はしない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLicenseManager, LICENSE_CACHE_KEY, REVALIDATE_INTERVAL_MS, GRACE_PERIOD_MS, TRIAL_PERIOD_MS } from "../../browser-extension/license/license.js";

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXT_BASE = `chrome-extension://${EXT_ID}/`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 10, 0, 0, 0); // 2026-11-10 00:00 UTC

// ---- 偽物 -----------------------------------------------------------------------------
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
  };
}
function fakeAlarms(existing = []) {
  const alarms = new Map(existing.map((a) => [a.name, a]));
  const created = [];
  const listeners = [];
  return {
    created, listeners,
    async get(name) { return alarms.get(name); },
    create(name, info) { created.push({ name, ...info }); alarms.set(name, { name, ...info }); },
    onAlarm: { addListener(fn) { listeners.push(fn); } },
  };
}
function fakeRuntime() {
  const messageListeners = [];
  const installedListeners = [];
  return {
    id: EXT_ID,
    messageListeners, installedListeners,
    getURL(p) { return EXT_BASE + p; },
    onMessage: { addListener(fn) { messageListeners.push(fn); } },
    onInstalled: { addListener(fn) { installedListeners.push(fn); } },
  };
}
// user: getUser() が返すもの。fail: true なら通信の失敗として投げる。hang: true なら返らない (時間切れを試す)。
// openFails: true なら購入とログインのページを開く操作が失敗する (API キーを作る通信の失敗)
function fakeExtPay({ user = { paid: false, installedAt: new Date(T0) }, fail = false, hang = false, openFails = false, openHang = false } = {}) {
  const calls = { getUser: 0, startBackground: 0, openPaymentPage: 0, openLoginPage: 0 };
  const api = {
    calls,
    set user(u) { user = u; },
    set fail(f) { fail = f; },
    async getUser() {
      calls.getUser++;
      if (hang) return new Promise(() => {});
      await Promise.resolve();
      if (fail) throw new TypeError("Failed to fetch");
      return user;
    },
    startBackground() { calls.startBackground++; },
    async openPaymentPage() { calls.openPaymentPage++; if (openHang) return new Promise(() => {}); if (openFails) throw new TypeError("Failed to fetch"); },
    async openLoginPage() { calls.openLoginPage++; if (openFails) throw new TypeError("Failed to fetch"); },
  };
  return api;
}
function setup({ id = "pii-guard-test", now = T0, user, fail, hang, openFails, openHang, storage = {}, alarms = [], networkTimeoutMs } = {}) {
  const clock = { now };
  const extpay = fakeExtPay({ user, fail, hang, openFails, openHang });
  let made = 0;
  const deps = {
    extpayId: id,
    makeExtPay: (gotId) => { made++; assert.equal(gotId, id); return extpay; },
    storage: fakeStorage(storage),
    alarms: fakeAlarms(alarms),
    runtime: fakeRuntime(),
    now: () => clock.now,
    ...(networkTimeoutMs ? { networkTimeoutMs } : {}),
  };
  const lm = createLicenseManager(deps);
  return { lm, deps, extpay, clock, made: () => made };
}
const PLAN = { unitAmountCents: 500, currency: "jpy", nickname: "Pro 月額", interval: "month", intervalCount: 1 };
const paidUser = (installedAt = new Date(T0 - 30 * DAY)) => ({ paid: true, plan: PLAN, email: "buyer@example.test", installedAt, paidAt: new Date(T0 - 10 * DAY), trialStartedAt: null });
const unpaidUser = (installedAt = new Date(T0 - 30 * DAY)) => ({ paid: false, plan: null, email: null, installedAt, paidAt: null, trialStartedAt: null });

// ---- T-PRO-01 キャッシュ ---------------------------------------------------------------------
test("T-PRO-01 60 分以内のキャッシュがあれば、ExtPay に問い合わせずにそれを返す", async () => {
  const cached = { paid: true, plan: PLAN, email: "buyer@example.test", checkedAt: T0 - 59 * 60 * 1000, trialEndsAt: T0 - 23 * DAY };
  const { lm, extpay } = setup({ storage: { [LICENSE_CACHE_KEY]: cached }, user: unpaidUser() });
  const s = await lm.getLicenseState();
  assert.equal(extpay.calls.getUser, 0, "通信しない");
  assert.equal(s.source, "cache");
  assert.equal(s.paid, true);
  assert.equal(s.pro, true);
  assert.equal(s.plan.nickname, "Pro 月額");
});

test("T-PRO-01b ちょうど 60 分たったキャッシュは使わず、確かめ直す (境界値)", async () => {
  const cached = { paid: true, plan: PLAN, email: "buyer@example.test", checkedAt: T0 - REVALIDATE_INTERVAL_MS, trialEndsAt: null };
  const { lm, extpay } = setup({ storage: { [LICENSE_CACHE_KEY]: cached }, user: unpaidUser() });
  const s = await lm.getLicenseState();
  assert.equal(extpay.calls.getUser, 1);
  assert.equal(s.source, "network");
  assert.equal(s.paid, false);
});

test("T-PRO-01c refresh を付けると、新しいキャッシュがあっても確かめ直す", async () => {
  const cached = { paid: false, plan: null, email: null, checkedAt: T0 - 60 * 1000, trialEndsAt: null };
  const { lm, extpay } = setup({ storage: { [LICENSE_CACHE_KEY]: cached }, user: paidUser() });
  const s = await lm.getLicenseState({ refresh: true });
  assert.equal(extpay.calls.getUser, 1);
  assert.equal(s.paid, true);
  assert.equal(s.source, "network");
});

// ---- T-PRO-02 通信の失敗と猶予 ----------------------------------------------------------------
test("T-PRO-02 通信に失敗しても、最後に確かめてから 7 日以内で購入済みなら Pro のまま", async () => {
  const cached = { paid: true, plan: PLAN, email: "buyer@example.test", checkedAt: T0 - 6 * DAY, trialEndsAt: null };
  const { lm, deps } = setup({ storage: { [LICENSE_CACHE_KEY]: cached }, fail: true });
  const s = await lm.getLicenseState();
  assert.equal(s.source, "grace");
  assert.equal(s.paid, true);
  assert.equal(s.pro, true);
  assert.equal(s.checkedAt, T0 - 6 * DAY, "最後に確かめた日時は変えない");
  assert.equal(deps.storage.data[LICENSE_CACHE_KEY].checkedAt, T0 - 6 * DAY, "キャッシュも書き換えない");
});

test("T-PRO-02b 最後に確かめてから 7 日を過ぎていたら、通信の失敗で無料版になる (境界値)", async () => {
  const cached = { paid: true, plan: PLAN, email: "buyer@example.test", checkedAt: T0 - GRACE_PERIOD_MS, trialEndsAt: null };
  const { lm } = setup({ storage: { [LICENSE_CACHE_KEY]: cached }, fail: true });
  const s = await lm.getLicenseState();
  assert.equal(s.source, "none");
  assert.equal(s.paid, false);
  assert.equal(s.pro, false);
  assert.equal(s.checkedAt, T0 - GRACE_PERIOD_MS);
  assert.equal(s.error, true, "確かめられなかったことを画面に伝える");
});

test("T-PRO-02c キャッシュが無いときの通信の失敗は、無料版", async () => {
  const { lm } = setup({ fail: true });
  const s = await lm.getLicenseState();
  assert.equal(s.source, "none");
  assert.equal(s.paid, false);
  assert.equal(s.checkedAt, null);
  assert.equal(s.error, true);
});

// ---- T-PRO-03 未購入 -------------------------------------------------------------------
test("T-PRO-03 未購入なら無料版で、結果をキャッシュに残す", async () => {
  const { lm, deps } = setup({ user: unpaidUser() });
  const s = await lm.getLicenseState();
  assert.equal(s.source, "network");
  assert.equal(s.paid, false);
  assert.equal(s.pro, false);
  assert.equal(s.plan, null);
  assert.equal(s.email, null);
  assert.deepEqual(deps.storage.data[LICENSE_CACHE_KEY], { paid: false, plan: null, email: null, checkedAt: T0, trialEndsAt: T0 - 30 * DAY + TRIAL_PERIOD_MS });
  assert.equal(await lm.isPro(), false);
});

test("T-PRO-03b 購入済みなら Pro で、プランとメールを残す", async () => {
  const { lm, deps } = setup({ user: paidUser() });
  const s = await lm.getLicenseState();
  assert.equal(s.pro, true);
  assert.equal(deps.storage.data[LICENSE_CACHE_KEY].email, "buyer@example.test");
  assert.equal(deps.storage.data[LICENSE_CACHE_KEY].plan.nickname, "Pro 月額");
  assert.equal(await lm.isPro(), true);
});

// ---- T-PRO-04 お試し (リバーストライアル) -------------------------------------------------------
test("T-PRO-04 インストールから 7 日は Pro (お試し)、過ぎたら無料版 (境界値)", async () => {
  const inTrial = setup({ user: unpaidUser(new Date(T0 - 7 * DAY + 1)) });
  const a = await inTrial.lm.getLicenseState();
  assert.equal(a.paid, false);
  assert.equal(a.trial, true);
  assert.equal(a.pro, true);
  assert.equal(a.trialEndsAt, T0 + 1);

  const ended = setup({ user: unpaidUser(new Date(T0 - 7 * DAY)) });
  const b = await ended.lm.getLicenseState();
  assert.equal(b.trial, false);
  assert.equal(b.pro, false);
});

test("T-PRO-04b キャッシュから返すときも、お試しの終わりは今の時刻で判断する", async () => {
  const cached = { paid: false, plan: null, email: null, checkedAt: T0 - 30 * 60 * 1000, trialEndsAt: T0 - 1 };
  const { lm, extpay } = setup({ storage: { [LICENSE_CACHE_KEY]: cached } });
  const s = await lm.getLicenseState();
  assert.equal(extpay.calls.getUser, 0);
  assert.equal(s.trial, false);
  assert.equal(s.pro, false);
});

// ---- T-PRO-05 ID が仮のまま ------------------------------------------------------------------
test("T-PRO-05 ID が仮の文字列なら、ExtPay を作らず、通信せず、無料版を返す", async () => {
  const { lm, made, deps } = setup({ id: "{{EXTPAY_ID}}" });
  lm.initLicense();
  const s = await lm.getLicenseState({ refresh: true });
  assert.equal(made(), 0, "ExtPay を作らない");
  assert.equal(s.source, "unconfigured");
  assert.equal(s.pro, false);
  assert.equal(s.configured, false);
  assert.equal(deps.alarms.created.length, 0, "アラームも作らない");
  assert.equal(deps.storage.data[LICENSE_CACHE_KEY], undefined, "何も残さない");
});

// ---- T-PRO-06 アラーム -----------------------------------------------------------------------
test("T-PRO-06 再確認のアラームは、無いときだけ 60 分おきで作る", async () => {
  const fresh = setup();
  fresh.lm.initLicense();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(fresh.deps.alarms.created, [{ name: "license-revalidate", periodInMinutes: 60 }]);
  assert.equal(fresh.extpay.calls.startBackground, 1);

  const restarted = setup({ alarms: [{ name: "license-revalidate", periodInMinutes: 60 }] });
  restarted.lm.initLicense();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(restarted.deps.alarms.created, [], "Service Worker が起き直しても、時計を戻さない");
});

test("T-PRO-06b アラームが鳴ると確かめ直す。ほかのアラームでは何もしない", async () => {
  const { lm, deps, extpay } = setup({ user: paidUser() });
  lm.initLicense();
  const [onAlarm] = deps.alarms.listeners;
  await onAlarm({ name: "something-else" });
  assert.equal(extpay.calls.getUser, 0);
  await onAlarm({ name: "license-revalidate" });
  assert.equal(extpay.calls.getUser, 1);
  assert.equal(deps.storage.data[LICENSE_CACHE_KEY].paid, true);
});

// ---- T-PRO-07 メッセージ -----------------------------------------------------------------------
function send(deps, message, sender) {
  return new Promise((resolve) => {
    let replied = false;
    let keepOpen = false;
    for (const fn of deps.runtime.messageListeners) {
      const r = fn(message, sender, (resp) => { replied = true; resolve(resp); });
      if (r === true) keepOpen = true;
    }
    if (!keepOpen && !replied) resolve(undefined);
  });
}
const POPUP = { id: EXT_ID, url: EXT_BASE + "popup.html" };
const OPTIONS = { id: EXT_ID, url: EXT_BASE + "options.html#log", tab: { id: 3, url: EXT_BASE + "options.html#log" } };
const SC_FRAME = { id: EXT_ID, url: EXT_BASE + "secure-composer/secure-composer.html", tab: { id: 7, url: "https://chatgpt.com/" } };
const CONTENT = { id: EXT_ID, url: "https://claude.ai/new", tab: { id: 7, url: "https://claude.ai/new" } };
const OTHER_EXT = { id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", url: "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/popup.html" };

test("T-PRO-07 license:get は拡張機能のページと content script に答える。画面以外には Pro かどうかだけを返す", async () => {
  const { lm, deps } = setup({ user: paidUser() });
  lm.initLicense();
  const a = await send(deps, { type: "license:get" }, POPUP);
  assert.equal(a.pro, true);
  assert.equal(a.email, "buyer@example.test", "画面には全部を返す");
  for (const sender of [CONTENT, SC_FRAME]) {
    const b = await send(deps, { type: "license:get" }, sender);
    assert.deepEqual(Object.keys(b).sort(), ["configured", "pro", "source", "trial"], sender.url);
    assert.equal(b.pro, true);
  }
  const c = await send(deps, { type: "license:get" }, OTHER_EXT);
  assert.equal(c, undefined, "ほかの拡張機能には答えない");
});

test("T-PRO-07b 購入とログインのページは、ポップアップと設定画面からの依頼でだけ開く", async () => {
  const { lm, deps, extpay } = setup();
  lm.initLicense();
  for (const sender of [CONTENT, SC_FRAME]) {
    assert.deepEqual(await send(deps, { type: "license:openPayment" }, sender), { ok: false }, sender.url);
    assert.deepEqual(await send(deps, { type: "license:openLogin" }, sender), { ok: false }, sender.url);
  }
  assert.equal(extpay.calls.openPaymentPage + extpay.calls.openLoginPage, 0);
  assert.deepEqual(await send(deps, { type: "license:openPayment" }, POPUP), { ok: true });
  assert.deepEqual(await send(deps, { type: "license:openLogin" }, OPTIONS), { ok: true });
  assert.equal(extpay.calls.openPaymentPage, 1);
  assert.equal(extpay.calls.openLoginPage, 1);
});

test("T-PRO-07e ページを開けなかった (API キーを作る通信の失敗) ときは、画面に失敗を返す", async () => {
  const { lm, deps } = setup({ openFails: true });
  lm.initLicense();
  assert.deepEqual(await send(deps, { type: "license:openPayment" }, POPUP), { ok: false, reason: "network" });
  assert.deepEqual(await send(deps, { type: "license:openLogin" }, POPUP), { ok: false, reason: "network" });
});

test("T-PRO-07f content script からの refresh は聞かない (ページを開くたびに通信させない)", async () => {
  const cached = { paid: false, plan: null, email: null, checkedAt: T0 - 60 * 1000, trialEndsAt: null };
  const { lm, deps, extpay } = setup({ storage: { [LICENSE_CACHE_KEY]: cached } });
  lm.initLicense();
  await send(deps, { type: "license:get", refresh: true }, CONTENT);
  assert.equal(extpay.calls.getUser, 0);
});

// ---- 通信の待ち方 ------------------------------------------------------------------------
test("T-PRO-13 キャッシュが古いとき、同時の問い合わせでも ExtPay への確認は 1 回だけ", async () => {
  const cached = { paid: true, plan: PLAN, email: "buyer@example.test", checkedAt: T0 - 2 * HOUR, trialEndsAt: null };
  const { lm, extpay } = setup({ storage: { [LICENSE_CACHE_KEY]: cached }, user: paidUser() });
  const [a, b, c] = await Promise.all([lm.getLicenseState(), lm.getLicenseState(), lm.getLicenseState({ refresh: true })]);
  assert.equal(extpay.calls.getUser, 1);
  assert.ok([a, b, c].every((s) => s.paid === true && s.source === "network"));
});

test("T-PRO-14 ExtPay が返らないときは、時間切れを通信の失敗として扱う (7 日以内なら猶予)", async () => {
  const cached = { paid: true, plan: PLAN, email: "buyer@example.test", checkedAt: T0 - 2 * HOUR, trialEndsAt: null };
  const { lm } = setup({ storage: { [LICENSE_CACHE_KEY]: cached }, hang: true, networkTimeoutMs: 20 });
  const s = await lm.getLicenseState();
  assert.equal(s.source, "grace");
  assert.equal(s.pro, true);
  assert.equal(s.error, true);
});

test("T-PRO-14b 時間切れのあとも、問い合わせが返るまでは新しく始めない (同時に 1 本だけ)", async () => {
  const cached = { paid: true, plan: PLAN, email: "buyer@example.test", checkedAt: T0 - 2 * HOUR, trialEndsAt: null };
  const { lm, extpay } = setup({ storage: { [LICENSE_CACHE_KEY]: cached }, hang: true, networkTimeoutMs: 20 });
  assert.equal((await lm.getLicenseState()).source, "grace");
  assert.equal((await lm.getLicenseState({ refresh: true })).source, "grace", "2 回目も時間切れで答える");
  assert.equal(extpay.calls.getUser, 1, "返らない問い合わせがあるあいだは、次を始めない");
});

test("T-PRO-15 content script には、7 日以内のキャッシュをすぐ返し、古ければ裏で確かめ直す", async () => {
  const cached = { paid: true, plan: PLAN, email: "buyer@example.test", checkedAt: T0 - 2 * HOUR, trialEndsAt: null };
  // ExtPay は返らない。通信を待っていたら、時間切れのあとの答え (source "grace"、error) になる。時計では測らない
  const { lm, deps, extpay } = setup({ storage: { [LICENSE_CACHE_KEY]: cached }, hang: true, networkTimeoutMs: 300 });
  lm.initLicense();
  const b = await send(deps, { type: "license:get" }, CONTENT);
  assert.deepEqual(b, { pro: true, trial: false, configured: true, source: "stale" }, "通信を待たずに、キャッシュから答える");
  assert.equal(extpay.calls.getUser, 1, "裏で確かめ直しを始める");
});

test("T-PRO-15b 画面にも、refresh でなければ 7 日以内のキャッシュをすぐ返す。refresh なら確かめ直しを待つ", async () => {
  const cached = { paid: true, plan: PLAN, email: "buyer@example.test", checkedAt: T0 - 2 * HOUR, trialEndsAt: null };
  const { lm, deps, extpay } = setup({ storage: { [LICENSE_CACHE_KEY]: cached }, user: unpaidUser() });
  lm.initLicense();
  const a = await send(deps, { type: "license:get" }, POPUP);
  assert.equal(a.source, "stale");
  assert.equal(a.paid, true);
  assert.equal(extpay.calls.getUser, 1, "裏で確かめ直しを始める");
  await new Promise((r) => setTimeout(r, 0));
  const b = await send(deps, { type: "license:get", refresh: true }, POPUP);
  assert.equal(b.source, "network");
  assert.equal(b.paid, false);
});

test("T-PRO-07g ページを開く待ちにも時間切れがある (ExtPay が返らないとき)", async () => {
  const { lm, deps } = setup({ openHang: true, networkTimeoutMs: 20 });
  lm.initLicense();
  assert.deepEqual(await send(deps, { type: "license:openPayment" }, POPUP), { ok: false, reason: "timeout" });
});

test("T-PRO-16 最後に確かめた日時が未来 (時計が戻った) なら、古いものとして確かめ直す", async () => {
  const cached = { paid: true, plan: PLAN, email: "buyer@example.test", checkedAt: T0 + 3 * DAY, trialEndsAt: null };
  const { lm, extpay } = setup({ storage: { [LICENSE_CACHE_KEY]: cached }, fail: true });
  const s = await lm.getLicenseState();
  assert.equal(extpay.calls.getUser, 1);
  assert.equal(s.source, "none", "未来の日時は猶予の根拠にしない");
  assert.equal(s.pro, false);
});

test("T-PRO-06c 間隔の違う古いアラームは、今の間隔で作り直す", async () => {
  const { lm, deps } = setup({ alarms: [{ name: "license-revalidate", periodInMinutes: 30 }] });
  lm.initLicense();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(deps.alarms.created, [{ name: "license-revalidate", periodInMinutes: 60 }]);
});

test("T-PRO-07c ID が仮なら、購入とログインのページを開かずに断る", async () => {
  const { lm, deps } = setup({ id: "{{EXTPAY_ID}}" });
  lm.initLicense();
  assert.deepEqual(await send(deps, { type: "license:openPayment" }, POPUP), { ok: false, reason: "unconfigured" });
});

test("T-PRO-07d license: で始まらないメッセージには関わらない (ほかの受け手の邪魔をしない)", async () => {
  const { lm, deps } = setup();
  lm.initLicense();
  const results = deps.runtime.messageListeners.map((fn) => fn({ type: "GET_TAB_COUNT", tabId: 1 }, POPUP, () => { throw new Error("答えてはいけない"); }));
  assert.ok(results.every((r) => r !== true));
});
