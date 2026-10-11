// composer-toggle.js — チャット入力欄のそばに置く PII Guard のオン/オフのピルと、
// オフのときの警告マーク。設計は docs/composer-toggle.md。
//
// - MAIN world で動く。content.js が sidebar.js の後、injected.js の前に注入する
// - ホストページの DOM ツリーには要素を挿入しない。<html> 直下に position: fixed の
//   Shadow DOM ホストを 1 つ置き、入力欄の矩形に追従させる
// - オフのときだけ、入力が止まって 400ms 後に入力欄の文章を読み、端末内の
//   正規表現と辞書で検出する。LLM にも ML モデルにも渡さない
// - 警告の「オンにする」「マスキングする」は、入力中の文章を対象にサイドバーを
//   開き (injected.js の NS.reviewDraft)、承認された結果を入力欄に書き戻す
"use strict";

(function attach(root) {
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
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const NS = (window.__localMaskMCP = window.__localMaskMCP || {});
  NS.composerToggle = api;

  // ---- 設定 ---------------------------------------------------------------
  const TAG_IN = "mask-mcp-inpage"; // ページ → content.js
  const DEBOUNCE_MS = 400;
  const MAX_CHARS = 20000;
  const TICK_MS = 1000;
  const LOG = (...a) => console.debug("[pii-guard] composer:", ...a);

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
  const state = { el: null, enabled: true, summary: { count: 0, items: [] }, reviewing: false, scanSeq: 0 };
  let host = null;
  let shadow = null;
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
    host.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647;isolation:isolate;display:none;";
    shadow = host.attachShadow({ mode: "open" });
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
    };
    applyTheme();
    ui.sw.addEventListener("click", () => setEnabled(!state.enabled));
    ui.warn.addEventListener("click", () => {
      if (ui.popover.hidden) renderItems();
      ui.popover.hidden = !ui.popover.hidden;
    });
    ui.popover.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      ui.popover.hidden = true;
      if (action === "turn-on") { setEnabled(true); reviewDraft(); }
      else if (action === "mask-once") reviewDraft();
    });
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

  function render() {
    if (!ui) return;
    ui.sw.setAttribute("aria-checked", state.enabled ? "true" : "false");
    const show = !state.enabled && state.summary.count > 0;
    ui.warn.hidden = !show;
    ui.count.textContent = String(state.summary.count);
    if (!show) ui.popover.hidden = true;
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
  function place() {
    if (!host || !state.el) return;
    if (!isVisible(state.el)) { host.style.display = "none"; return; }
    host.style.display = "block";
    const r = state.el.getBoundingClientRect();
    const w = ui.wrap.offsetWidth || 150;
    const h = ui.wrap.offsetHeight || 24;
    let top = r.top - h - 6;
    const below = top < 4;
    if (below) top = r.top + 6;
    let left = r.right - w - 8;
    if (left < 4) left = 4;
    ui.wrap.classList.toggle("below", below);
    host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  // ---- 設定の同期 -----------------------------------------------------------
  function setEnabled(value) {
    state.enabled = !!value;
    render();
    try { window.postMessage({ source: TAG_IN, type: "set-enabled", value: !!value }, "*"); } catch (_) { /* noop */ }
    if (!state.enabled) scheduleScan(0); else state.summary = { count: 0, items: [] };
  }
  function onSettings(s) {
    if (!s || typeof s !== "object") return;
    const next = s.enabled !== false;
    const changed = next !== state.enabled;
    state.enabled = next;
    if (state.enabled) state.summary = { count: 0, items: [] };
    render();
    if (changed && !state.enabled) scheduleScan(0);
    if (!state.enabled && ("maskAllowlist" in s || "maskForceList" in s)) scheduleScan(0);
  }
  window.addEventListener("mask-mcp:settings-updated", (e) => onSettings(e.detail));
  if (NS.settings) onSettings(NS.settings);

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
      const s = NS.settings || {};
      const res = await engine.maskAggregated(text, {
        userForceMaskEntries: Array.isArray(s.maskForceList) ? s.maskForceList : [],
        mlEnabled: false,
      });
      if (seq !== state.scanSeq) return;
      state.summary = summarizeWarning(res && res.aggregated, s.maskAllowlist, res && res.confidential);
    } catch (err) {
      LOG("scan failed:", err && err.message);
      state.summary = { count: 0, items: [] };
    }
    render();
    place();
  }

  // ---- 下書きの確認 (サイドバーを開いて、承認結果を入力欄に書き戻す) -----------
  async function reviewDraft() {
    if (state.reviewing || !state.el) return;
    const text = readText(state.el);
    if (!text.trim()) return;
    const sidebar = NS.sidebar;
    if (typeof NS.reviewDraft !== "function" || !sidebar || typeof sidebar.show !== "function") {
      notice("確認画面を開けませんでした");
      return;
    }
    state.reviewing = true;
    try {
      const r = await NS.reviewDraft(text);
      if (!r || !r.aggResp) { notice("検出に失敗しました"); return; }
      const decision = await sidebar.show(r.aggResp, text, {
        draft: true,
        mode: r.llmPending ? "detect" : "regex",
        llmPending: r.llmPending || undefined,
      });
      if (!decision || !decision.accepted) return;
      const agg = NS.engine && NS.engine.aggregate;
      if (!agg || typeof agg.applySpans !== "function") { notice("伏せ字に置き換えられませんでした"); return; }
      const masked = agg.applySpans(text, decision.maskedPositions || []);
      if (masked === text) return;
      writeBack(state.el, masked);
      if (norm(readText(state.el)) !== norm(masked)) {
        LOG("write-back mismatch; restoring the original text");
        writeBack(state.el, text);
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

  // ---- 入力欄への取り付けと追従 -------------------------------------------------
  const onInput = () => { if (!state.enabled) scheduleScan(); };
  function attachTo(el) {
    if (state.el === el) return;
    if (state.el) state.el.removeEventListener("input", onInput);
    state.el = el;
    if (!el) { if (host) host.style.display = "none"; return; }
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
      else if (host) host.style.display = el ? "block" : "none";
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
})(typeof window !== "undefined" ? window : globalThis);
