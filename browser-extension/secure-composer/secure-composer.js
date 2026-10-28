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

  const settings = { enabled: true, maskForceList: [], maskAllowlist: [], mlEnabled: false, piiSendWarning: true };
  const SETTING_KEYS = ["enabled", "maskForceList", "maskAllowlist", "mlEnabled", "piiSendWarning"];
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
  function setStatus(msg) { statusEl.textContent = msg || ""; }

  // ---- 設定 (chrome.storage から直接。ページを経由しない) ----------------------
  async function loadSettings() {
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
    } catch (_) { /* 既定のまま */ }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !SETTING_KEYS.some((k) => k in changes)) return;
    // オン/オフやリストが変わったら、オフの警告を出し直す (オフにした直後でも下書きの個人情報で黄色にする)
    loadSettings().then(() => scheduleDraftScan(0));
  });
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
  function applyTheme(t) {
    if (!t || typeof t !== "object") return;
    const set = (k, v) => { if (typeof v === "string" && v) rootEl.style.setProperty(k, v); };
    set("--sc-font", t.fontFamily); set("--sc-size", t.fontSize); set("--sc-line", t.lineHeight);
    set("--sc-color", t.color); set("--sc-caret", t.caretColor || t.color); set("--sc-surface", t.surface);
    set("--sc-pad-y", t.padY); set("--sc-pad-x", t.padX); set("--sc-placeholder", t.placeholderColor);
    if (typeof t.placeholder === "string") editor.setAttribute("placeholder", t.placeholder);
    if (typeof t.dir === "string") editor.setAttribute("dir", t.dir);
    // ページの明るい/暗い (F-SC-14)。iframe の要素にも同じ値をアダプタが付ける
    if (t.scheme === "dark" || t.scheme === "light") { rootEl.style.colorScheme = t.scheme; rootEl.dataset.scheme = t.scheme; }
    if (Number.isFinite(t.maxHeight) && t.maxHeight >= 24) {
      maxHeight = Math.round(t.maxHeight);
      rootEl.style.setProperty("--sc-max-h", maxHeight + "px");
    }
    autosize();
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
    const total = Math.ceil(editor.offsetHeight + extra);
    const empty = editor.value === "" && confirmEl.hidden && !statusEl.textContent;
    if (total !== lastReportedHeight || empty !== lastReportedEmpty) {
      lastReportedHeight = total;
      lastReportedEmpty = empty;
      boundary.post("resize", { height: total, empty });
    }
  }

  // PII 検出時の送信前確認。表示して iframe を伸ばし、ボタンが押されるまで待つ。
  function confirmPii(count) {
    return new Promise((resolve) => {
      confirmMsg.textContent = settings.enabled
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
    const res = await NS.engine.maskSanitize(text, {
      userForceMaskEntries: settings.maskForceList,
      mlEnabled: settings.mlEnabled,
    });
    if (!res || typeof res.sanitized_text !== "string") throw new Error("mask produced no text");
    const all = Array.isArray(res.detections) ? res.detections : [];
    // 除外リストの値は伏せない (F-SC-18)。除いたときは、残りの検出だけで伏せ字を作り直す
    const allowed = allowedMatcher();
    const kept = all.filter((d) => !(d && (allowed(String(d.text)) || allowed(text.slice(d.start, d.end)))));
    if (kept.length === all.length) return { text: res.sanitized_text, count: all.length };
    const agg = NS.engine.aggregate;
    if (!agg || typeof agg.applySpans !== "function") throw new Error("engine not ready");
    return { text: agg.applySpans(text, kept), count: kept.length };
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
    try { res = await maskText(text); }
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
    scheduleDraftScan(0);
  }

  // ---- 送信 ------------------------------------------------------------------
  let submitting = false;
  // 送れなかった理由 (動作ログの send.failed)。アダプタの doCommit の error と、境界の時間切れから決める
  const COMMIT_ERRORS = { "write failed": "write-failed", "no native composer": "no-composer", busy: "busy" };
  function commitFailReason(resp) {
    if (!resp || !resp.ok) return "no-response";
    return COMMIT_ERRORS[resp.result && resp.result.error] || undefined;
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
      try { res = await maskText(text); }
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
      if (piiCount > 0 && settings.piiSendWarning) {
        const ok = await confirmPii(piiCount);
        if (!ok) { machine.to("EDITING"); setStatus(""); dl("send.cancelled", { via: "secure-composer" }); return; } // 取消: 下書きはそのまま
      }
      machine.to("COMMIT_READY");
      machine.to("SUBMITTING");
      const resp = await boundary.request("commit", { text: finalText, masked: settings.enabled }, 20000);
      const committed = resp && resp.ok && resp.result && resp.result.committed === true;
      if (!committed) {
        // 送信できなかった → 下書きを残し、編集に戻す。原文の自動再送はしない (INV-2 / P0-10)
        dl("send.failed", { reason: commitFailReason(resp), via: "secure-composer" });
        machine.to("EDITING");
        setStatus("送信できなかった。もう一度 Enter で送れるよ。");
        return;
      }
      machine.to("SENT");
      if (settings.enabled && maskedCount > 0) dl("send.masked", { via: "secure-composer" });
      // F-SC-10: 確認機能 OFF でも「マスクした件数」をピルに知らせ、黄色+メッセージを出させる。
      if (settings.enabled && maskedCount > 0) boundary.post("maskinfo", { maskedCount });
      editor.value = "";
      autosize();
      scheduleDraftScan(0); // オフの警告を消す
      machine.to("SECURE_READY");
    } finally {
      submitting = false;
    }
  }

  // ---- 入力イベント ----------------------------------------------------------
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
  // ファイル/画像の貼り付けは iframe では添付できない。文字も一緒なら文字だけ貼る (Excel のセル等)。
  editor.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (!cd || !cd.files || cd.files.length === 0) return;
    if (Array.prototype.includes.call(cd.types || [], "text/plain")) return;
    e.preventDefault();
    flashStatus("ファイルや画像は ＋ ボタンかドラッグ&ドロップで添付してね。");
  });

  // ---- content script からの要求 ------------------------------------------------
  boundary.on("theme", (t) => { applyTheme(t); return true; });
  boundary.on("focus", () => { try { editor.focus(); } catch (_) {} return true; });
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
    boundary.onReady(() => boundary.post("ready", {}));
  })();
})();
