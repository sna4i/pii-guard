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

  const settings = { enabled: true, maskForceList: [], mlEnabled: false, piiSendWarning: true };
  let composing = false;         // IME 変換中
  let lastReportedHeight = 0;

  machine.onChange((state) => {
    rootEl.dataset.state = state;
    boundary.post("state", { state });
  });
  function setStatus(msg) { statusEl.textContent = msg || ""; }

  // ---- 設定 (chrome.storage から直接。ページを経由しない) ----------------------
  async function loadSettings() {
    try {
      const s = await chrome.storage.local.get(["enabled", "maskForceList", "mlEnabled", "piiSendWarning"]);
      settings.enabled = s.enabled !== false;
      settings.mlEnabled = s.mlEnabled === true;
      settings.piiSendWarning = s.piiSendWarning !== false; // 既定 ON: PII を見つけたら送信前に確認
      settings.maskForceList = Array.isArray(s.maskForceList)
        ? s.maskForceList.map((e) => (typeof e === "string" ? { value: e, category: "OTHER" }
            : e && typeof e.value === "string" ? { value: e.value, category: typeof e.category === "string" ? e.category : "OTHER" } : null)).filter(Boolean)
        : [];
    } catch (_) { /* 既定のまま */ }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("enabled" in changes || "maskForceList" in changes || "mlEnabled" in changes || "piiSendWarning" in changes) loadSettings();
  });

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
    autosize();
  }

  function autosize() {
    editor.style.height = "auto";
    const h = Math.min(editor.scrollHeight, Math.round(window.innerHeight * 0.45) || 400);
    editor.style.height = h + "px";
    let total = h;
    if (confirmEl && !confirmEl.hidden) total += confirmEl.offsetHeight;      // PII 確認バーのぶん伸ばす
    if (statusEl && getComputedStyle(statusEl).display !== "none") total += statusEl.offsetHeight;
    total = Math.ceil(total);
    if (total !== lastReportedHeight) { lastReportedHeight = total; boundary.post("resize", { height: total }); }
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
    const count = Array.isArray(res.detections) ? res.detections.length : 0;
    return { text: res.sanitized_text, count };
  }

  // ---- 送信 ------------------------------------------------------------------
  let submitting = false;
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
          setStatus("マスキングの確認に失敗したよ。送信は止めた。");
          return;
        }
      }
      // 個人情報を検出したときは送信前に確認を出す (無いときは無言で送る)。
      if (piiCount > 0 && settings.piiSendWarning) {
        const ok = await confirmPii(piiCount);
        if (!ok) { machine.to("EDITING"); setStatus(""); return; } // 取消: 下書きはそのまま
      }
      machine.to("COMMIT_READY");
      machine.to("SUBMITTING");
      const resp = await boundary.request("commit", { text: finalText, masked: settings.enabled }, 20000);
      const committed = resp && resp.ok && resp.result && resp.result.committed === true;
      if (!committed) {
        // 送信できなかった → 下書きを残し、編集に戻す。原文の自動再送はしない (INV-2 / P0-10)
        machine.to("EDITING");
        setStatus("送信できなかった。もう一度 Enter で送れるよ。");
        return;
      }
      machine.to("SENT");
      // F-SC-10: 確認機能 OFF でも「マスクした件数」をピルに知らせ、黄色+メッセージを出させる。
      if (settings.enabled && maskedCount > 0) boundary.post("maskinfo", { maskedCount });
      editor.value = "";
      autosize();
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
  });
  editor.addEventListener("keydown", (e) => {
    // IME 変換確定の Enter を送信にしない (keyCode 229 / isComposing)
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !composing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  });

  // ---- content script からの要求 ------------------------------------------------
  boundary.on("theme", (t) => { applyTheme(t); return true; });
  boundary.on("focus", () => { try { editor.focus(); } catch (_) {} return true; });
  boundary.on("submit", () => { submit(); return true; });          // ネイティブの送信ボタン押下の中継
  boundary.on("ping", () => ({ state: machine.get(), height: lastReportedHeight }));
  // content script は原文を取りに来られない。commit は iframe → content の一方向だけ。

  // ---- 起動 ------------------------------------------------------------------
  (async () => {
    await loadSettings();
    const ok = await waitEngine(8000);
    if (!ok) { machine.block("engine-timeout"); setStatus("保護エンジンを読み込めなかった。"); boundary.post("blocked", { reason: "engine" }); return; }
    machine.to("SECURE_READY");
    autosize();
    boundary.post("ready", {});
    boundary.onReady(() => boundary.post("ready", {}));
  })();
})();
