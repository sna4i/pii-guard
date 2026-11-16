// secure-composer.js — 保護入力欄 (iframe、拡張オリジン) の本体。
//
// 役割:
//   - 原文は textarea のメモリにだけ持つ。ページには一切渡さない (INV-1)。
//   - マスキングは iframe 内のエンジンで行う。除外リスト等の機密は chrome.storage から
//     直接読むので MAIN world に出ない (V-02/V-03 の解消, INV-4)。
//   - 送信操作 (Enter / content script からの submit 要求) のときだけ、マスク済み(ON)/
//     原文(OFF) を content script に渡して正規送信させる。失敗時は下書きを残し止める (INV-2)。
//   - 状態は composer-state.js。<html data-state> に写してテストから観測できる。
"use strict";
(() => {
  const NS = window.__localMaskMCP || (window.__localMaskMCP = {});
  const SC = window.__piiGuardSC || {};
  const boundary = SC.boundary.connect("sc-iframe");
  const machine = SC.state.create("INITIALIZING");
  const leak = window.PiiGuardLeakDetector;
  const editor = document.getElementById("editor");
  const statusEl = document.getElementById("status");
  const confirmEl = document.getElementById("confirm");
  const confirmMsg = document.getElementById("confirm-msg");
  const confirmSendBtn = document.getElementById("confirm-send");
  const confirmCancelBtn = document.getElementById("confirm-cancel");
  const rootEl = document.documentElement;

  // proCustomRules: Pro のカスタムルール (キーは engine/custom-rules.js の STORAGE_KEY と同じ)。
  // customBudgetMs・proWaitMs: E2E のときだけ (__pii_guard_e2e が true)、カスタムルールの時間の上限
  // (__pii_guard_e2e_custom_budget_ms) と、Pro かどうかの答えを待つ上限 (__pii_guard_e2e_pro_wait_ms) を上書きする値
  // (時間切れや、答えを待つあいだを確かめるため)
  const settings = { enabled: true, maskForceList: [], maskAllowlist: [], mlEnabled: false, piiSendWarning: true, proCustomRules: null, customBudgetMs: null, proWaitMs: null };
  const SETTING_KEYS = ["enabled", "maskForceList", "maskAllowlist", "mlEnabled", "piiSendWarning", "proCustomRules", "__pii_guard_e2e", "__pii_guard_e2e_custom_budget_ms", "__pii_guard_e2e_pro_wait_ms"];
  // 動作ログ (docs/diagnostic-log.md)。件数や理由だけで、文章は残さない
  const DLG = window.PiiGuardDiagLog;
  const dl = (code, d) => { if (DLG) DLG.log(code, d); };
  const errorFields = (e) => (DLG ? DLG.errorFields(e, "secure-composer") : {});
  if (DLG) DLG.captureErrors("secure-composer");
  let composing = false;         // IME 変換中
  let lastReportedHeight = 0;
  let lastReportedEmpty = true;
  // 高さの上限 (px)。iframe の中の vh や innerHeight は iframe 自身の高さなので、ページ側 (アダプタ) が
  // 画面の高さから測って theme で渡す (docs/release-1.7.1.md の D-SC-02)。届くまではこの値
  let maxHeight = 320;

  machine.onChange((state) => {
    rootEl.dataset.state = state;
    boundary.post("state", { state });
  });
  function setStatus(msg) { statusEl.textContent = msg || ""; statusEl.classList.remove("busy"); }

  // ---- 設定 (chrome.storage から直接。ページを経由しない) ----------------------
  async function readSettings() {
    try {
      const s = await chrome.storage.local.get(SETTING_KEYS);
      settings.enabled = s.enabled !== false;
      settings.mlEnabled = s.mlEnabled === true;
      settings.piiSendWarning = s.piiSendWarning !== false; // 既定 ON: PII を見つけたら送信前に確認
      settings.maskForceList = Array.isArray(s.maskForceList)
        ? s.maskForceList.map((e) => (typeof e === "string" ? { value: e, category: "OTHER" }
            : e && typeof e.value === "string" ? { value: e.value, category: typeof e.category === "string" ? e.category : "OTHER" } : null)).filter(Boolean)
        : [];
      settings.maskAllowlist = Array.isArray(s.maskAllowlist) ? s.maskAllowlist.filter((v) => typeof v === "string") : [];
      settings.proCustomRules = s.proCustomRules && typeof s.proCustomRules === "object" ? s.proCustomRules : null;
      settings.customBudgetMs = s.__pii_guard_e2e === true && Number.isFinite(s.__pii_guard_e2e_custom_budget_ms) ? s.__pii_guard_e2e_custom_budget_ms : null;
      settings.proWaitMs = s.__pii_guard_e2e === true && Number.isFinite(s.__pii_guard_e2e_pro_wait_ms) ? s.__pii_guard_e2e_pro_wait_ms : null;
    } catch (_) { /* 既定のまま */ }
  }
  // 読み直すたびに、Pro のカスタムルールをエンジンに渡す (applyCustomRules)。待ち合わせの列 (applyingCustomRules) は
  // 読み始める前に差し替えるので、読み終えて渡し終えるまで、maskText は伏せない (customRulesReady)
  function loadSettings() {
    const read = readSettings();
    const version = customRulesVersion;
    applyingCustomRules = applyingCustomRules.then(() => read).then(() => applyCustomRules(version)).catch((e) => { dl("error", errorFields(e)); });
    return read;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("licenseState" in changes) refreshPro();
    if ("proCustomRules" in changes) customRulesVersion++;
    if (!SETTING_KEYS.some((k) => k in changes)) return;
    // オン/オフやリストが変わったら、オフの警告を出し直す (オフにした直後でも下書きの個人情報で黄色にする)
    loadSettings().then(() => scheduleDraftScan(0));
  });
  // Pro かどうか (docs/pro-license.md の D-PRO-06)。Service Worker のライセンス管理に聞き、この iframe の
  // エンジンに渡す。答えが来るまでは無料版のルールで動く
  // proAnswered: Pro かどうかの答えを受け取ったか (届かない・失敗したあいだは false = 分からない)。
  // firstProAttempt: 最初の問い合わせが終わったこと (答えでも失敗でも)。保存したカスタムルールがあるときだけ、渡す前に待つ
  let proAnswered = false;
  let resolveProAttempt = () => {};
  const firstProAttempt = new Promise((resolve) => { resolveProAttempt = resolve; });
  function refreshPro() {
    try {
      chrome.runtime.sendMessage({ type: "license:get" }, (r) => {
        // 届かない・失敗した問い合わせと、ライセンスの確かめに失敗した答え (source: "none"。7 日以内のキャッシュが無いまま、
        // 通信に失敗したか時間切れ) は、「答えが来ていない」と同じに扱う (Pro でないと分かったわけではない)。Pro かどうかは
        // 前のまま、proAnswered も立てない。保存したルールがあれば、送信は partial と同じに確認へ回り、聞き直しを続ける
        // (ルールが無い人は、どちらに扱っても動きは同じ: Pro にならず、待ちも聞き直しも起きない)
        if (chrome.runtime.lastError || !r || r.source === "none") { resolveProAttempt(); return; }
        const first = !proAnswered;
        proAnswered = true;
        const next = !!(r && r.pro === true);
        const e = NS.engine;
        if (e && typeof e.setProEnabled === "function") {
          const changed = e.isProEnabled() !== next;
          e.setProEnabled(next);
          // Pro の状態が変わったら (どちらの向きでも)、または最初の答えが来たら (分からなかったあいだの扱いを外す)、
          // カスタムルールを渡し直す
          const version = customRulesVersion;
          if (changed || first) applyingCustomRules = applyingCustomRules.then(() => applyCustomRules(version)).catch((err) => { dl("error", errorFields(err)); });
        }
        resolveProAttempt();
      });
    } catch (_) { resolveProAttempt(); /* 拡張機能が入れ替わった直後など */ }
  }

  // ---- Pro のカスタムルール (Pro Phase 2 の設計 (P1)) ------------------------------------
  // 保存したルールを、この iframe のエンジンに渡す (Pro でなければ空)。組み立てと温め (setCustomRules) は上限いっぱいで
  // 0.9 秒ほどかかるので、送るたびではなく、設定と Pro の状態が変わったときに行い、最後に渡したもの (Pro かどうかと、
  // ルールの版) と同じなら組み立て直さない (オン/オフなど、ほかの設定が変わったときにも読み直すため)。渡すのは 1 本の列に
  // 並べ (applyingCustomRules)、maskText は、エンジンを動かす前に列が空くのを待つ (読んだのにまだ渡していない状態で、伏せない)
  let applyingCustomRules = Promise.resolve();
  let customRulesVersion = 0; // proCustomRules が変わるたびに増やす
  let appliedCustomRules = null; // 最後に渡したもの ("off" か "pro:<版>")
  // ルールがあるのに、待っても Pro かどうか分からない (答えが待つ上限までに来ない・問い合わせに失敗した)。
  // ルールを当てられないので、maskText は時間切れ (custom.status の partial) と同じに扱う
  let customRulesUnknown = false;
  const hasEnabledCustomRule = (v) => !!(v && Array.isArray(v.rules) && v.rules.some((r) => r && typeof r === "object" && r.enabled !== false));
  async function applyCustomRules(version) {
    const stored = settings.proCustomRules;
    const has = hasEnabledCustomRule(stored);
    // ルールがあるのに、Pro かどうかの答えがまだなら待つ (ルールの無い人は待たせない)。上限は 3 秒 (E2E の上書きあり)
    if (has) await Promise.race([firstProAttempt, new Promise((r) => setTimeout(r, settings.proWaitMs ?? 3000))]);
    customRulesUnknown = has && !proAnswered;
    const e = NS.engine;
    if (!e || typeof e.setCustomRules !== "function") return;
    const on = e.isProEnabled() && has;
    const key = on ? `pro:${version}` : "off";
    if (key === appliedCustomRules) return;
    e.setCustomRules(on ? stored.rules : []);
    appliedCustomRules = key;
  }
  // 列が空くまで待つ (待っているあいだに次の読み直しが並んだら、それも待つ)。Pro かどうか分からないままなら true を返す。
  // そのときは、答えが来るよう聞き直す (5 秒に 1 回まで。届かなかった問い合わせのあとも、いつかは今どおりに戻るように)
  let lastProRetry = 0;
  async function customRulesReady() {
    let last;
    do { last = applyingCustomRules; await last; } while (last !== applyingCustomRules);
    if (customRulesUnknown && Date.now() - lastProRetry > 5000) { lastProRetry = Date.now(); refreshPro(); }
    return customRulesUnknown;
  }
  // カスタムルールの時間の上限 (送る前の上限 LIMITS.sendBudgetMs。E2E のときだけ上書きできる)
  function customBudgetMs() {
    if (settings.customBudgetMs !== null) return settings.customBudgetMs;
    const cr = NS.engine && NS.engine.customRules;
    return cr && cr.LIMITS ? cr.LIMITS.sendBudgetMs : undefined;
  }
  refreshPro();
  // 除外リストの値か (F-SC-18、D-SC-06)。常に伏せる語にも入っている値は伏せる
  // (送る前の裏取りは、常に伏せる語の生値が残っていると送信を止めるため)
  function allowedMatcher() {
    const allow = new Set(settings.maskAllowlist);
    const force = new Set(settings.maskForceList.map((e) => e.value));
    return (v) => allow.has(v) && !force.has(v);
  }

  // ---- エンジン待ち ----------------------------------------------------------
  function engineReady() { return !!(NS.engine && NS.engine.ready && typeof NS.engine.maskSanitize === "function"); }
  function waitEngine(timeoutMs) {
    return new Promise((resolve) => {
      if (engineReady()) return resolve(true);
      const iv = setInterval(() => { if (engineReady()) { clearInterval(iv); clearTimeout(to); resolve(true); } }, 40);
      const to = setTimeout(() => { clearInterval(iv); resolve(engineReady()); }, timeoutMs);
    });
  }

  // ---- 見た目 (content script がネイティブ入力欄から測って渡す) -------------------
  // 値が違うときだけ付け直し、何か変わったときだけ高さを測り直す。同じ値の付け直しでも、変換中の文の欄に触ると
  // Windows の IME が状態を戻すことがあるため (D-SC-41)
  function applyTheme(t) {
    if (!t || typeof t !== "object") return;
    let changed = false;
    const set = (k, v) => {
      if (typeof v === "string" && v && rootEl.style.getPropertyValue(k) !== v) { rootEl.style.setProperty(k, v); changed = true; }
    };
    set("--sc-font", t.fontFamily); set("--sc-size", t.fontSize); set("--sc-line", t.lineHeight);
    set("--sc-color", t.color); set("--sc-caret", t.caretColor || t.color); set("--sc-surface", t.surface);
    set("--sc-pad-y", t.padY); set("--sc-pad-x", t.padX); set("--sc-placeholder", t.placeholderColor);
    const attr = (name, v) => { if (typeof v === "string" && editor.getAttribute(name) !== v) { editor.setAttribute(name, v); changed = true; } };
    attr("placeholder", t.placeholder);
    attr("dir", t.dir);
    // ページの明るい/暗い (F-SC-14)。iframe の要素にも同じ値をアダプタが付ける
    if ((t.scheme === "dark" || t.scheme === "light") && rootEl.dataset.scheme !== t.scheme) {
      rootEl.style.colorScheme = t.scheme; rootEl.dataset.scheme = t.scheme; changed = true;
    }
    // ChatGPT の入力欄が伸びない並びでは、アダプタが保護入力欄を上に伸ばす。そのときは文の欄を下 (入力欄の行) に
    // 置き、案内と確認をその上に出す (D-SC-18)
    if ((t.anchor === "bottom" || t.anchor === "top") && rootEl.dataset.anchor !== t.anchor) { rootEl.dataset.anchor = t.anchor; changed = true; }
    if (Number.isFinite(t.maxHeight) && t.maxHeight >= 24 && Math.round(t.maxHeight) !== maxHeight) {
      maxHeight = Math.round(t.maxHeight);
      rootEl.style.setProperty("--sc-max-h", maxHeight + "px");
      changed = true;
    }
    if (changed) autosize();
  }

  // 下書きの高さをアダプタに知らせる。アダプタは ChatGPT の入力欄をこの高さに伸ばし、保護入力欄を重ね直す
  // (D-SC-03)。empty は「空の入力欄だけで、確認や案内も出ていない」(ChatGPT の入力欄を元の高さに戻してよい)
  function autosize() {
    let extra = 0;
    if (confirmEl && !confirmEl.hidden) extra += confirmEl.offsetHeight;      // PII 確認バーのぶん伸ばす
    if (statusEl && getComputedStyle(statusEl).display !== "none") extra += statusEl.offsetHeight;
    editor.style.height = "auto";
    // 確認や案内も上限の中に収める。下書きが長いときは入力欄の中をスクロールさせ、確認のボタンは常に見せる
    // (入力欄の最低の高さは CSS の min-height で 1 行を保つ)
    editor.style.height = Math.min(editor.scrollHeight, Math.max(0, maxHeight - extra)) + "px";
    // 縦のスクロールは、はみ出しが下の余白より大きい (文の行が隠れる) ときだけ許す。高さの端数や余白だけの
    // はみ出しでスクロールバーを出さない (D-SC-19)
    const padB = parseFloat(getComputedStyle(editor).paddingBottom) || 0;
    editor.style.overflowY = editor.scrollHeight - editor.clientHeight > padB + 1 ? "auto" : "hidden";
    const total = Math.ceil(editor.offsetHeight + extra);
    const empty = editor.value === "" && confirmEl.hidden && !statusEl.textContent;
    if (total !== lastReportedHeight || empty !== lastReportedEmpty) {
      lastReportedHeight = total;
      lastReportedEmpty = empty;
      boundary.post("resize", { height: total, empty });
    }
  }

  // Pro のカスタムルールを時間内に当て終えられなかったときの確認の一文 (Pro Phase 2 の設計 (P1))
  const CUSTOM_PARTIAL_NOTICE = "カスタムルールの一部を時間内に調べきれませんでした。";
  // PII 検出時の送信前確認。表示して iframe を伸ばし、ボタンが押されるまで待つ。
  // notice があれば (カスタムルールの時間切れ)、件数の代わりにその一文を出す
  function confirmPii(count, notice) {
    return new Promise((resolve) => {
      confirmMsg.textContent = notice
        ? `${notice}${settings.enabled ? "マスキングして送信しますか?" : "マスキングせずに送信しますか?"}`
        : settings.enabled
        ? `個人情報が ${count} 件見つかりました。マスキングして送信しますか?`
        : `個人情報が ${count} 件含まれています。マスキングせずに送信しますか?`;
      confirmSendBtn.textContent = settings.enabled ? "マスキングして送信" : "このまま送信";
      confirmEl.hidden = false;
      confirmEl.setAttribute("data-show", "1");
      rootEl.dataset.confirm = "1"; // テスト観測用
      autosize();
      const done = (ok) => {
        confirmSendBtn.removeEventListener("click", onSend);
        confirmCancelBtn.removeEventListener("click", onCancel);
        confirmEl.hidden = true;
        confirmEl.removeAttribute("data-show");
        delete rootEl.dataset.confirm;
        autosize();
        resolve(ok);
      };
      // 本物のクリックだけ受ける (iframe はページから触れないが念のため)。
      const onSend = (e) => { if (e.isTrusted) done(true); };
      const onCancel = (e) => { if (e.isTrusted) done(false); };
      confirmSendBtn.addEventListener("click", onSend);
      confirmCancelBtn.addEventListener("click", onCancel);
    });
  }

  // ---- マスキング ------------------------------------------------------------
  async function maskText(text) {
    if (!engineReady()) throw new Error("engine not ready");
    // 保存したカスタムルールを渡し終えてから伏せる (読んだのにまだ渡していない状態で、伏せない)
    const customUnknown = await customRulesReady();
    const res = await NS.engine.maskSanitize(text, {
      userForceMaskEntries: settings.maskForceList,
      mlEnabled: settings.mlEnabled,
      customBudgetMs: customBudgetMs(),
    });
    if (!res || typeof res.sanitized_text !== "string") throw new Error("mask produced no text");
    const all = Array.isArray(res.detections) ? res.detections : [];
    // ML の判定を使えたか (off / ok / timeout / error / unavailable)。時間切れと失敗は呼び手が知らせる (D-SC-10)
    const ml = res.ml && typeof res.ml.status === "string" ? res.ml.status : "off";
    // Pro のカスタムルール (off / ok / partial)。partial (時間切れ) なら、呼び手は必ず確認を出す。
    // ルールがあるのに Pro かどうか分からず、ルールを当てられなかったときも partial と同じに扱う
    const custom = customUnknown ? "partial" : res.custom && typeof res.custom.status === "string" ? res.custom.status : "off";
    // 除外リストの値は伏せない (F-SC-18)。除いたときは、残りの検出だけで伏せ字を作り直す
    const allowed = allowedMatcher();
    const kept = all.filter((d) => !(d && (allowed(String(d.text)) || allowed(text.slice(d.start, d.end)))));
    if (kept.length === all.length) return { text: res.sanitized_text, count: all.length, ml, custom };
    const agg = NS.engine.aggregate;
    if (!agg || typeof agg.applySpans !== "function") throw new Error("engine not ready");
    return { text: agg.applySpans(text, kept), count: kept.length, ml, custom };
  }

  // 0.3 秒より長くかかるときだけ、待っていることを出す。送る前の検出は「確認中…」(F-SC-22、D-SC-11。
  // ML なしなら数ミリ秒で終わる)、送る操作は「送信中…」(D-SC-16。ChatGPT が受け付けるのを確かめる間)
  const BUSY_MS = 300;
  async function withBusyNotice(work, text = "確認中…") {
    const timer = setTimeout(() => { setStatus(text); statusEl.classList.add("busy"); autosize(); }, BUSY_MS);
    try { return await work(); }
    finally {
      clearTimeout(timer);
      if (statusEl.textContent === text) { setStatus(""); autosize(); }
    }
  }

  // ML の判定を使えなかった (時間切れ / 失敗) ときの記録と一言 (F-SC-21、D-SC-10)。
  // 正規表現と辞書の検出だけで伏せたことを利用者に伝える。待つ上限はエンジン (engine/onnx-detector.js) にある
  const ML_WHY = { timeout: "ML の判定が間に合わなかった", error: "ML の判定に失敗した", unavailable: "ML の判定に失敗した" };
  function noteMlSkipped(ml, where, did) {
    const why = ML_WHY[ml];
    if (!why) return;
    dl("ml.skipped", { reason: ml === "timeout" ? "timeout" : "error", where });
    flashStatus(`${why}ので、辞書と正規表現だけで${did}よ。`);
  }

  // ---- オフのときの下書きの警告 (F-SC-16、D-SC-04) ---------------------------------
  // 入力が止まって 0.4 秒後に調べ、種類ごとの件数と、機密と思われる文の件数だけをアダプタに送る。
  // アダプタはアイコン (composer-toggle) に渡す。文章や値は iframe の外に出さない
  const SCAN_MS = 400;
  const SCAN_MAX_CHARS = 20000;
  let scanTimer = 0;
  let scanSeq = 0;
  function scheduleDraftScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanDraft, delay == null ? SCAN_MS : delay);
  }
  async function scanDraft() {
    const seq = ++scanSeq;
    const text = editor.value.slice(0, SCAN_MAX_CHARS);
    const info = { categories: {}, confidential: 0 };
    if (!settings.enabled && text.trim() && engineReady()) {
      try {
        const res = await NS.engine.maskAggregated(text, { userForceMaskEntries: settings.maskForceList, mlEnabled: false });
        const allowed = allowedMatcher();
        for (const row of Array.isArray(res && res.aggregated) ? res.aggregated : []) {
          const v = row && row.value != null ? String(row.value) : "";
          if (!v.trim() || allowed(v)) continue;
          const cat = typeof row.category === "string" ? row.category : "OTHER";
          info.categories[cat] = (info.categories[cat] || 0) + 1;
        }
        info.confidential = Array.isArray(res && res.confidential) ? res.confidential.length : 0;
      } catch (e) { dl("error", errorFields(e)); }
    }
    if (seq !== scanSeq) return; // 調べている間に次の入力が来た
    boundary.post("draftinfo", info);
  }

  // 黄色の内訳の「マスキングする」(F-SC-17、D-SC-05)。下書きを伏せ字にした文に置き換える。
  // 確認画面はページの側 (MAIN world) にあり、下書きを見せると原文がページに渡るので、ここで直接伏せる。
  // 置き換えは編集の操作として行い、Ctrl+Z で元に戻せるようにする
  async function maskDraft() {
    const text = editor.value;
    if (!text.trim() || submitting) return;
    let res;
    try { res = await withBusyNotice(() => maskText(text)); }
    catch (e) {
      dl("error", errorFields(e));
      flashStatus("端末内のマスキングに失敗したよ。下書きはそのまま。");
      return;
    }
    if (editor.value !== text || res.text === text) { scheduleDraftScan(0); return; } // 調べている間に書き換えられた / 伏せる所が無い
    editor.focus();
    editor.select();
    let replaced = false;
    try { replaced = document.execCommand("insertText", false, res.text) && editor.value === res.text; } catch (_) { replaced = false; }
    if (!replaced) editor.value = res.text;
    if (machine.is("SECURE_READY", "SENT", "MASKING_FAILED")) machine.to("EDITING");
    autosize();
    noteMlSkipped(res.ml, "mask-draft", "伏せた");
    scheduleDraftScan(0);
  }

  // ---- 送信 ------------------------------------------------------------------
  let submitting = false;
  // 送れなかった理由 (動作ログの send.failed)。アダプタの doCommit の error と、境界の時間切れから決める
  const COMMIT_ERRORS = {
    "write failed": "write-failed", "no native composer": "no-composer", busy: "busy",
    "page busy": "page-busy", "not accepted": "not-accepted",
  };
  function commitFailReason(resp) {
    if (!resp || !resp.ok) return "no-response";
    return COMMIT_ERRORS[resp.result && resp.result.error] || undefined;
  }
  // 送り方 (送信ボタン / Enter のキー)。受け付けられなかったときに、どちらで送ったかを動作ログに残す
  function commitPath(resp) {
    const p = resp && resp.ok && resp.result && resp.result.path;
    return p === "button" || p === "enter" ? p : undefined;
  }
  async function submit() {
    if (submitting) return;                       // 二重送信の防止 (INV)
    if (!machine.is("EDITING", "SECURE_READY", "SENT", "MASKING_FAILED")) return;
    const text = editor.value;
    if (!text.trim()) return;
    submitting = true;
    setStatus("");
    try {
      machine.to("SUBMIT_REQUESTED");
      machine.to("MASKING");
      // 常に検出する (ON はマスク結果を使い、OFF は件数を警告に使う)。
      let res;
      try { res = await withBusyNotice(() => maskText(text)); }
      catch (e) {
        if (settings.enabled) {
          machine.to("MASKING_FAILED", { error: String((e && e.message) || e) });
          dl("send.blocked", { reason: "unmaskable", via: "secure-composer" });
          setStatus("端末内のマスキングに失敗したよ。送信は止めた。下書きはそのまま。");
          return;
        }
        res = { text, count: 0 }; // OFF: 検出できなくても原文は送れる (警告は出せない)
      }
      const piiCount = res.count;
      const finalText = settings.enabled ? res.text : text;
      const maskedCount = settings.enabled ? res.count : 0;
      if (settings.enabled) {
        // 裏取り: 常に伏せる語の生値が残っていたら送らない (fail-closed, INV-2)
        const residual = leak ? leak.findLeaks(finalText, settings.maskForceList.map((e) => e.value)) : [];
        if (residual.length) {
          machine.to("MASKING_FAILED", { reason: "residual" });
          dl("send.blocked", { reason: "unmaskable", via: "secure-composer" });
          setStatus("マスキングの確認に失敗したよ。送信は止めた。");
          return;
        }
      }
      // 個人情報を検出したときは送信前に確認を出す (無いときは無言で送る)。
      // カスタムルールを時間内に調べきれなかったときは、件数や piiSendWarning にかかわらず確認を出す (黙って送らない)
      const partial = res.custom === "partial";
      if (partial) dl("custom.partial", { via: "secure-composer" });
      if (partial || (piiCount > 0 && settings.piiSendWarning)) {
        const ok = await confirmPii(piiCount, partial ? CUSTOM_PARTIAL_NOTICE : "");
        if (!ok) { machine.to("EDITING"); setStatus(""); dl("send.cancelled", { via: "secure-composer" }); return; } // 取消: 下書きはそのまま
      }
      machine.to("COMMIT_READY");
      machine.to("SUBMITTING");
      const resp = await withBusyNotice(() => boundary.request("commit", { text: finalText, masked: settings.enabled }, 20000), "送信中…");
      const committed = resp && resp.ok && resp.result && resp.result.committed === true;
      if (!committed) {
        // 送信できなかった → 下書きを残し、編集に戻す。原文の自動再送はしない (INV-2 / P0-10)
        const reason = commitFailReason(resp);
        dl("send.failed", { reason, path: commitPath(resp), via: "secure-composer" });
        machine.to("EDITING");
        setStatus(reason === "page-busy"
          ? "ChatGPT が回答を作っている途中だよ。終わったら、もう一度 Enter で送ってね。"
          : "送信できなかった。もう一度 Enter で送れるよ。");
        return;
      }
      machine.to("SENT");
      if (settings.enabled && maskedCount > 0) dl("send.masked", { via: "secure-composer" });
      // F-SC-10: 確認機能 OFF でも「マスクした件数」をピルに知らせ、黄色+メッセージを出させる。
      if (settings.enabled && maskedCount > 0) boundary.post("maskinfo", { maskedCount });
      // 送った文 (送るときの下書き) だけを除く。送っている間に続けて打った文 (送った文のあと) は残す。送っている間に
      // 送った部分を書き換えたときは、今までどおり全部消す (送った文を下書きに残さない、D-SC-40)
      const now = editor.value;
      const rest = now !== text && now.startsWith(text) ? now.slice(text.length).replace(/^\n+/, "") : "";
      editor.value = rest;
      if (rest) { try { editor.setSelectionRange(rest.length, rest.length); } catch (_) {} }
      autosize();
      scheduleDraftScan(0); // オフの警告を消す
      // オフのときは ML を警告の件数にしか使っていないので、知らせない (D-SC-10)
      if (settings.enabled) noteMlSkipped(res.ml, "send", "伏せて送った");
      machine.to("SECURE_READY");
    } finally {
      submitting = false;
    }
  }

  // ---- 入力イベント ----------------------------------------------------------
  // 親のページが iframe にフォーカスを移したとき (アダプタの D-SC-38)、iframe の中でまだどこにもフォーカスが無ければ、
  // 文の欄に移す。連絡路の知らせを待たない (つなぎ直している間も、打った文字が行き場を失わない)
  window.addEventListener("focus", () => {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) { try { editor.focus(); } catch (_) {} }
  });
  editor.addEventListener("compositionstart", () => { composing = true; });
  editor.addEventListener("compositionend", () => { composing = false; });
  editor.addEventListener("input", () => {
    if (machine.is("SECURE_READY", "SENT", "MASKING_FAILED")) machine.to("EDITING");
    autosize();
    if (!settings.enabled) scheduleDraftScan();
  });
  editor.addEventListener("keydown", (e) => {
    // IME 変換確定の Enter を送信にしない (keyCode 229 / isComposing)
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !composing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  });

  // ---- ファイルのドラッグ/貼り付け (F-SC-13) ---------------------------------------
  // iframe はファイルを受けない (ここに落ちたファイルはページ側のマスク経路に乗らない)。
  // ドラッグが来たら content script に知らせて iframe を透過にしてもらい、drop をページ側
  // (attachment-guard が先に捕まえてマスクする) に通す。透過になるまでの一瞬は「落とせない」表示。
  let hintTimer = 0;
  function flashStatus(msg) {
    setStatus(msg); autosize();
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { if (statusEl.textContent === msg) { setStatus(""); autosize(); } }, 6000);
  }
  const isFileDrag = (e) => !!e.dataTransfer && Array.prototype.includes.call(e.dataTransfer.types || [], "Files");
  let lastDragPost = 0;
  function onFileDrag(e) {
    if (!isFileDrag(e)) return; // 文字のドラッグは textarea の既定どおり受ける
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
    const now = Date.now();
    if (now - lastDragPost > 150) { lastDragPost = now; boundary.post("dragfiles", {}); }
  }
  document.addEventListener("dragenter", onFileDrag, true);
  document.addEventListener("dragover", onFileDrag, true);
  document.addEventListener("drop", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    flashStatus("ファイルはもう一度ドロップしてね。添付するときにマスクするよ。");
  }, true);
  // ファイルや画像だけの貼り付け (スクリーンショット、ファイラでコピーしたファイル) は、＋ ボタンやドラッグと同じく
  // 添付の見張り (attachment-guard) を通して添付する (F-SC-31、D-SC-23)。中身は拡張機能の中の連絡路でアダプタに
  // 渡す。window.postMessage はページのスクリプトも受け取れるので使わない (F-SC-32)。
  // 文字も一緒なら文字だけ貼る (Excel のセル等)。
  const PASTE_MAX_FILES = 10;
  const PASTE_MAX_BYTES = 20 * 1024 * 1024;
  const PASTE_FALLBACK = "添付できなかったよ。＋ ボタンかドラッグ&ドロップで添付してね。";
  editor.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (!cd || !cd.files || cd.files.length === 0) return;
    if (Array.prototype.includes.call(cd.types || [], "text/plain")) return;
    e.preventDefault();
    attachPasted(Array.from(cd.files));
  });
  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
      r.onerror = () => reject(r.error || new Error("read failed"));
      r.readAsDataURL(file);
    });
  }
  let pasting = false;
  async function attachPasted(files) {
    if (pasting) return;
    const total = files.reduce((n, f) => n + (f.size || 0), 0);
    if (files.length > PASTE_MAX_FILES || total > PASTE_MAX_BYTES) {
      flashStatus("貼り付けたファイルが大きすぎるよ。＋ ボタンかドラッグ&ドロップで添付してね。");
      return;
    }
    pasting = true;
    try {
      const payload = [];
      for (const f of files) payload.push({ name: f.name || "image.png", type: f.type || "", lastModified: f.lastModified || Date.now(), data: await toBase64(f) });
      // 伏せられないファイルがあると、ページに確認が出て利用者の答えを待つので、待つ上限は長くとる (D-SC-24)
      const resp = await withBusyNotice(() => boundary.request("paste-files", { files: payload }, 600000), "添付中…");
      const r = resp && resp.ok && resp.result ? resp.result : null;
      if (!r || r.reason === "no-target" || !(r.attached > 0 || r.blocked > 0)) flashStatus(PASTE_FALLBACK);
      else if (r.blocked > 0) flashStatus("伏せられないファイルは添付しなかったよ。");
    } catch (e) {
      dl("error", errorFields(e));
      flashStatus(PASTE_FALLBACK);
    } finally {
      pasting = false;
    }
  }

  // ---- content script からの要求 ------------------------------------------------
  boundary.on("theme", (t) => { applyTheme(t); return true; });
  // 文の欄に既にフォーカスがあれば何もしない (呼び直すと、Windows の IME が状態を戻すことがある、D-SC-41)
  boundary.on("focus", () => {
    if (document.activeElement === editor && document.hasFocus()) return true;
    try { editor.focus(); } catch (_) {}
    return true;
  });
  boundary.on("submit", () => { submit(); return true; });          // ネイティブの送信ボタン押下の中継
  boundary.on("mask-draft", () => { maskDraft(); return true; });   // 黄色の内訳の「マスキングする」
  boundary.on("ping", () => ({ state: machine.get(), height: lastReportedHeight }));
  // content script は原文を取りに来られない。commit は iframe → content の一方向だけ。

  // ---- 起動 ------------------------------------------------------------------
  (async () => {
    await loadSettings();
    const ok = await waitEngine(8000);
    if (!ok) { machine.block("engine-timeout"); dl("engine.unavailable", { where: "secure-composer" }); setStatus("保護エンジンを読み込めなかった。"); boundary.post("blocked", { reason: "engine" }); return; }
    machine.to("SECURE_READY");
    autosize();
    if (!settings.enabled && editor.value.trim()) scheduleDraftScan(0); // エンジンを待つ間に書かれた下書き
    boundary.post("ready", {});
    // 相手がそろうたびに (つなぎ直したあとも)、準備できたことと、今の高さとオフの警告を送り直す。切れている間の
    // 知らせは届いていないため (D-SC-34)
    boundary.onReady(() => {
      boundary.post("ready", {});
      // 前に測った高さを送り直すだけにし、文の欄には触らない (測り直すと文の欄の style を書き換える、D-SC-41)
      if (lastReportedHeight > 0) boundary.post("resize", { height: lastReportedHeight, empty: lastReportedEmpty });
      scheduleDraftScan(0);
    });
  })();
})();
