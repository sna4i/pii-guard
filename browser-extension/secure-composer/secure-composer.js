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
  const rootEl = document.documentElement;

  const settings = { enabled: true, maskForceList: [], mlEnabled: false };
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
      const s = await chrome.storage.local.get(["enabled", "maskForceList", "mlEnabled"]);
      settings.enabled = s.enabled !== false;
      settings.mlEnabled = s.mlEnabled === true;
      settings.maskForceList = Array.isArray(s.maskForceList)
        ? s.maskForceList.map((e) => (typeof e === "string" ? { value: e, category: "OTHER" }
            : e && typeof e.value === "string" ? { value: e.value, category: typeof e.category === "string" ? e.category : "OTHER" } : null)).filter(Boolean)
        : [];
    } catch (_) { /* 既定のまま */ }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("enabled" in changes || "maskForceList" in changes || "mlEnabled" in changes) loadSettings();
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
    const total = Math.ceil(h);
    if (total !== lastReportedHeight) { lastReportedHeight = total; boundary.post("resize", { height: total }); }
  }

  // ---- マスキング ------------------------------------------------------------
  async function maskText(text) {
    if (!engineReady()) throw new Error("engine not ready");
    const res = await NS.engine.maskSanitize(text, {
      userForceMaskEntries: settings.maskForceList,
      mlEnabled: settings.mlEnabled,
    });
    if (!res || typeof res.sanitized_text !== "string") throw new Error("mask produced no text");
    return res.sanitized_text;
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
      let finalText;
      if (settings.enabled) {
        try { finalText = await maskText(text); }
        catch (e) {
          machine.to("MASKING_FAILED", { error: String((e && e.message) || e) });
          setStatus("端末内のマスキングに失敗したよ。送信は止めた。下書きはそのまま。");
          return;
        }
        // 裏取り: 常に伏せる語の生値が残っていたら送らない (fail-closed, INV-2)
        const residual = leak ? leak.findLeaks(finalText, settings.maskForceList.map((e) => e.value)) : [];
        if (residual.length) {
          machine.to("MASKING_FAILED", { reason: "residual" });
          setStatus("マスキングの確認に失敗したよ。送信は止めた。");
          return;
        }
      } else {
        finalText = text; // OFF: 送信操作のときだけ原文を渡す
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
