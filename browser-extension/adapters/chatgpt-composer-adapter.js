// adapters/chatgpt-composer-adapter.js — ChatGPT のネイティブ入力欄に Secure Composer (iframe) を重ねる。
//
// content script (ISOLATED world)。manifest で content.js の後に読む。
//   - ネイティブ入力欄 (div#prompt-textarea.ProseMirror / textarea#mobile-composer-prompt) を探す
//   - その「文字を打つ領域」にぴったり拡張オリジンの iframe を重ねる (ページは contentDocument に触れない)
//   - 見た目 (フォント・色・入力面の色・余白・プレースホルダ) を測って iframe に渡す
//   - iframe からの commit (送信操作) で、マスク済み(ON)/原文(OFF) をネイティブに書いて正規送信する
//   - ページの SPA 作り直し・スクロール・リサイズに追従。原文はネイティブにも MAIN world にも置かない
//
// secureComposerEnabled (既定 true) が false のときは何もしない (従来の injected.js 経路に任せる)。
"use strict";
(() => {
  if (!/(^|\.)(chatgpt\.com|openai\.com)$/.test(location.hostname)) return;
  const SC = window.__piiGuardSC;
  if (!SC || !SC.boundary) { console.warn("[pii-guard] secure-composer boundary missing"); return; }

  const EXT = chrome.runtime.getURL("secure-composer/secure-composer.html");
  const Z = "2147483646";
  const EDITOR_SEL = '#prompt-textarea, div.ProseMirror[contenteditable="true"], textarea#mobile-composer-prompt';
  const SEND_SEL = '#composer-submit-button, [data-testid="send-button"], button[data-composer-submit], button[type="submit"][aria-label*="送信"], button[aria-label*="Send"]';

  let active = false;
  let native = null;          // ネイティブ入力欄
  let host = null;            // iframe を入れる位置決めの箱 (position:fixed)
  let iframe = null;
  let boundary = null;
  let committing = false;
  let placeTimer = 0;
  let lastRect = "";
  let iframeHeight = 0;
  const E2E_FLAG = "__pii_guard_e2e";
  let exposeForTests = false;

  const isEditable = (el) => !!el && (el.tagName === "TEXTAREA" || el.isContentEditable);
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  function findNative() {
    for (const el of document.querySelectorAll(EDITOR_SEL)) if (isEditable(el) && visible(el)) return el;
    return null;
  }

  // ネイティブ入力欄の見た目を測る。入力面の色は、透明でない背景を持つ親までさかのぼる。
  function readTheme(el) {
    const cs = getComputedStyle(el);
    let surface = "";
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      const b = getComputedStyle(node).backgroundColor;
      if (b && b !== "transparent" && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(b)) { surface = b; break; }
      node = node.parentElement;
    }
    if (!surface) surface = /dark/i.test(document.documentElement.className) ? "#303030" : "#ffffff";
    const ph = el.getAttribute("data-placeholder") || el.getAttribute("placeholder") ||
      (el.getAttribute("aria-label") || "").trim() || "ChatGPT に聞く";
    return {
      fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight === "normal" ? "1.5" : cs.lineHeight,
      color: cs.color, caretColor: cs.caretColor && cs.caretColor !== "auto" ? cs.caretColor : cs.color,
      surface, padY: cs.paddingTop, padX: cs.paddingLeft, placeholder: ph,
      placeholderColor: "rgba(127,127,127,0.8)", dir: cs.direction,
    };
  }

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.setAttribute("data-pii-guard-secure", "1");
    host.style.cssText = `position:fixed;z-index:${Z};margin:0;padding:0;border:0;overflow:hidden;` +
      `box-shadow:none;background:transparent;pointer-events:auto;`;
    iframe = document.createElement("iframe");
    iframe.src = EXT;
    iframe.title = "PII Guard Secure Composer";
    iframe.setAttribute("allow", "clipboard-read; clipboard-write");
    iframe.style.cssText = "display:block;width:100%;height:100%;border:0;margin:0;padding:0;background:transparent;color-scheme:normal;";
    host.appendChild(iframe);
    (document.body || document.documentElement).appendChild(host);
    if (exposeForTests) host.setAttribute("data-sc-host", "1");
  }

  function place() {
    if (!active || !native || !native.isConnected) return;
    const r = native.getBoundingClientRect();
    if (r.width < 40 || r.height < 8) { host && (host.style.display = "none"); return; }
    const h = Math.max(iframeHeight || r.height, Math.min(r.height, 40));
    const top = r.top; // ネイティブの入力面の上端に合わせる
    const key = `${Math.round(r.left)},${Math.round(top)},${Math.round(r.width)},${Math.round(h)}`;
    if (key === lastRect && host.style.display !== "none") return;
    lastRect = key;
    host.style.display = "block";
    host.style.left = Math.round(r.left) + "px";
    host.style.top = Math.round(top) + "px";
    host.style.width = Math.round(r.width) + "px";
    host.style.height = Math.round(h) + "px";
    if (exposeForTests) host.setAttribute("data-sc-rect", key);
  }
  function schedulePlace() { if (placeTimer) return; placeTimer = requestAnimationFrame(() => { placeTimer = 0; place(); }); }

  // ネイティブ入力欄にマスク済み/原文を書いて正規送信する。原文はここで初めてネイティブに入る。
  function writeNative(el, text) {
    if (el.tagName === "TEXTAREA") {
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.value === text;
    }
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges(); sel.addRange(range);
    document.execCommand("insertText", false, text);
    return (el.innerText || "").replace(/\n+$/, "").includes(text.slice(0, Math.min(16, text.length)));
  }
  function fireEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }
  async function doCommit(payload) {
    if (committing) return { committed: false, error: "busy" };
    committing = true;
    try {
      const text = payload && typeof payload.text === "string" ? payload.text : null;
      if (text == null) return { committed: false, error: "no text" };
      const el = findNative();
      if (!el) return { committed: false, error: "no native composer" };
      const wrote = writeNative(el, text);
      if (!wrote) return { committed: false, error: "write failed" };
      // 正規送信: 送信ボタンがあれば押す。なければ Enter。
      await new Promise((r) => setTimeout(r, 0));
      const btn = document.querySelector(SEND_SEL);
      if (btn && !btn.disabled && btn.offsetParent !== null) btn.click();
      else fireEnter(el);
      return { committed: true };
    } catch (e) {
      return { committed: false, error: String((e && e.message) || e) };
    } finally {
      committing = false;
    }
  }

  function connectBoundary() {
    boundary = SC.boundary.connect("sc-content");
    boundary.on("commit", (payload) => doCommit(payload));
    boundary.on("resize", (p) => { if (p && typeof p.height === "number") { iframeHeight = p.height; schedulePlace(); } return true; });
    boundary.on("ready", () => { pushTheme(); schedulePlace(); return true; });
    boundary.on("state", () => true);
    boundary.on("blocked", () => { /* iframe が保護を保証できない: 重ねを外して従来経路に委ねる */ teardownOverlay(); return true; });
  }
  function pushTheme() { if (boundary && native) boundary.post("theme", readTheme(native)); }

  function attach(el) {
    native = el;
    ensureHost();
    if (!boundary) connectBoundary();
    // ネイティブ入力欄にフォーカスが来たら iframe に移す (原文をネイティブに打たせない)
    native.addEventListener("focusin", redirectFocus);
    native.addEventListener("mousedown", onNativeDown, true);
    // ネイティブへの Enter は無効化する。送信は doCommit がボタンのクリックで行うので、
    // commit 中にネイティブが一瞬 focus を持っても、迷子の Enter で二重送信されない (INV / 二重送信防止)。
    native.addEventListener("keydown", onNativeKey, true);
    pushTheme();
    schedulePlace();
  }
  function redirectFocus() { if (boundary) boundary.post("focus", {}); }
  function onNativeDown(e) { if (active) { e.preventDefault(); if (boundary) boundary.post("focus", {}); } }
  function onNativeKey(e) {
    if (!active || committing) {
      // commit 中 (doCommit がボタンを押す瞬間) はネイティブのキーに触らない
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); if (boundary) boundary.post("focus", {}); }
  }

  function teardownOverlay() {
    active = false;
    if (host) host.style.display = "none";
  }

  // SPA の作り直し・表示変化に追従。ネイティブが差し替わったら貼り直す。
  function sync() {
    const el = findNative();
    if (el && el !== native) { if (native) { native.removeEventListener("focusin", redirectFocus); native.removeEventListener("mousedown", onNativeDown, true); native.removeEventListener("keydown", onNativeKey, true); } active = true; attach(el); }
    else if (el && !active) { active = true; host && (host.style.display = "block"); }
    else if (!el) { native = null; if (host) host.style.display = "none"; }
    if (active) schedulePlace();
  }

  let enabled = true; // secureComposerEnabled
  async function init() {
    try {
      const s = await chrome.storage.local.get(["secureComposerEnabled", E2E_FLAG]);
      enabled = s.secureComposerEnabled !== false;
      exposeForTests = s[E2E_FLAG] === true;
    } catch (_) {}
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !("secureComposerEnabled" in changes)) return;
      enabled = changes.secureComposerEnabled.newValue !== false;
      if (!enabled) teardownOverlay(); else { active = true; sync(); }
    });
    if (!enabled) return;
    active = true;
    const el = findNative();
    if (el) attach(el);
    const mo = new MutationObserver(() => scheduleSync());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("scroll", schedulePlace, true);
    window.addEventListener("resize", () => { pushTheme(); schedulePlace(); }, true);
    setInterval(sync, 1000);
    scheduleSync();
  }
  let syncTimer = 0;
  function scheduleSync() { if (syncTimer) return; syncTimer = setTimeout(() => { syncTimer = 0; sync(); }, 120); }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();

  // テスト用の最小の公開点 (E2E フラグのときだけ意味を持つ)
  window.__piiGuardSC.adapter = { findNative, get active() { return active; }, get hasOverlay() { return !!(host && host.style.display !== "none"); } };
})();
