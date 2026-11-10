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
// ExtPay の fetch には時間切れが無いので、ここで切る (D-PRO-11)
export const NETWORK_TIMEOUT_MS = 10 * 1000;
// 購入とログインのページを開く依頼と、確かめ直し (refresh) を受ける画面 (D-PRO-04)
const UI_PAGES = ["popup.html", "options.html"];

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
export function createLicenseManager({ extpayId, makeExtPay, storage, alarms, runtime, now = () => Date.now(), networkTimeoutMs = NETWORK_TIMEOUT_MS }) {
  const configured = !isPlaceholderId(extpayId);
  const uiPages = new Set(UI_PAGES.map((p) => runtime.getURL(p)));
  // 送り手がポップアップか設定画面か (#log などは除いて比べる)。content script と保護入力欄の iframe は違う
  const isUiPage = (sender) => typeof sender.url === "string" && uiPages.has(sender.url.split(/[?#]/)[0]);
  let extpay = null;
  let inflight = null;
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

  // 待つのは networkTimeoutMs まで。p そのものは止めない (ExtPay の fetch には中断が無い)
  function withTimeout(p) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("license: timeout"), { code: "timeout" })), networkTimeoutMs);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  // ExtPay への問い合わせは同時に 1 本だけ。時間切れは通信の失敗として扱うが、問い合わせは返るまで残り、
  // そのあいだの確かめ直しも同じ問い合わせを待つ (新しく始めない)。時間切れのあとで答えが届けば、
  // キャッシュが書き換わり、storage の変化で画面と content script に伝わる (D-PRO-11)
  function revalidateOnce() {
    if (!inflight) inflight = revalidate().finally(() => { inflight = null; });
    return withTimeout(inflight);
  }

  // 最後に確かめてからの時間。未来の日時 (時計が戻った) は、古いものとして扱う
  const ageOf = (cached) => {
    if (!cached || typeof cached.checkedAt !== "number") return Infinity;
    const age = now() - cached.checkedAt;
    return age >= 0 ? age : Infinity;
  };

  // preferCache: 7 日以内のキャッシュがあれば通信を待たずに返し、60 分を過ぎていれば裏で確かめ直す
  // (ページやポップアップを開くたびに通信を待たせない。D-PRO-11)。refresh なら必ず確かめ直しを待つ
  async function getLicenseState({ refresh = false, preferCache = false } = {}) {
    if (!configured) return unconfiguredState();
    const cached = await readCache();
    const age = ageOf(cached);
    if (!refresh && age < REVALIDATE_INTERVAL_MS) return withDerived(cached, "cache");
    if (!refresh && preferCache && age < GRACE_PERIOD_MS) {
      revalidateOnce().catch(() => {});
      return withDerived(cached, "stale");
    }
    try {
      return await revalidateOnce();
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
  // 鳴らなくなるので、無いとき (と、間隔が今と違うとき) だけ作る (D-PRO-03)
  function ensureAlarm() {
    Promise.resolve(alarms.get(ALARM_NAME))
      .then((a) => { if (!a || a.periodInMinutes !== REVALIDATE_INTERVAL_MIN) alarms.create(ALARM_NAME, { periodInMinutes: REVALIDATE_INTERVAL_MIN }); })
      .catch(() => {});
  }

  // 画面以外 (content script、保護入力欄) に返すのは、Pro かどうかだけ。メールやプランはサイトの近くに出さない
  const forEngine = (s) => ({ pro: s.pro, trial: s.trial, configured: s.configured, source: s.source });

  function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("license:")) return false;
    if (!sender || sender.id !== runtime.id) return false;
    const fromUi = isUiPage(sender);
    if (msg.type === "license:get") {
      // 確かめ直し (refresh) は画面のボタンからだけ。それ以外は、画面にも content script にもキャッシュを先に返す
      getLicenseState({ refresh: msg.refresh === true && fromUi, preferCache: true })
        .then((s) => sendResponse(fromUi ? s : forEngine(s)),
          () => { const s = { ...withDerived(FREE, "none"), error: true }; sendResponse(fromUi ? s : forEngine(s)); });
      return true;
    }
    if (msg.type === "license:openPayment" || msg.type === "license:openLogin") {
      // ページを開く依頼は、ポップアップと設定画面からだけ受ける (D-PRO-04)
      if (!fromUi) { sendResponse({ ok: false }); return false; }
      const ep = getExtPay();
      if (!ep) { sendResponse({ ok: false, reason: "unconfigured" }); return false; }
      // ExtPay は API キーを作る通信のあとでページを開く。失敗したら画面に伝える。通信が返らないときも
      // networkTimeoutMs で答える (ページは、そのあとで開くこともある)
      withTimeout(Promise.resolve().then(() => (msg.type === "license:openPayment" ? ep.openPaymentPage() : ep.openLoginPage())))
        .then(() => sendResponse({ ok: true }),
          (e) => sendResponse({ ok: false, reason: e && e.code === "timeout" ? "timeout" : "network" }));
      return true;
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
      if (a && a.name === ALARM_NAME) return revalidateOnce().catch(() => {});
      return undefined;
    });
    runtime.onInstalled.addListener(() => { revalidateOnce().catch(() => {}); });
  }

  return { initLicense, getLicenseState, isPro, revalidate: revalidateOnce };
}
