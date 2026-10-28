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
  if (!SC || !SC.boundary) {
    if (window.PiiGuardDiagLog) window.PiiGuardDiagLog.log("error", { where: "secure-composer", name: "NotFoundError" });
    return;
  }

  const EXT = chrome.runtime.getURL("secure-composer/secure-composer.html");
  const Z = "2147483646";
  const EDITOR_SEL = '#prompt-textarea, div.ProseMirror[contenteditable="true"], textarea#mobile-composer-prompt';
  const SEND_SEL = '#composer-submit-button, [data-testid="send-button"], button[data-composer-submit], button[type="submit"][aria-label*="送信"], button[aria-label*="Send"]';

  let active = false;
  let scReady = false;        // iframe が ready を報告済みか (fail-closed 判定に使う)
  let native = null;          // ネイティブ入力欄
  let host = null;            // iframe を入れる位置決めの箱 (position:fixed)
  let iframe = null;
  let boundary = null;
  let committing = false;
  let placeTimer = 0;
  let lastRect = "";
  let iframeHeight = 0;
  let draftEmpty = true;      // iframe の下書きが空か (空なら ChatGPT の入力欄の高さを元に戻す)
  let appliedMinH = 0;        // ChatGPT の入力欄に付けた高さ (px、枠と余白を含む)。0 なら付けていない
  let appliedW = 0;           // そのときの入力欄の幅 (px)
  let nativeCap = 0;          // ChatGPT の入力欄が伸びきらなかったときの見えている高さ (iframe の上限にする)
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

  // 色を { r, g, b, a } にする。getComputedStyle が oklch() などで返す色は、canvas に塗って sRGB で
  // 読み直す (composer-toggle.js の toRgb と同じ。getImageData は乗算済みでない値を返す)
  const TINT = window.PiiGuardTint;
  let colorCtx = null;
  function toRgb(color) {
    const direct = TINT && TINT.parseColor(color);
    if (direct) return direct;
    if (typeof color !== "string" || !color.trim()) return null;
    try {
      if (!colorCtx) {
        const cv = document.createElement("canvas");
        cv.width = 1; cv.height = 1;
        colorCtx = cv.getContext("2d", { willReadFrequently: true });
      }
      colorCtx.fillStyle = "#010203";
      const sentinel = colorCtx.fillStyle;
      colorCtx.fillStyle = color;
      if (colorCtx.fillStyle === sentinel) return null; // 読めない色
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch (_) { return null; }
  }
  // ページの明るい/暗い。color-scheme がどちらか一方ならそれ、両方 (light dark) なら OS の設定
  function pageScheme() {
    const cs = (getComputedStyle(document.documentElement).colorScheme || "").trim();
    if (/\bdark\b/.test(cs) && !/\blight\b/.test(cs)) return "dark";
    if (/\blight\b/.test(cs) && !/\bdark\b/.test(cs)) return "light";
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch (_) { return "light"; }
  }
  // 入力面の色 (D-SC-01, F-SC-14): 入力欄から <html> まで背景色を下から重ねる。半透明の色はその下の色と重ねる。
  // ChatGPT の角丸の箱は入力欄の 8 段ほど上にあるので、段数で打ち切らない
  function surfaceOf(el) {
    const above = []; // 入力欄に近いものから順
    let base = null;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const c = toRgb(getComputedStyle(node).backgroundColor);
      if (!c || c.a <= 0.01) continue;
      if (c.a >= 0.99) { base = c; break; }
      above.push(c);
    }
    if (!base) base = pageScheme() === "dark" ? { r: 33, g: 33, b: 33, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    return TINT ? TINT.flatten(above.reverse(), base) : base;
  }

  // ネイティブ入力欄の見た目を測る
  function readTheme(el) {
    const cs = getComputedStyle(el);
    const s = surfaceOf(el);
    const ph = el.getAttribute("data-placeholder") || el.getAttribute("placeholder") ||
      (el.getAttribute("aria-label") || "").trim() || "ChatGPT に聞く";
    const scheme = TINT && TINT.luminance(s) < 0.5 ? "dark" : "light";
    // 高さの上限 (D-SC-02): iframe の中の vh や innerHeight は iframe 自身の高さなので、ページ側で測って渡す。
    // ChatGPT の入力欄が伸びきらなかったときは、その高さを上限にする (D-SC-03)
    const maxHeight = Math.max(24, Math.min(Math.round(window.innerHeight * 0.4), nativeCap || Infinity));
    return {
      fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight === "normal" ? "1.5" : cs.lineHeight,
      color: cs.color, caretColor: cs.caretColor && cs.caretColor !== "auto" ? cs.caretColor : cs.color,
      surface: `rgb(${s.r}, ${s.g}, ${s.b})`, scheme, maxHeight,
      padY: cs.paddingTop, padX: cs.paddingLeft, placeholder: ph,
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

  // ChatGPT の入力欄の高さを、iframe の下書きの高さに合わせる (D-SC-03, F-SC-15)。入力欄に min-height を
  // 付けると、ChatGPT の入力欄の箱ごと伸びる (2026-10-28 に利用者の画面で確認)。文字は入れない。
  // 幅が付けたときのままなら、下書きの高さにそのまま合わせる。幅が変わったとき (ChatGPT が並びを切り替えた
  // とき) は、1 行分を超えて低くなるまで縮めない。高さと並びが互いを変えて、行ったり来たりしないようにする
  function fitNativeHeight() {
    if (!native) return;
    if (draftEmpty || !iframeHeight) {
      if (appliedMinH) { native.style.minHeight = ""; appliedMinH = 0; appliedW = 0; }
      if (nativeCap) { nativeCap = 0; pushTheme(); }
      return;
    }
    const cs = getComputedStyle(native);
    const w = Math.round(native.getBoundingClientRect().width);
    const slack = w === appliedW ? 0 : (parseFloat(cs.lineHeight) || 24);
    const lost = appliedMinH > 0 && !native.style.minHeight; // ページが style を書き換えて、付けた高さが消えた
    if (lost || iframeHeight > appliedMinH || iframeHeight < appliedMinH - slack) {
      const extra = cs.boxSizing === "border-box" ? 0
        : (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      appliedMinH = iframeHeight;
      appliedW = w;
      native.style.minHeight = Math.max(0, iframeHeight - extra) + "px";
    }
  }
  function restoreNativeHeight() {
    if (native && appliedMinH) native.style.minHeight = "";
    appliedMinH = 0;
    appliedW = 0;
    nativeCap = 0;
  }
  // 入力欄の見えている範囲。ChatGPT は入力欄の親 (max-height と overflow:auto) で入力欄を切り取るので、
  // 親の上限より高くすると、入力欄の矩形は親の外 (下の段のボタンの上) にはみ出す。切り取る祖先と重ねる
  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const p = node.getBoundingClientRect();
      left = Math.max(left, p.left + (parseFloat(cs.borderLeftWidth) || 0));
      top = Math.max(top, p.top + (parseFloat(cs.borderTopWidth) || 0));
      right = Math.min(right, p.right - (parseFloat(cs.borderRightWidth) || 0));
      bottom = Math.min(bottom, p.bottom - (parseFloat(cs.borderBottomWidth) || 0));
    }
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  function place() {
    if (!active || !native || !native.isConnected) return;
    fitNativeHeight();
    const r = visibleRect(native);
    if (r.width < 40 || r.height < 8) { host && (host.style.display = "none"); return; }
    // 保護入力欄は ChatGPT の入力欄の見えている範囲にぴったり重ねる。入力欄が上限で伸びきらなかったら、
    // その高さを iframe の上限として渡し、iframe の中でスクロールさせる
    if (iframeHeight > r.height + 2 && !draftEmpty) {
      const cap = Math.round(r.height);
      if (cap !== nativeCap) { nativeCap = cap; pushTheme(); }
    }
    const h = r.height;
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

  // 書き込めたかを確かめるための形。ChatGPT の入力欄 (ProseMirror) は行を段落 (<p>) にするので、innerText
  // では段落の間が "\n\n" になる (下書きの改行は "\n")。行頭の "- " や "1. " を箇条書きに、"**" を太字に
  // 変えることもある。空白と、行頭の箇条書き・見出し・引用の印と、強調の記号を除いて比べる
  function comparable(s) {
    return String(s || "").replace(/^[ \t]*(?:[-*+>]|#{1,6}|\d+[.)])[ \t]+/gm, "").replace(/[\s*_`~]+/g, "");
  }
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
    return comparable(el.innerText).includes(comparable(text).slice(0, 16));
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

  // F-SC-11 (fail-open 修正): overlay が実際に生きているかを content.js に知らせる。
  // live のときだけ injected.js が ChatGPT を素通しし、機密が MAIN world に出ない。
  // live が取れない (ready 前・teardown・入力欄消失) 間は injected.js がマスクに戻る。
  function reportLive(v) {
    try {
      const f = window.__localMaskMCP && window.__localMaskMCP.__scSetOverlayLive;
      if (typeof f === "function") f(!!v);
    } catch (_) {}
  }

  function connectBoundary() {
    boundary = SC.boundary.connect("sc-content");
    boundary.on("commit", (payload) => doCommit(payload));
    boundary.on("resize", (p) => {
      if (p && typeof p.height === "number") { iframeHeight = p.height; draftEmpty = p.empty === true; schedulePlace(); }
      return true;
    });
    // F-SC-16: オフのときの下書きの検出結果 (件数と種類の名前だけ)。同じ isolated world の composer-toggle の
    // 関数を直接呼ぶ。window のイベントはページも送れるので使わない (警告を消させない)
    boundary.on("draftinfo", (p) => { setPillDraftInfo(p); return true; });
    boundary.on("ready", () => { scReady = true; pushTheme(); schedulePlace(); reportLive(active && !!native); return true; });
    boundary.on("state", () => true);
    // F-SC-10: SC がマスクした件数を同じ ISOLATED world の composer-toggle (ピル) へ渡す。
    boundary.on("maskinfo", (p) => {
      try { window.dispatchEvent(new CustomEvent("mask-mcp:sc-maskinfo", { detail: { maskedCount: (p && p.maskedCount) || 0 } })); } catch (_) {}
      return true;
    });
    boundary.on("blocked", () => { /* iframe が保護を保証できない: 重ねを外して従来経路に委ねる */ teardownOverlay(); return true; });
    // iframe の上にファイルのドラッグが来た (iframe はファイルを受けない)。透過にしてページ側へ通す。
    boundary.on("dragfiles", () => { dragPassthrough(); return true; });
  }

  // ---- ファイルのドラッグ (F-SC-13) ----------------------------------------------
  // iframe に落ちたファイルは、ページ側のマスク経路 (attachment-guard の drop 横取り) に乗らない。
  // ファイルのドラッグ中だけ host を pointer-events:none にして、入力欄の上でも drop がページ側
  // (ネイティブ入力欄) に落ちるようにする。dragover は動かなくても数百 ms ごとに来るので、
  // 一定時間来なくなったら (ドロップ済み・取消・窓の外) 元に戻す。
  const DRAG_IDLE_MS = 1000;
  let dragPassUntil = 0;
  let dragTimer = 0;
  function dragPassthrough() {
    if (!active || !host) return;
    dragPassUntil = Date.now() + DRAG_IDLE_MS;
    host.style.pointerEvents = "none";
    if (exposeForTests) host.setAttribute("data-sc-drag", "1");
    if (dragTimer) return;
    dragTimer = setInterval(() => {
      if (Date.now() < dragPassUntil) return;
      clearInterval(dragTimer); dragTimer = 0;
      if (host) { host.style.pointerEvents = "auto"; host.removeAttribute("data-sc-drag"); }
    }, 200);
  }
  // 本物のドラッグだけ (ページの JS が偽の dragover を投げ続けて iframe を透過のままにできないように)
  const isFileDrag = (e) => e.isTrusted && !!e.dataTransfer && Array.prototype.includes.call(e.dataTransfer.types || [], "Files");
  window.addEventListener("dragenter", (e) => { if (isFileDrag(e)) dragPassthrough(); }, true);
  window.addEventListener("dragover", (e) => { if (isFileDrag(e)) dragPassthrough(); }, true);
  window.addEventListener("drop", () => { dragPassUntil = 0; }, true); // 落とし終えたらすぐ戻す
  function pushTheme() {
    if (!boundary || !native) return;
    const t = readTheme(native);
    // iframe の要素の color-scheme も中と同じにする (違うと、ブラウザが iframe の下に不透明な地を敷く)
    if (iframe && iframe.style.colorScheme !== t.scheme) iframe.style.colorScheme = t.scheme;
    boundary.post("theme", t);
  }
  function setPillDraftInfo(p) {
    try {
      const ct = window.__localMaskMCP && window.__localMaskMCP.composerToggle;
      if (ct && typeof ct.setScDraftInfo === "function") ct.setScDraftInfo(p || {});
    } catch (_) { /* 何もしない */ }
  }

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
    scReady = false;
    if (host) host.style.display = "none";
    restoreNativeHeight();
    setPillDraftInfo({}); // 保護入力欄の下書きの警告は、外したら残さない
    reportLive(false); // overlay を外したら即 injected.js をマスクに戻す
  }

  // SPA の作り直し・表示変化に追従。ネイティブが差し替わったら貼り直す。
  function sync() {
    const el = findNative();
    if (el && el !== native) { if (native) { restoreNativeHeight(); native.removeEventListener("focusin", redirectFocus); native.removeEventListener("mousedown", onNativeDown, true); native.removeEventListener("keydown", onNativeKey, true); } active = true; attach(el); }
    else if (el && !active) { active = true; host && (host.style.display = "block"); }
    else if (!el) { restoreNativeHeight(); native = null; if (host) host.style.display = "none"; reportLive(false); } // 入力欄が消えたら素通ししない
    if (active) schedulePlace();
    // 入力欄があり iframe も ready なら live を再確認 (SPA の作り直しからの復帰)。
    reportLive(active && scReady && !!native);
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
    // 窓の大きさが変わると ChatGPT の入力欄の上限も変わるので、伸びきらなかった高さは測り直す
    window.addEventListener("resize", () => { nativeCap = 0; pushTheme(); schedulePlace(); }, true);
    setInterval(sync, 1000);
    scheduleSync();
  }
  let syncTimer = 0;
  function scheduleSync() { if (syncTimer) return; syncTimer = setTimeout(() => { syncTimer = 0; sync(); }, 120); }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();

  // テスト用の最小の公開点 (E2E フラグのときだけ意味を持つ)
  // maskDraft: 黄色の内訳の「マスキングする」(F-SC-17)。composer-toggle (同じ isolated world) が呼ぶ
  window.__piiGuardSC.adapter = {
    findNative,
    get active() { return active; },
    get hasOverlay() { return !!(host && host.style.display !== "none"); },
    maskDraft() { if (boundary && active) boundary.post("mask-draft", {}); },
  };
})();
