// composer-toggle.js — チャット入力欄のそばに置く PII Guard のオン/オフのピルと、
// オフのときの警告マーク。設計は docs/composer-toggle.md。
//
// - content script (isolated world) として動く。manifest の content_scripts で、
//   エンジン一式と content.js の後に読み込まれる
// - オン/オフの保存 (`enabled`) は、このスクリプトが chrome.storage.local に直接書く。
//   ページ側 (MAIN world) のスクリプトは isolated world にも、閉じた Shadow DOM の
//   中にも触れないので、サイトのスクリプトが PII Guard をオフにすることはできない
// - ホストページの DOM ツリーには要素を挿入しない。<html> 直下に position: fixed の
//   Shadow DOM ホストを 1 つ置き、入力欄の矩形に追従させる
// - オフのときだけ、入力が止まって 400ms 後に入力欄の文章を読み、isolated world に
//   読み込んだ正規表現と辞書で検出する。LLM にも ML モデルにも渡さない
// - 警告の「オンにする」「マスキングする」は、ページ側 (injected.js) に下書きの確認を
//   頼んでサイドバーを開き、返ってきた承認結果をこのスクリプトが入力欄に書き戻す
// - テストのために、ホスト要素の data 属性に状態 (data-enabled, data-warn) と
//   部品の位置 (data-layout) を写す。閉じた Shadow DOM の中は外から読めないため
"use strict";

(function attach() {
  // ---- 警告の要約 (Node でもテストできる純粋な関数) ---------------------
  const CATEGORY_JA = {
    PERSON: "人名",
    CONTACT: "連絡先",
    ORGANIZATION: "会社・組織",
    LOCATION: "住所・場所",
    FINANCIAL: "金融情報",
    CREDENTIAL: "認証情報",
    IDENTITY: "個人識別番号",
    INTERNAL_ID: "社内の番号",
    OTHER: "その他",
  };
  const CONFIDENTIAL_JA = "機密と思われる文";

  // aggregated: エンジンの集約結果 (値ごとに 1 行)。allowlist: 除外リストの値。
  // confidential: 機密と判定された文の配列。
  // 返り値: { count: 警告の件数, items: [{ name, count }] (多い順) }
  function summarizeWarning(aggregated, allowlist, confidential) {
    const allow = new Set(Array.isArray(allowlist) ? allowlist.map(String) : []);
    const perName = new Map();
    let count = 0;
    for (const row of Array.isArray(aggregated) ? aggregated : []) {
      if (!row || typeof row !== "object") continue;
      const value = row.value == null ? "" : String(row.value);
      if (!value.trim() || allow.has(value)) continue;
      const name = CATEGORY_JA[row.category] || CATEGORY_JA.OTHER;
      perName.set(name, (perName.get(name) || 0) + 1);
      count++;
    }
    const conf = Array.isArray(confidential) ? confidential.length : 0;
    if (conf > 0) {
      perName.set(CONFIDENTIAL_JA, (perName.get(CONFIDENTIAL_JA) || 0) + conf);
      count += conf;
    }
    const items = [...perName].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count);
    return { count, items };
  }

  const api = { summarizeWarning };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window === "undefined" || typeof document === "undefined" || typeof chrome === "undefined" || !chrome.storage) return;
  // content.js (同じ isolated world) が保存の確認を頼むための公開点
  window.__localMaskMCP = window.__localMaskMCP || {};
  window.__localMaskMCP.composerToggle = api;

  // ---- 設定 ---------------------------------------------------------------
  const TAG_IN = "mask-mcp-inpage";   // ページ → content script
  const TAG_OUT = "mask-mcp-content"; // content script → ページ
  const DEBOUNCE_MS = 400;
  const MAX_CHARS = 20000;
  const TICK_MS = 1000;
  const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
  const LOG = (...a) => console.debug("[pii-guard] composer:", ...a);
  const NS = window.__localMaskMCP; // isolated world のエンジン

  // ---- クリックジャッキングへの防御 ----------------------------------------------
  // ホスト要素はページの DOM にあるので、サイトのスクリプトはホストを透明にしたり
  // 動かしたり、pointer-events: none の偽の見た目をかぶせたりできる。そこで、
  //  - 部品が「完全に見えていて、何にも覆われていない」ことを Intersection Observer v2
  //    (trackVisibility) で追い、そのときだけクリックを受け付ける
  //  - ホストの属性をサイトが書き換えたら、元に戻し、保留中の確認は取り消す
  //  - 位置と状態の data 属性は、テスト用のフラグが保存されているときだけ出す
  const E2E_FLAG = "__pii_guard_e2e";
  let exposeForTests = false;
  const IOV2 = typeof IntersectionObserver === "function" && typeof IntersectionObserverEntry !== "undefined" &&
    "isVisible" in IntersectionObserverEntry.prototype;
  const visibility = new WeakMap();
  let visibilityObserver = null;
  function watchVisibility(el) {
    if (!IOV2 || !el) return;
    if (!visibilityObserver) {
      visibilityObserver = new IntersectionObserver((entries) => {
        for (const en of entries) visibility.set(en.target, en.isVisible === true && en.intersectionRatio >= 0.99);
      }, { threshold: [0, 0.99, 1], trackVisibility: true, delay: 100 });
    }
    visibilityObserver.observe(el);
  }
  // 本物の入力で、部品が完全に見えているときだけ true
  function clickIsSafe(event, el, host) {
    if (!event || event.isTrusted !== true) return false;
    if (IOV2) return visibility.get(el) === true;
    // 古いブラウザ向けの代替: ホストのスタイルが改変されていないことだけ確かめる
    const cs = getComputedStyle(host);
    return cs.opacity === "1" && cs.visibility === "visible" && cs.filter === "none" && cs.clipPath === "none" && cs.pointerEvents !== "none";
  }
  // ホストの属性 (style など) がこのスクリプト以外から変えられたら元に戻す
  function guardHost(host, baseCss, onTamper) {
    // MutationObserver の通知は非同期なので、自分の書き込みかどうかはフラグではなく
    // 「今の属性が期待どおりか」で判断する (フラグ方式だと自分の書き込みに反応して無限に繰り返した)
    const expected = () => baseCss + (host.__pos || "");
    let mo = null;
    const apply = () => {
      if (host.getAttribute("style") !== expected()) host.setAttribute("style", expected());
      if (mo) mo.takeRecords();
    };
    host.__applyStyle = apply;
    apply();
    mo = new MutationObserver((muts) => {
      const tampered = muts.some((m) => m.type === "attributes" && (
        (m.attributeName === "style" && host.getAttribute("style") !== expected()) ||
        m.attributeName === "class" || m.attributeName === "hidden"));
      if (!tampered) return;
      LOG("host attributes were changed by the page; restoring");
      host.removeAttribute("class");
      host.removeAttribute("hidden");
      apply();
      if (onTamper) onTamper();
    });
    mo.observe(host, { attributes: true });
  }

  // サービスごとの入力欄のヒント。外れていても下の汎用の判定で拾う
  const HINTS = [
    { host: /(^|\.)(chatgpt\.com|openai\.com)$/, selectors: ["#prompt-textarea"] },
    { host: /(^|\.)claude\.(ai|com)$/, selectors: ['div[contenteditable="true"].ProseMirror'] },
    { host: /(^|\.)gemini\.google\.com$/, selectors: ["rich-textarea .ql-editor", 'div[contenteditable="true"][aria-label]'] },
    { host: /(^|\.)manus\.im$/, selectors: ["textarea"] },
  ];

  // ---- 入力欄の特定と読み書き ----------------------------------------------
  const isEditable = (el) => !!el && (el.tagName === "TEXTAREA" || el.isContentEditable);
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 16 || r.bottom <= 0 || r.top >= window.innerHeight) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  function findComposer() {
    const hint = HINTS.find((h) => h.host.test(location.hostname));
    if (hint) {
      for (const sel of hint.selectors) {
        for (const el of document.querySelectorAll(sel)) if (isEditable(el) && isVisible(el)) return el;
      }
    }
    let best = null;
    let bestScore = 0;
    for (const el of document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')) {
      if (!isEditable(el) || !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      // 画面の下半分にある入力欄を優先する (チャットの入力欄は下にある)
      const score = r.width * r.height * (r.top >= window.innerHeight * 0.4 ? 1 : 0.25);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  }
  const readText = (el) => (el.tagName === "TEXTAREA" ? el.value : el.innerText || "").slice(0, MAX_CHARS);
  const norm = (s) => String(s).replace(/\r\n/g, "\n").replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n+$/, "");

  // 伏せた文章を入力欄に書き戻す。textarea は React などの管理下でも反映されるよう
  // prototype の setter を使い、contenteditable は全選択して insertText で置き換える
  // (ProseMirror や Quill が自分への入力として扱う経路)。
  function writeBack(el, text) {
    if (el.tagName === "TEXTAREA") {
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertText", false, text);
  }

  // ---- 状態と UI ------------------------------------------------------------
  const state = {
    el: null, enabled: true, allowlist: [], forceList: [],
    summary: { count: 0, items: [] }, reviewing: false, scanSeq: 0,
  };
  let host = null;
  let ui = null;
  let debounceTimer = null;
  let noticeTimer = null;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { position: relative; display: inline-flex; align-items: center; gap: 6px;
      font: 12px/1 -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; color: #374151; }
    .pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px 0 8px;
      border-radius: 12px; background: #ffffff; border: 1px solid #d1d5db; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
    .wrap.dark .pill { background: #1f2937; border-color: #4b5563; color: #e5e7eb; }
    .shield { width: 13px; height: 13px; flex: none; }
    .name { font-weight: 600; letter-spacing: .01em; white-space: nowrap; }
    .switch { position: relative; width: 28px; height: 16px; border-radius: 8px; border: 0; padding: 0; cursor: pointer;
      background: #9ca3af; transition: background .15s; }
    .switch[aria-checked="true"] { background: #6366f1; }
    .knob { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: transform .15s; }
    .switch[aria-checked="true"] .knob { transform: translateX(12px); }
    .warn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 12px; border: 0;
      cursor: pointer; background: #f59e0b; color: #1f2937; font-weight: 700; box-shadow: 0 1px 3px rgba(0,0,0,.18); }
    .warn[hidden] { display: none; }
    .warn .icon { width: 14px; height: 14px; }
    .popover { position: absolute; right: 0; bottom: calc(100% + 6px); min-width: 240px; padding: 10px 12px; border-radius: 10px;
      background: #ffffff; color: #374151; border: 1px solid #d1d5db; box-shadow: 0 6px 20px rgba(0,0,0,.18); z-index: 1; }
    .wrap.below .popover { bottom: auto; top: calc(100% + 6px); }
    .wrap.dark .popover { background: #1f2937; color: #e5e7eb; border-color: #4b5563; }
    .popover[hidden] { display: none; }
    .popover .title { font-weight: 700; margin-bottom: 6px; }
    .popover .sub { color: #6b7280; margin-bottom: 8px; line-height: 1.4; }
    .wrap.dark .popover .sub { color: #9ca3af; }
    .popover ul { margin: 0 0 10px; padding: 0; list-style: none; line-height: 1.6; }
    .popover li { display: flex; justify-content: space-between; gap: 12px; }
    .actions { display: flex; gap: 6px; justify-content: flex-end; }
    .actions button { height: 26px; padding: 0 10px; border-radius: 6px; border: 1px solid #d1d5db; background: #f9fafb; color: #374151; cursor: pointer; font: inherit; }
    .wrap.dark .actions button { background: #374151; border-color: #4b5563; color: #e5e7eb; }
    .actions button.primary { background: #6366f1; border-color: #6366f1; color: #fff; font-weight: 600; }
    .notice { position: absolute; right: 0; bottom: calc(100% + 6px); padding: 6px 10px; border-radius: 8px; background: #dc2626; color: #fff;
      white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
    .notice[hidden] { display: none; }
  `;
  const SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>';
  const BANG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 9v5"/><path d="M12 17.5h.01"/><path d="M10.3 4.3L2.6 17.6c-.7 1.2.2 2.7 1.6 2.7h15.6c1.4 0 2.3-1.5 1.6-2.7L13.7 4.3c-.7-1.3-2.6-1.3-3.4 0z"/></svg>';

  function ensureHost() {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute("data-pii-guard", "composer-toggle");
    host.__pos = "display:none;";
    guardHost(host, "position:fixed;top:0;left:0;z-index:2147483647;isolation:isolate;margin:0;padding:0;border:0;opacity:1;visibility:visible;filter:none;clip-path:none;transform:none;pointer-events:auto;", () => place());
    // 閉じた Shadow DOM。ページのスクリプトは中の要素を取得も操作もできない。
    // 中身は固定の雛形だけで、入力欄の文章などの外部の値は入れない
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>${STYLE}</style>
      <div class="wrap">
        <button class="warn" type="button" hidden title="個人情報の可能性があります"><span class="icon">${BANG}</span><span class="count">0</span></button>
        <div class="pill"><span class="shield">${SHIELD}</span><span class="name">PII Guard</span>
          <button class="switch" type="button" role="switch" aria-checked="true" aria-label="PII Guard のオン/オフ"><span class="knob"></span></button></div>
        <div class="popover" hidden role="dialog" aria-label="個人情報の可能性があります">
          <div class="title">個人情報の可能性があります</div>
          <div class="sub">PII Guard はオフです。このまま送ると伏せられません。</div>
          <ul class="items"></ul>
          <div class="actions">
            <button type="button" data-action="close">閉じる</button>
            <button type="button" data-action="mask-once">マスキングする</button>
            <button type="button" class="primary" data-action="turn-on">オンにする</button>
          </div>
        </div>
        <div class="notice" hidden></div>
      </div>`;
    ui = {
      wrap: shadow.querySelector(".wrap"),
      warn: shadow.querySelector(".warn"),
      count: shadow.querySelector(".warn .count"),
      sw: shadow.querySelector(".switch"),
      popover: shadow.querySelector(".popover"),
      items: shadow.querySelector(".items"),
      notice: shadow.querySelector(".notice"),
      turnOn: shadow.querySelector('[data-action="turn-on"]'),
      maskOnce: shadow.querySelector('[data-action="mask-once"]'),
      close: shadow.querySelector('[data-action="close"]'),
    };
    applyTheme();
    for (const el of [ui.sw, ui.warn, ui.turnOn, ui.maskOnce, ui.close]) watchVisibility(el);
    const safe = (el, fn) => (e) => {
      if (!clickIsSafe(e, el, host)) { LOG("ignored a click on a control that is not fully visible"); return; }
      fn(e);
    };
    ui.sw.addEventListener("click", safe(ui.sw, () => setEnabled(!state.enabled)));
    ui.warn.addEventListener("click", safe(ui.warn, () => {
      if (ui.popover.hidden) renderItems();
      ui.popover.hidden = !ui.popover.hidden;
      exportLayout();
    }));
    ui.close.addEventListener("click", safe(ui.close, () => { ui.popover.hidden = true; exportLayout(); }));
    ui.maskOnce.addEventListener("click", safe(ui.maskOnce, () => { ui.popover.hidden = true; exportLayout(); reviewDraft(); }));
    ui.turnOn.addEventListener("click", safe(ui.turnOn, () => { ui.popover.hidden = true; setEnabled(true); reviewDraft(); }));
    document.documentElement.appendChild(host);
  }

  // サイドバーと同じ輝度判定で明暗を決める
  function applyTheme() {
    try {
      let bg = "rgb(255, 255, 255)";
      for (const el of [document.body, document.documentElement]) {
        const c = el && getComputedStyle(el).backgroundColor;
        if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") { bg = c; break; }
      }
      const m = bg.match(/\d+/g) || ["255", "255", "255"];
      const lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255;
      ui.wrap.classList.toggle("dark", lum < 0.5);
    } catch (_) { /* 既定の明るい配色のまま */ }
  }

  // テスト用: 状態と部品の位置をホストの data 属性に写す (閉じた Shadow DOM は外から読めない)
  function exportLayout() {
    if (!host || !ui) return;
    if (!exposeForTests) {
      for (const k of ["enabled", "warn", "layout"]) delete host.dataset[k];
      return;
    }
    host.dataset.enabled = state.enabled ? "true" : "false";
    host.dataset.warn = String(!state.enabled ? state.summary.count : 0);
    const rect = (el) => {
      if (!el || el.hidden || el.offsetParent === null) return null;
      const r = el.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    };
    host.dataset.layout = JSON.stringify({
      switch: rect(ui.sw), warn: rect(ui.warn),
      turnOn: rect(ui.turnOn), maskOnce: rect(ui.maskOnce), close: rect(ui.close),
    });
  }

  function render() {
    if (!ui) return;
    ui.sw.setAttribute("aria-checked", state.enabled ? "true" : "false");
    const show = !state.enabled && state.summary.count > 0;
    ui.warn.hidden = !show;
    ui.count.textContent = String(state.summary.count);
    if (!show) ui.popover.hidden = true;
    exportLayout();
  }
  function renderItems() {
    ui.items.textContent = "";
    for (const it of state.summary.items) {
      const li = document.createElement("li");
      const a = document.createElement("span"); a.textContent = it.name;
      const b = document.createElement("span"); b.textContent = `${it.count} 件`;
      li.append(a, b);
      ui.items.appendChild(li);
    }
  }
  function notice(text) {
    if (!ui) return;
    ui.notice.textContent = text;
    ui.notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, 4000);
  }

  // 入力欄の右上の少し上に置く。上に余白が無ければ入力欄の内側の右上に重ねる
  function setHostPos(pos) {
    if (!host) return;
    if (host.__pos === pos) return;
    host.__pos = pos;
    host.__applyStyle();
  }
  function place() {
    if (!host || !state.el) return;
    if (!isVisible(state.el)) { setHostPos("display:none;"); return; }
    if (host.__pos === "display:none;") setHostPos("display:block;");
    const r = state.el.getBoundingClientRect();
    const w = ui.wrap.offsetWidth || 150;
    const h = ui.wrap.offsetHeight || 24;
    let top = r.top - h - 6;
    const below = top < 4;
    if (below) top = r.top + 6;
    let left = r.right - w - 8;
    if (left < 4) left = 4;
    ui.wrap.classList.toggle("below", below);
    setHostPos(`display:block;left:${Math.round(left)}px;top:${Math.round(top)}px;`);
    exportLayout();
  }

  // ---- 設定の読み書き (chrome.storage.local に直接) ----------------------------
  function setEnabled(value) {
    state.enabled = !!value;
    if (state.enabled) state.summary = { count: 0, items: [] };
    render();
    chrome.storage.local.set({ enabled: !!value }).catch((e) => LOG("storage write failed:", e && e.message));
    if (!state.enabled) scheduleScan(0);
  }
  function applyStored(stored) {
    const prevEnabled = state.enabled;
    if ("enabled" in stored) state.enabled = stored.enabled !== false;
    if (Array.isArray(stored.maskAllowlist)) state.allowlist = stored.maskAllowlist.filter((v) => typeof v === "string");
    if (Array.isArray(stored.maskForceList)) {
      state.forceList = stored.maskForceList
        .map((e) => (typeof e === "string" ? { value: e, category: "OTHER" }
          : e && typeof e.value === "string" ? { value: e.value, category: typeof e.category === "string" ? e.category : "OTHER" } : null))
        .filter(Boolean);
    }
    if (state.enabled) state.summary = { count: 0, items: [] };
    render();
    if (!state.enabled && (prevEnabled !== state.enabled || "maskAllowlist" in stored || "maskForceList" in stored)) scheduleScan(0);
  }
  chrome.storage.local.get(["enabled", "maskAllowlist", "maskForceList", E2E_FLAG]).then((s) => {
    exposeForTests = s[E2E_FLAG] === true;
    applyStored(s);
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (E2E_FLAG in changes) { exposeForTests = changes[E2E_FLAG].newValue === true; exportLayout(); exportPersistLayout(); }
    const stored = {};
    for (const k of ["enabled", "maskAllowlist", "maskForceList"]) if (k in changes) stored[k] = changes[k].newValue;
    if (Object.keys(stored).length) applyStored(stored);
  });

  // ---- オフ時の検出 -----------------------------------------------------------
  function scheduleScan(delay) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, delay == null ? DEBOUNCE_MS : delay);
  }
  async function scan() {
    if (state.enabled || !state.el) return;
    const engine = NS.engine;
    if (!engine || typeof engine.maskAggregated !== "function" || engine.ready === false) { scheduleScan(1000); return; }
    const text = readText(state.el);
    const seq = ++state.scanSeq;
    if (!text.trim()) { state.summary = { count: 0, items: [] }; render(); return; }
    try {
      const res = await engine.maskAggregated(text, { userForceMaskEntries: state.forceList, mlEnabled: false });
      if (seq !== state.scanSeq) return;
      state.summary = summarizeWarning(res && res.aggregated, state.allowlist, res && res.confidential);
    } catch (err) {
      LOG("scan failed:", err && err.message);
      state.summary = { count: 0, items: [] };
    }
    render();
    place();
  }

  // ---- 下書きの確認 (ページ側にサイドバーを開いてもらい、承認結果を書き戻す) ---------
  const pendingReviews = new Map();
  let reviewSeq = 0;
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== TAG_IN || d.type !== "review-draft-result" || typeof d.id !== "string") return;
    const entry = pendingReviews.get(d.id);
    if (!entry) return;
    pendingReviews.delete(d.id);
    clearTimeout(entry.timer);
    entry.resolve(d);
  });
  function askPageToReview(text) {
    return new Promise((resolve) => {
      const id = `review-${++reviewSeq}-${Date.now()}`;
      const timer = setTimeout(() => { pendingReviews.delete(id); resolve(null); }, REVIEW_TIMEOUT_MS);
      pendingReviews.set(id, { resolve, timer });
      window.postMessage({ source: TAG_OUT, id, type: "review-draft", text }, "*");
    });
  }
  async function reviewDraft() {
    if (state.reviewing || !state.el) return;
    const el = state.el;
    const text = readText(el);
    if (!text.trim()) return;
    const agg = NS.engine && NS.engine.aggregate;
    if (!agg || typeof agg.applySpans !== "function") { notice("確認画面を開けませんでした"); return; }
    state.reviewing = true;
    try {
      // ページ側の応答は信用しない前提で扱う。影響するのは入力欄の下書きの置き換えだけで、
      // 置き換えた結果は利用者の目の前に出る
      const d = await askPageToReview(text);
      if (!d) { notice("確認画面が応答しませんでした"); return; }
      if (!d.accepted) return;
      const masked = agg.applySpans(text, Array.isArray(d.maskedPositions) ? d.maskedPositions : []);
      if (masked === text) return;
      writeBack(el, masked);
      if (norm(readText(el)) !== norm(masked)) {
        LOG("write-back mismatch; restoring the original text");
        writeBack(el, text);
        notice("入力欄に書き戻せませんでした");
      }
    } catch (err) {
      LOG("review failed:", err && err.message);
      notice("確認画面でエラーが起きました");
    } finally {
      state.reviewing = false;
      if (!state.enabled) scheduleScan(0);
    }
  }

  // ---- 保存の確認 (除外リスト・常に伏せる語) -------------------------------------------
  // サイドバーは MAIN world にあるので、その「除外」やドラッグ登録のメッセージは
  // サイトのスクリプトにも送れる。保存の確定だけを、ページが触れないこの世界の
  // 閉じた UI で行う。確認が無ければ何も保存しない。
  const PERSIST_TIMEOUT_MS = 20000;
  const PERSIST_MIN_VISIBLE_MS = 500; // 表示した瞬間のクリック (カーソルの下に出す攻撃) を受け付けない
  let persistShownAt = 0;
  const persistQueue = [];
  let persistHost = null;
  let persistUi = null;
  let persistCurrent = null;
  let persistTimer = null;
  const PERSIST_STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .box { position: fixed; right: 16px; bottom: 16px; min-width: 280px; max-width: 420px; padding: 12px 14px; border-radius: 10px;
      background: #ffffff; color: #374151; border: 1px solid #d1d5db; box-shadow: 0 8px 24px rgba(0,0,0,.2);
      font: 13px/1.45 -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; }
    .box.dark { background: #1f2937; color: #e5e7eb; border-color: #4b5563; }
    .box[hidden] { display: none; }
    .head { display: flex; align-items: center; gap: 6px; font-weight: 700; margin-bottom: 6px; }
    .head svg { width: 14px; height: 14px; }
    .value { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; padding: 4px 6px; border-radius: 6px;
      background: rgba(99,102,241,.1); margin: 4px 0 8px; }
    .sub { color: #6b7280; margin-bottom: 10px; }
    .box.dark .sub { color: #9ca3af; }
    .actions { display: flex; gap: 6px; justify-content: flex-end; }
    .actions button { height: 28px; padding: 0 12px; border-radius: 6px; border: 1px solid #d1d5db; background: #f9fafb; color: #374151; cursor: pointer; font: inherit; }
    .box.dark .actions button { background: #374151; border-color: #4b5563; color: #e5e7eb; }
    .actions button.primary { background: #6366f1; border-color: #6366f1; color: #fff; font-weight: 600; }
  `;
  const PERSIST_TEXT = {
    "add-allowlist": { title: "除外リストに追加しますか？", sub: "追加すると、この値は今後どの送信でも伏せられなくなります。", ok: "追加" },
    "add-forcelist": { title: "常に伏せる語に追加しますか？", sub: "追加すると、この値は今後どの送信でも伏せられます。", ok: "追加" },
    "remove-forcelist": { title: "常に伏せる語から削除しますか？", sub: "削除すると、この値は以後、通常の判定に戻ります。", ok: "削除" },
  };
  function ensurePersistHost() {
    if (persistHost) return;
    persistHost = document.createElement("div");
    persistHost.setAttribute("data-pii-guard", "persist-confirm");
    guardHost(persistHost, "position:fixed;top:0;left:0;z-index:2147483647;isolation:isolate;margin:0;padding:0;border:0;opacity:1;visibility:visible;filter:none;clip-path:none;transform:none;pointer-events:auto;",
      () => { if (persistCurrent) { LOG("cancelling the pending confirmation after tampering"); finishPersist(false); } });
    const shadow = persistHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>${PERSIST_STYLE}</style>
      <div class="box" hidden role="dialog" aria-label="PII Guard の確認">
        <div class="head">${SHIELD}<span class="title"></span></div>
        <div class="value"></div>
        <div class="sub"></div>
        <div class="actions"><button type="button" class="cancel">キャンセル</button><button type="button" class="primary confirm"></button></div>
      </div>`;
    persistUi = {
      box: shadow.querySelector(".box"), title: shadow.querySelector(".title"), value: shadow.querySelector(".value"),
      sub: shadow.querySelector(".sub"), confirm: shadow.querySelector(".confirm"), cancel: shadow.querySelector(".cancel"),
    };
    try {
      const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
      const m = (bg || "").match(/\d+/g);
      if (m && (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255 < 0.5) persistUi.box.classList.add("dark");
    } catch (_) { /* 既定の明るい配色 */ }
    watchVisibility(persistUi.confirm);
    watchVisibility(persistUi.cancel);
    persistUi.confirm.addEventListener("click", (e) => {
      if (!clickIsSafe(e, persistUi.confirm, persistHost)) { LOG("ignored a confirm click: the dialog is not fully visible"); return; }
      if (Date.now() - persistShownAt < PERSIST_MIN_VISIBLE_MS) { LOG("ignored a confirm click: the dialog has just appeared"); return; }
      finishPersist(true);
    });
    persistUi.cancel.addEventListener("click", (e) => { if (e.isTrusted) finishPersist(false); });
    document.documentElement.appendChild(persistHost);
  }
  function exportPersistLayout() {
    if (!persistHost || !persistUi) return;
    if (!exposeForTests) {
      for (const k of ["pending", "layout"]) delete persistHost.dataset[k];
      return;
    }
    persistHost.dataset.pending = persistCurrent ? persistCurrent.type : "";
    const rect = (el) => {
      if (!el || persistUi.box.hidden) return null;
      const r = el.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    };
    persistHost.dataset.layout = JSON.stringify({ confirm: rect(persistUi.confirm), cancel: rect(persistUi.cancel) });
  }
  function showNextPersist() {
    if (persistCurrent || !persistQueue.length) return;
    ensurePersistHost();
    persistCurrent = persistQueue.shift();
    const text = PERSIST_TEXT[persistCurrent.type];
    persistUi.title.textContent = text.title;
    persistUi.value.textContent = persistCurrent.value + (persistCurrent.category && persistCurrent.type !== "add-allowlist" ? ` (${persistCurrent.category})` : "");
    persistUi.sub.textContent = text.sub;
    persistUi.confirm.textContent = text.ok;
    persistUi.box.hidden = false;
    persistShownAt = Date.now();
    exportPersistLayout();
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => finishPersist(false), PERSIST_TIMEOUT_MS);
  }
  async function finishPersist(accepted) {
    const req = persistCurrent;
    if (!req) return;
    clearTimeout(persistTimer);
    persistCurrent = null;
    persistUi.box.hidden = true;
    exportPersistLayout();
    if (accepted) {
      try { await persist(req); } catch (e) { LOG("persist failed:", e && e.message); }
    }
    showNextPersist();
  }
  async function persist(req) {
    const v = req.value.trim();
    if (!v) return;
    if (req.type === "add-allowlist") {
      const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
      if (!maskAllowlist.includes(v)) await chrome.storage.local.set({ maskAllowlist: [...maskAllowlist, v] });
      return;
    }
    const { maskForceList = [] } = await chrome.storage.local.get("maskForceList");
    const normalized = maskForceList.map((e) => (typeof e === "string" ? { value: e, category: "OTHER" } : { value: e.value, category: e.category || "OTHER" }));
    if (req.type === "add-forcelist") {
      const cat = req.category || "OTHER";
      if (!normalized.some((e) => e.value === v && e.category === cat)) normalized.push({ value: v, category: cat });
      await chrome.storage.local.set({ maskForceList: normalized });
      return;
    }
    if (req.type === "remove-forcelist") {
      const cat = req.category;
      const next = normalized.filter((e) => !(e.value === v && (cat == null || e.category === cat)));
      await chrome.storage.local.set({ maskForceList: next });
    }
  }
  // content.js から呼ばれる。利用者が確認を押したときだけ保存する
  api.confirmPersist = function confirmPersist(req) {
    if (!req || !PERSIST_TEXT[req.type] || typeof req.value !== "string" || !req.value.trim()) return;
    if (req.value.length > 500) return;
    if (persistQueue.length >= 5) return; // サイトからの連投を抑える
    persistQueue.push({ type: req.type, value: req.value, category: typeof req.category === "string" ? req.category : null });
    showNextPersist();
  };

  // ---- 入力欄への取り付けと追従 -------------------------------------------------
  const onInput = () => { if (!state.enabled) scheduleScan(); };
  function attachTo(el) {
    if (state.el === el) return;
    if (state.el) state.el.removeEventListener("input", onInput);
    state.el = el;
    if (!el) { setHostPos("display:none;"); return; }
    ensureHost();
    el.addEventListener("input", onInput);
    render();
    place();
    if (!state.enabled) scheduleScan(0);
    LOG("attached to", el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""));
  }
  function tick() {
    if (!state.el || !state.el.isConnected || !isVisible(state.el)) {
      const el = findComposer();
      if (el !== state.el) attachTo(el);
      else if (host && !el) setHostPos("display:none;");
    } else {
      place();
    }
  }
  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => { mutationTimer = null; tick(); }, 500);
  });
  function start() {
    tick();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(tick, TICK_MS);
    window.addEventListener("scroll", () => place(), { passive: true, capture: true });
    window.addEventListener("resize", () => place(), { passive: true });
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => place());
      const observed = new WeakSet();
      setInterval(() => { if (state.el && !observed.has(state.el)) { observed.add(state.el); ro.observe(state.el); } }, TICK_MS);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
