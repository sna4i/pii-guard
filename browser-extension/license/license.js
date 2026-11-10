// license/license.js — Pro 版のライセンス管理 (docs/pro-license.md の F-PRO-02〜05、F-PRO-08、F-PRO-09)
//
// 購入状態 (ExtensionPay の getUser()) を chrome.storage.local の licenseState に残し、Pro かどうかを
// ここだけで決める。課金の仕組みを替えるときは、このファイルだけを替える。
// - 外との通信は ExtPay の getUser() / ページを開く操作だけ。本文や検出結果は扱わない
// - ExtPay・storage・alarms・runtime・時計は引数で受ける (テストで偽物に替えるため。D-PRO-02)
// - Pro = 購入済み、またはお試しの期間中 (インストールから 7 日。D-PRO-08)

export const LICENSE_CACHE_KEY = "licenseState";
export const ALARM_NAME = "license-revalidate";
export const REVALIDATE_INTERVAL_MIN = 60;
export const REVALIDATE_INTERVAL_MS = REVALIDATE_INTERVAL_MIN * 60 * 1000;
export const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
export const TRIAL_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/** ExtensionPay に登録する前の仮の ID ("{{" で始まる) か */
export function isPlaceholderId(id) {
  return typeof id !== "string" || id === "" || id.startsWith("{{");
}

// Date・数値・日時の文字列をミリ秒に。読めなければ null
function toMs(v) {
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {{
 *   extpayId: string,
 *   makeExtPay: (id: string) => { getUser(): Promise<object>, startBackground(): void, openPaymentPage(): Promise<void>, openLoginPage(): Promise<void> },
 *   storage: { get(key: string): Promise<object>, set(obj: object): Promise<void> },
 *   alarms: { get(name: string): Promise<object|undefined>, create(name: string, info: object): void, onAlarm: { addListener(fn: Function): void } },
 *   runtime: { id: string, getURL(path: string): string, onMessage: { addListener(fn: Function): void }, onInstalled: { addListener(fn: Function): void } },
 *   now?: () => number,
 * }} deps
 */
export function createLicenseManager({ extpayId, makeExtPay, storage, alarms, runtime, now = () => Date.now() }) {
  const configured = !isPlaceholderId(extpayId);
  const extBase = runtime.getURL("");
  let extpay = null;
  // ExtPay は ID が決まっているときだけ、最初に要るときに作る (仮の ID のまま作ると、存在しない宛先に通信しうる)
  const getExtPay = () => {
    if (!configured) return null;
    if (!extpay) extpay = makeExtPay(extpayId);
    return extpay;
  };

  // 残す形 { paid, plan, email, checkedAt, trialEndsAt } に、画面とエンジンが使う値を足す。お試しは今の時刻で判断する
  function withDerived(state, source, extra = {}) {
    const trial = !state.paid && typeof state.trialEndsAt === "number" && now() < state.trialEndsAt;
    return { ...state, source, configured, trial, pro: !!state.paid || trial, ...extra };
  }
  const FREE = { paid: false, plan: null, email: null, checkedAt: null, trialEndsAt: null };
  const unconfiguredState = () => withDerived(FREE, "unconfigured");

  async function readCache() {
    const got = await storage.get(LICENSE_CACHE_KEY);
    const c = got && got[LICENSE_CACHE_KEY];
    return c && typeof c === "object" ? c : null;
  }

  async function revalidate() {
    const ep = getExtPay();
    if (!ep) return unconfiguredState();
    const user = await ep.getUser();
    const installedAt = toMs(user && user.installedAt);
    const state = {
      paid: !!(user && user.paid),
      plan: (user && user.plan) ?? null,
      email: (user && user.email) ?? null,
      checkedAt: now(),
      trialEndsAt: installedAt === null ? null : installedAt + TRIAL_PERIOD_MS,
    };
    await storage.set({ [LICENSE_CACHE_KEY]: state });
    return withDerived(state, "network");
  }

  async function getLicenseState({ refresh = false } = {}) {
    if (!configured) return unconfiguredState();
    const cached = await readCache();
    const age = cached && typeof cached.checkedAt === "number" ? now() - cached.checkedAt : Infinity;
    if (!refresh && age < REVALIDATE_INTERVAL_MS) return withDerived(cached, "cache");
    try {
      return await revalidate();
    } catch (_) {
      // 通信の失敗。最後に確かめてから 7 日以内の購入済みは信じる (有料の人を締め出さない。F-PRO-04)
      if (cached && cached.paid && age < GRACE_PERIOD_MS) return withDerived(cached, "grace", { error: true });
      return withDerived({ ...FREE, checkedAt: cached ? cached.checkedAt ?? null : null, trialEndsAt: cached ? cached.trialEndsAt ?? null : null }, "none", { error: true });
    }
  }

  async function isPro() {
    return (await getLicenseState()).pro;
  }

  // Service Worker は 30 秒ほどで止まり、起動のたびにここを通る。create し直すと 60 分の時計が戻されて
  // 鳴らなくなるので、無いときだけ作る (D-PRO-03)
  function ensureAlarm() {
    Promise.resolve(alarms.get(ALARM_NAME))
      .then((a) => { if (!a) alarms.create(ALARM_NAME, { periodInMinutes: REVALIDATE_INTERVAL_MIN }); })
      .catch(() => {});
  }

  function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("license:")) return false;
    if (!sender || sender.id !== runtime.id) return false;
    // 拡張機能のページ (ポップアップ・設定画面・保護入力欄) か。content script の sender.url はサイトの URL
    const fromExtensionPage = typeof sender.url === "string" && sender.url.startsWith(extBase);
    if (msg.type === "license:get") {
      // 確かめ直し (refresh) は画面のボタンから。content script はページを開くたびに聞くので、キャッシュを使わせる
      getLicenseState({ refresh: msg.refresh === true && fromExtensionPage })
        .then(sendResponse, () => sendResponse({ ...withDerived(FREE, "none"), error: true }));
      return true;
    }
    if (msg.type === "license:openPayment" || msg.type === "license:openLogin") {
      // ページを開く依頼は、拡張機能のページからだけ受ける (D-PRO-04)
      if (!fromExtensionPage) { sendResponse({ ok: false }); return false; }
      const ep = getExtPay();
      if (!ep) { sendResponse({ ok: false, reason: "unconfigured" }); return false; }
      Promise.resolve(msg.type === "license:openPayment" ? ep.openPaymentPage() : ep.openLoginPage()).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }
    return false;
  }

  // Service Worker の最上位で 1 回だけ呼ぶ (ExtPay の startBackground() も同じ決まり)
  function initLicense() {
    runtime.onMessage.addListener(onMessage);
    if (!configured) return;
    getExtPay().startBackground();
    ensureAlarm();
    alarms.onAlarm.addListener((a) => {
      if (a && a.name === ALARM_NAME) return revalidate().catch(() => {});
      return undefined;
    });
    runtime.onInstalled.addListener(() => { revalidate().catch(() => {}); });
  }

  return { initLicense, getLicenseState, isPro, revalidate };
}
