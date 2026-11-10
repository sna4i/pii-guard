// license/license-view.js — ポップアップと設定画面に出すライセンスの表示 (docs/pro-license.md の F-PRO-07、D-PRO-10)
//
// describeLicense(state, now) は、license:get の答え (license/license.js の getLicenseState()) から、
// 画面に出す文と、押せるボタンを決める。chrome の API は使わない (node のテストからも読む)。
// 画面は普通のスクリプトとして読み込み、window.PiiGuardLicenseView から使う。
"use strict";

(function attach(root) {
  const DAY = 24 * 60 * 60 * 1000;

  function planName(plan) {
    return plan && typeof plan.nickname === "string" && plan.nickname.trim() ? plan.nickname.trim() : "";
  }
  function formatDateTime(ms) {
    return new Date(ms).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  // Pro の表示を出さないとき。ExtensionPay に登録する前 (ID が仮) と、Service Worker から答えが無いとき (D-PRO-12)
  const HIDDEN = { visible: false, status: "", note: "", tone: "free", canUpgrade: false, canLogin: false, canRefresh: false };

  /**
   * @returns {{ visible: boolean, status: string, note: string, tone: "pro"|"free"|"warn", canUpgrade: boolean, canLogin: boolean, canRefresh: boolean }}
   */
  function describeLicense(state, now = Date.now()) {
    if (!state || typeof state !== "object" || state.configured !== true) return { ...HIDDEN };
    let status = "無料版";
    let tone = "free";
    if (state.paid) {
      const name = planName(state.plan);
      status = name ? `Pro (${name})` : "Pro";
      tone = "pro";
    } else if (state.trial && typeof state.trialEndsAt === "number") {
      const days = Math.max(1, Math.ceil((state.trialEndsAt - now) / DAY));
      status = `Pro (お試し中、あと ${days} 日)`;
      tone = "pro";
    }
    let note = "";
    if (state.error) {
      note = typeof state.checkedAt === "number"
        ? `購入状態を確認できませんでした (最後に確認: ${formatDateTime(state.checkedAt)})`
        : "購入状態を確認できませんでした";
      if (tone === "free") tone = "warn";
    }
    return { visible: true, status, note, tone, canUpgrade: !state.paid, canLogin: !state.paid, canRefresh: true };
  }

  /**
   * 購入・ログインのページを開く依頼が失敗したときの注記 (license:openPayment / license:openLogin の reason)。
   * 時間切れ ("timeout") のときは、ExtPay の通信がそのあとで返って、ページが開くこともある。
   * 別のページを開いている途中 ("busy") のときは、ExtPay を呼んでいない
   * @param {string|undefined} reason
   * @returns {string}
   */
  function describeOpenFailure(reason) {
    if (reason === "timeout") return "決済サービスから返事がありません。しばらく待っても開かないときは、もう一度押してください";
    // 購入とログインのページは同時に 1 つだけ頼む (license/license.js の openPage。D-PRO-04)
    if (reason === "busy") return "別のページを開いているところです。開いてから、もう一度押してください";
    return "ページを開けませんでした";
  }

  const api = { describeLicense, describeOpenFailure };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.PiiGuardLicenseView = api;
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
