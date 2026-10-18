// composer-toggle.js — チャット入力欄のそばに置く PII Guard のオン/オフのアイコンと、
// オフのときの警告マーク、オンのときのチャットの背景色。設計は docs/composer-toggle.md。
//
// - content script (isolated world) として動く。manifest の content_scripts で、
//   エンジン一式、content.js、tint.js の後に読み込まれる
// - オン/オフの保存 (`enabled`) は、このスクリプトが chrome.storage.local に直接書く。
//   ページ側 (MAIN world) のスクリプトは isolated world にも、閉じた Shadow DOM の
//   中にも触れないので、サイトのスクリプトが PII Guard をオフにすることはできない
// - アイコン本体は <html> 直下の閉じた Shadow DOM に置き、入力欄に追従させる。
//   ChatGPT では、入力欄の下の段の音声入力 (マイク) の左に中身の無い場所取りの要素だけを
//   入れ、アイコンをその位置に重ねる (D-18, D-19)。見つからなければ入力欄の箱の右に浮かせる
// - オフのときに個人情報の可能性があれば、アイコンを黄色にする。黄色のアイコンを押すと
//   内訳と「オンにする」「マスキングする」を出す (D-21, D-29)
// - オフのときだけ、入力が止まって 400ms 後に入力欄の文章を読み、isolated world に
//   読み込んだ正規表現と辞書で検出する。LLM にも ML モデルにも渡さない
// - 警告の「オンにする」「マスキングする」は、ページ側 (injected.js) に下書きの確認を
//   頼んでサイドバーを開き、返ってきた承認結果をこのスクリプトが入力欄に書き戻す
// - オンのときは、設定画面で選んだ色をチャットの背景に混ぜる (D-24, D-25)
// - テストのために、ホスト要素の data 属性に状態 (data-enabled, data-warn, data-docked) と
//   部品の位置 (data-layout) を写す。テスト用のフラグが保存されているときだけ
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
  const T = window.PiiGuardTint;    // tint.js (色の計算)
  const STABLE_MS = 500;            // アイコンが動いてからクリックを受け付けるまで (D-22)
  const FLOAT_SIZE = 28;            // 浮かせるときのアイコンの一辺 (px)
  const HOST_CSS = "position:fixed;top:0;left:0;z-index:2147483647;isolation:isolate;margin:0;padding:0;border:0;opacity:1;visibility:visible;filter:none;clip-path:none;transform:none;pointer-events:auto;";

  // ---- クリックジャッキングへの防御 ----------------------------------------------
  // ホスト要素はページの DOM にあるので、サイトのスクリプトはホストを透明にしたり
  // 動かしたり、pointer-events: none の偽の見た目をかぶせたりできる。そこで、
  //  - 部品が「完全に見えていて、何にも覆われていない」ことを Intersection Observer v2
  //    (trackVisibility) で追い、そのときだけクリックを受け付ける
  //  - ホストの属性をサイトが書き換えたら、元に戻し、保留中の確認は取り消す
  //  - 位置と状態の data 属性は、テスト用のフラグが保存されているときだけ出す
  const E2E_FLAG = "__pii_guard_e2e";
  let exposeForTests = false;
  // Secure Composer が入力を受け持つホスト (ChatGPT) で SC が有効なときは、下書きは
  // iframe 側にある。composer-toggle はネイティブ入力欄の下書き走査・警告を SC に譲り、
  // ピル (オン/オフ) と背景色だけを担う (二重処理の衝突を避ける)。
  const SC_HOST = /(^|\.)(chatgpt\.com|openai\.com)$/.test(location.hostname);
  let scActive = false;
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
    { host: /(^|\.)(chatgpt\.com|openai\.com)$/, selectors: ["#prompt-textarea", 'div.ProseMirror[contenteditable="true"]', "textarea#mobile-composer-prompt"] },
    { host: /(^|\.)claude\.(ai|com)$/, selectors: ['div[contenteditable="true"].ProseMirror'] },
    { host: /(^|\.)gemini\.google\.com$/, selectors: ["rich-textarea .ql-editor", 'div[contenteditable="true"][aria-label]'] },
    { host: /(^|\.)manus\.im$/, selectors: ["textarea"] },
  ];

  // 入力欄の下の段の置き場所 (D-19)。上から順に試す。ChatGPT のログイン後の画面だけ。
  // マイクはアイコン画像の名前で見分ける (読み上げ用の名前は表示の言語で変わる)。
  // ログインなしの画面は入力欄の段が列の幅を決め打ちした CSS Grid で、場所取りを入れる
  // 隙間が無いので浮かせる
  const DOCKS = [
    { host: /(^|\.)(chatgpt\.com|openai\.com)$/, slots: [
      { sel: 'button:has(svg use[href*="#microphone"])', where: "before" },   // 音声入力の左
      { sel: '[data-composer-navigation-target="reasoning"]', where: "after" }, // モデル選択の右 (= 音声入力の左)
      { sel: '[data-composer-navigation-target="add-context"]', where: "after" }, // 「+」の右
    ] },
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
  // 小さなボタン向けの「見えている」判定 (isVisible は入力欄向けで、幅 40px 未満を除く)
  function isShown(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12 || r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) return false;
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
  const SC_NOTICE_MS = 6000;
  const state = {
    el: null, enabled: true, interactive: true, allowlist: [], forceList: [], tint: null,
    summary: { count: 0, items: [] }, reviewing: false, scanSeq: 0,
    scMaskNotice: { count: 0, at: 0 }, // F-SC-10: 確認 OFF のとき SC がマスクした件数 (一定時間だけ黄色)
    attachNotice: { masked: 0, blocked: 0, unmasked: 0, reason: "", at: 0 }, // F-SC-08: 添付のマスク/ブロック/未マスク通知
    dock: null,          // { spacer, anchor, slot, where } 下の段に置いているとき
    size: FLOAT_SIZE,    // アイコンの一辺 (px)。下の段では「+」に合わせる
    haloColor: "",       // アイコンの縁取り (入力欄の箱の色)
    lastMovedAt: 0, lastSpot: "",
  };
  let host = null;
  let ui = null;
  let debounceTimer = null;
  let noticeTimer = null;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { position: relative; display: inline-flex; align-items: center; gap: 4px;
      --size: 28px; --glyph: 16px; --fg: #374151; --fg-off: #9ca3af; --halo: #ffffff; --hover: rgba(0,0,0,.06);
      --float-bg: #ffffff; --float-border: #d1d5db; --warn-fg: #ca8a04; --warn-bg: rgba(234,179,8,.18);
      font: 12px/1 -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; color: #374151; }
    .wrap.dark { color: #e5e7eb; --fg: #d1d5db; --fg-off: #6b7280; --halo: #2f2f2f; --hover: rgba(255,255,255,.08);
      --float-bg: #1f2937; --float-border: #4b5563; --warn-fg: #facc15; --warn-bg: rgba(250,204,21,.18); }
    .wrap.floating { flex-direction: row-reverse; --halo: var(--float-bg); }
    .toggle { width: var(--size); height: var(--size); flex: none; margin: 0; padding: 0; border: 0; border-radius: 50%;
      background: transparent; color: var(--fg); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
    .toggle:hover { background: var(--hover); }
    .toggle:focus-visible { outline: 2px solid #6366f1; outline-offset: 1px; }
    .wrap.floating .toggle { background: var(--float-bg); border: 1px solid var(--float-border); box-shadow: 0 1px 3px rgba(0,0,0,.14); }
    .logo { width: var(--glyph); height: var(--glyph); display: block; overflow: visible; }
    .logo .shield, .logo .aster { fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .logo .shackle { fill: none; stroke: #2563eb; stroke-width: 2; }
    .logo .lock { fill: #2563eb; stroke: var(--halo); stroke-width: 1.8; paint-order: stroke; }
    .logo .hole { fill: #ffffff; }
    .logo .slash-halo { stroke: var(--halo); stroke-width: 5; stroke-linecap: round; display: none; }
    .logo .slash { stroke: var(--fg-off); stroke-width: 2.4; stroke-linecap: round; display: none; }
    .toggle[data-state="off"] { color: var(--fg-off); }
    .toggle[data-state="off"] .shackle { stroke: var(--fg-off); }
    .toggle[data-state="off"] .lock { fill: var(--fg-off); }
    .toggle[data-state="off"] .slash, .toggle[data-state="off"] .slash-halo,
    .toggle[data-state="warning"] .slash, .toggle[data-state="warning"] .slash-halo { display: inline; }
    /* 警告: オフのまま個人情報の可能性があるとき、アイコンを黄色にする (D-21) */
    .wrap .toggle[data-state="warning"] { color: var(--warn-fg); background: var(--warn-bg); }
    .toggle[data-state="warning"] .shackle, .toggle[data-state="warning"] .slash { stroke: var(--warn-fg); }
    .toggle[data-state="warning"] .lock { fill: var(--warn-fg); }
    .popover { position: absolute; right: 0; bottom: calc(100% + 6px); width: max-content; min-width: 240px;
      max-width: min(360px, calc(100vw - 16px)); padding: 10px 12px; border-radius: 10px;
      background: #ffffff; color: #374151; border: 1px solid #d1d5db; box-shadow: 0 6px 20px rgba(0,0,0,.18); z-index: 1; }
    .wrap.below .popover { bottom: auto; top: calc(100% + 6px); }
    .wrap.align-left .popover, .wrap.align-left .notice { right: auto; left: 0; }
    .wrap.dark .popover { background: #1f2937; color: #e5e7eb; border-color: #4b5563; }
    .popover[hidden] { display: none; }
    .popover .title { font-weight: 700; margin-bottom: 6px; }
    .popover .sub { color: #6b7280; margin-bottom: 8px; line-height: 1.4; }
    .wrap.dark .popover .sub { color: #9ca3af; }
    .popover ul { margin: 0 0 10px; padding: 0; list-style: none; line-height: 1.6; }
    .popover li { display: flex; justify-content: space-between; gap: 12px; }
    .actions { display: flex; gap: 6px; justify-content: flex-end; }
    .actions button { height: 26px; padding: 0 10px; border-radius: 6px; border: 1px solid #d1d5db; background: #f9fafb; color: #374151; cursor: pointer; font: inherit; white-space: nowrap; }
    .wrap.dark .actions button { background: #374151; border-color: #4b5563; color: #e5e7eb; }
    .actions button.primary { background: #6366f1; border-color: #6366f1; color: #fff; font-weight: 600; }
    .notice { position: absolute; right: 0; bottom: calc(100% + 6px); padding: 6px 10px; border-radius: 8px; background: #dc2626; color: #fff;
      white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
    .wrap.below .notice { bottom: auto; top: calc(100% + 6px); }
    .notice[hidden] { display: none; }
  `;
  // PII Guard のアイコン (盾、「*」、青い錠前)。画像ファイルにしないのは、サイトの CSP で
  // 画像の読み込みが止められても表示できるようにするため (D-20)。オフでは灰色に斜線
  const ICON = '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false">' +
    '<path class="shield" d="M16 3.4 26.2 7.3v7.4c0 6.5-4.2 11.1-10.2 13.8C10 25.8 5.8 21.2 5.8 14.7V7.3Z"/>' +
    '<path class="aster" d="M16 9.6v7.8M12.6 11.55l6.8 3.9M12.6 15.45l6.8-3.9"/>' +
    '<path class="shackle" d="M13.3 22.6v-2a2.7 2.7 0 0 1 5.4 0v2"/>' +
    '<rect class="lock" x="11.4" y="22.2" width="9.2" height="7.4" rx="1.6"/>' +
    '<circle class="hole" cx="16" cy="25.6" r="1.15"/>' +
    '<path class="slash-halo" d="M5.5 5.5 26.5 26.5"/>' +
    '<path class="slash" d="M5.5 5.5 26.5 26.5"/>' +
    "</svg>";
  // 保存の確認の見出しに使う小さな盾
  const SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>';

  function ensureHost() {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute("data-pii-guard", "composer-toggle");
    host.__pos = "display:none;";
    guardHost(host, HOST_CSS, () => place(true));
    // 閉じた Shadow DOM。ページのスクリプトは中の要素を取得も操作もできない。
    // 中身は固定の雛形だけで、入力欄の文章などの外部の値は入れない
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>${STYLE}</style>
      <div class="wrap floating">
        <button class="toggle" type="button" role="switch" aria-checked="true" data-state="on" aria-label="PII Guard">${ICON}</button>
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
      toggle: shadow.querySelector(".toggle"),
      popover: shadow.querySelector(".popover"),
      items: shadow.querySelector(".items"),
      notice: shadow.querySelector(".notice"),
      turnOn: shadow.querySelector('[data-action="turn-on"]'),
      maskOnce: shadow.querySelector('[data-action="mask-once"]'),
      close: shadow.querySelector('[data-action="close"]'),
    };
    applyTheme();
    for (const el of [ui.toggle, ui.turnOn, ui.maskOnce, ui.close]) watchVisibility(el);
    // 本物の入力で、部品が完全に見えていて、アイコンが動いてから 0.5 秒以上たったときだけ
    const safe = (el, fn) => (e) => {
      if (!clickIsSafe(e, el, host)) { LOG("ignored a click on a control that is not fully visible"); return; }
      if (Date.now() - state.lastMovedAt < STABLE_MS) { LOG("ignored a click: the control has just moved"); return; }
      fn(e);
    };
    // 黄色 (オフで個人情報の可能性あり) のときは内訳を開く。それ以外はオン/オフの切り替え (D-29)
    ui.toggle.addEventListener("click", safe(ui.toggle, () => {
      if (warning()) {
        if (ui.popover.hidden) renderItems();
        ui.popover.hidden = !ui.popover.hidden;
        ui.toggle.setAttribute("aria-expanded", ui.popover.hidden ? "false" : "true");
        exportLayout();
        return;
      }
      setEnabled(!state.enabled);
    }));
    ui.close.addEventListener("click", safe(ui.close, () => { ui.popover.hidden = true; exportLayout(); }));
    ui.maskOnce.addEventListener("click", safe(ui.maskOnce, () => { ui.popover.hidden = true; exportLayout(); reviewDraft(); }));
    ui.turnOn.addEventListener("click", safe(ui.turnOn, () => { ui.popover.hidden = true; setEnabled(true); reviewDraft(); }));
    document.documentElement.appendChild(host);
  }

  // 色を { r, g, b, a } にする。getComputedStyle が oklch() などで返す色は、
  // canvas に塗って sRGB で読み直す
  let colorCtx = null;
  function toRgb(color) {
    const direct = T.parseColor(color);
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
      if (colorCtx.fillStyle === sentinel) return null;
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch (_) { return null; }
  }
  // el から祖先へたどって、最初の不透明な背景色
  function surfaceColor(start) {
    for (let el = start; el && el.nodeType === 1; el = el.parentElement) {
      const c = toRgb(getComputedStyle(el).backgroundColor);
      if (c && c.a >= 0.99) return c;
    }
    return null;
  }
  // 入力欄のまわりの背景から、明暗とアイコンの縁取りの色を決める
  function applyTheme() {
    if (!ui) return;
    try {
      const near = (state.el && surfaceColor(state.el)) || surfaceColor(document.body) || { r: 255, g: 255, b: 255, a: 1 };
      ui.wrap.classList.toggle("dark", T.luminance(near) < 0.5);
      state.haloColor = `rgb(${near.r}, ${near.g}, ${near.b})`;
    } catch (_) { /* 既定の明るい配色のまま */ }
  }

  // テスト用: 状態と部品の位置をホストの data 属性に写す (閉じた Shadow DOM は外から読めない)
  function exportLayout() {
    if (!host || !ui) return;
    if (!exposeForTests) {
      for (const k of ["enabled", "warn", "layout", "docked", "tone"]) delete host.dataset[k];
      return;
    }
    host.dataset.enabled = state.enabled ? "true" : "false";
    host.dataset.warn = String(!state.enabled ? state.summary.count : 0);
    host.dataset.docked = ui.wrap.classList.contains("floating") ? "false" : "true";
    host.dataset.tone = ui.toggle.getAttribute("data-state");
    const rect = (el) => {
      if (!el || el.hidden || el.offsetParent === null) return null;
      const r = el.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    };
    host.dataset.layout = JSON.stringify({
      toggle: rect(ui.toggle),
      turnOn: rect(ui.turnOn), maskOnce: rect(ui.maskOnce), close: rect(ui.close),
    });
  }

  const offWarning = () => !state.enabled && state.summary.count > 0;
  // F-SC-10: マスキング ON + 確認機能 OFF で、SC が直近でマスクしたデータがあるとき。
  const scMaskWarning = () =>
    state.enabled && scActive && !state.interactive &&
    state.scMaskNotice.count > 0 && (Date.now() - state.scMaskNotice.at) < SC_NOTICE_MS;
  // F-SC-08: 添付を止めた / マスクせずに通した (マスキング OFF) / 確認 OFF でマスクした、のどれか。
  // 添付ガードは ChatGPT 以外 (Claude/Gemini/Manus) でも動くので、SC の有無に関係なく出す (F-EG-05)
  const attachWarning = () =>
    (Date.now() - state.attachNotice.at) < SC_NOTICE_MS &&
    (state.attachNotice.blocked > 0 || state.attachNotice.unmasked > 0 ||
      (state.attachNotice.masked > 0 && !state.interactive));
  function attachMsg(n) {
    if (n.blocked > 0 && n.reason === "dialog") return "ダイアログへのドロップは止めました。ファイル選択から追加してね";
    if (n.blocked > 0 && n.reason === "no-target") return `添付先が見つからず ${n.blocked} 件止めました`;
    if (n.blocked > 0) return `マスクできない添付を ${n.blocked} 件止めました`;
    if (n.unmasked > 0) return `マスクしていない添付が ${n.unmasked} 件あります`;
    return `添付を ${n.masked} 件マスクしました`;
  }
  const warning = () => offWarning() || scMaskWarning() || attachWarning();
  function render() {
    if (!ui) return;
    const t = ui.toggle;
    if (attachWarning() && !offWarning()) {
      // 添付の通知。止めた / マスクせずに通した / 確認 OFF でマスクした。
      const msg = attachMsg(state.attachNotice);
      t.setAttribute("data-state", "warning");
      t.setAttribute("role", "button");
      t.removeAttribute("aria-checked");
      t.setAttribute("aria-haspopup", "dialog");
      t.setAttribute("aria-expanded", ui.popover.hidden ? "false" : "true");
      t.setAttribute("aria-label", msg);
      t.title = `${msg}。押すと内訳を見られます`;
    } else if (scMaskWarning() && !offWarning()) {
      // マスク済みデータの通知 (確認画面を出さない代わりの気づき)。オン表示のまま黄色にする。
      const n = state.scMaskNotice.count;
      t.setAttribute("data-state", "warning");
      t.setAttribute("role", "button");
      t.removeAttribute("aria-checked");
      t.setAttribute("aria-haspopup", "dialog");
      t.setAttribute("aria-expanded", ui.popover.hidden ? "false" : "true");
      t.setAttribute("aria-label", `マスキングされたデータがあります ${n} 件`);
      t.title = `マスキングされたデータがあります (${n} 件)。押すと内訳を見られます`;
    } else if (offWarning()) {
      // 押すと内訳を開くボタン。読み上げ用の役割もそれに合わせる
      const n = state.summary.count;
      t.setAttribute("data-state", "warning");
      t.setAttribute("role", "button");
      t.removeAttribute("aria-checked");
      t.setAttribute("aria-haspopup", "dialog");
      t.setAttribute("aria-expanded", ui.popover.hidden ? "false" : "true");
      t.setAttribute("aria-label", `PII Guard はオフです。個人情報の可能性 ${n} 件`);
      t.title = `PII Guard はオフです。個人情報の可能性が ${n} 件あります。押すと選べます`;
    } else {
      t.setAttribute("data-state", state.enabled ? "on" : "off");
      t.setAttribute("role", "switch");
      t.setAttribute("aria-checked", state.enabled ? "true" : "false");
      t.removeAttribute("aria-haspopup");
      t.removeAttribute("aria-expanded");
      t.setAttribute("aria-label", "PII Guard");
      t.title = state.enabled ? "PII Guard はオンです。押すとオフにします" : "PII Guard はオフです。押すとオンにします";
      ui.popover.hidden = true;
    }
    place(false);
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

  function setHostPos(pos) {
    if (!host) return;
    if (host.__pos === pos) return;
    host.__pos = pos;
    host.__applyStyle();
  }

  // ---- 入力欄の下の段への配置 (D-18, D-19) ---------------------------------------
  // 入力欄のそばにある目印のボタン (同じ段か、すぐ下の段)。{ anchor, where } か null
  function findDockAnchor() {
    const d = DOCKS.find((x) => x.host.test(location.hostname));
    if (!d || !state.el) return null;
    const er = state.el.getBoundingClientRect();
    for (const { sel, where } of d.slots) {
      for (const a of document.querySelectorAll(sel)) {
        if (!isShown(a)) continue;
        const ar = a.getBoundingClientRect();
        const nearY = ar.bottom > er.top - 40 && ar.top < er.bottom + 80;
        const nearX = ar.right > er.left - 160 && ar.left < er.right + 160;
        if (nearY && nearX) return { anchor: a, where };
      }
    }
    return null;
  }
  // 目印から見て最も近い flex の入れ物の子。この前か後に場所取りを入れる
  function dockSlot(anchor) {
    let a = anchor;
    for (let i = 0; i < 4 && a.parentElement && a.parentElement !== document.body; i++) {
      if (/flex/.test(getComputedStyle(a.parentElement).display)) return a;
      a = a.parentElement;
    }
    return null;
  }
  function removeDock() {
    if (state.dock) { state.dock.spacer.remove(); state.dock = null; }
    state.size = FLOAT_SIZE;
  }
  function ensureDock() {
    const found = findDockAnchor();
    const slot = found && dockSlot(found.anchor);
    if (!slot) { removeDock(); return false; }
    if (!state.dock) {
      const spacer = document.createElement("span");
      spacer.setAttribute("data-pii-guard", "dock");
      spacer.setAttribute("aria-hidden", "true");
      state.dock = { spacer };
    }
    const { spacer } = state.dock;
    Object.assign(state.dock, { anchor: found.anchor, slot, where: found.where });
    const ar = found.anchor.getBoundingClientRect();
    state.size = Math.max(24, Math.min(44, Math.round(Math.min(ar.width, ar.height))));
    if (found.where === "before") { if (slot.previousSibling !== spacer) slot.before(spacer); }
    else if (slot.nextSibling !== spacer) slot.after(spacer);
    sizeSpacer();
    return true;
  }
  // 場所取りの大きさはアイコンと同じ
  function sizeSpacer() {
    if (!state.dock || !ui) return;
    const css = `display:inline-block;flex:none;width:${state.size}px;height:${state.size}px;margin:0;padding:0;border:0;vertical-align:middle;`;
    if (state.dock.spacer.getAttribute("style") !== css) state.dock.spacer.setAttribute("style", css);
  }
  // 場所取りが目印のすぐ隣にあるか。サイトが場所取りだけを別の場所へ動かしたら浮かせる
  function dockAdjacent() {
    if (!state.dock || !state.dock.spacer.isConnected || !state.dock.anchor.isConnected) return false;
    const ar = state.dock.anchor.getBoundingClientRect();
    const sr = state.dock.spacer.getBoundingClientRect();
    const gap = state.dock.where === "before" ? ar.left - sr.right : sr.left - ar.right;
    return gap >= -2 && gap <= 24 && Math.abs((ar.top + ar.bottom) / 2 - (sr.top + sr.bottom) / 2) <= 12;
  }

  // 入力欄を囲む箱 (背景か枠線があり、入力欄より少しだけ大きい祖先)。浮かせる位置の基準。
  // 見つからなければ入力欄そのもの
  function composerBox(el) {
    const er = el.getBoundingClientRect();
    let a = el.parentElement;
    for (let i = 0; a && i < 8 && a !== document.body && a !== document.documentElement; i++, a = a.parentElement) {
      const r = a.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // display: contents
      if (r.height > er.height + 160 || r.width > er.width + 480) break;
      const cs = getComputedStyle(a);
      const bg = toRgb(cs.backgroundColor);
      const border = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
      if ((bg && bg.a >= 0.99) || border) return r;
    }
    return er;
  }

  // full: 下の段の場所取りを探し直す (1 秒ごとと DOM の変化時)。スクロールや大きさの
  // 変化では、今の場所取りの位置を読むだけにする
  function place(full) {
    if (!host || !ui || !state.el) return;
    if (!isVisible(state.el)) { setHostPos("display:none;"); return; }
    if (host.__pos === "display:none;") setHostPos("display:block;left:-9999px;top:-9999px;");
    if (full || (state.dock && !state.dock.spacer.isConnected)) ensureDock();
    const docked = !!state.dock && dockAdjacent();
    const size = docked ? state.size : FLOAT_SIZE;
    ui.wrap.classList.toggle("floating", !docked);
    ui.wrap.style.setProperty("--size", `${size}px`);
    ui.wrap.style.setProperty("--glyph", `${Math.round(size * 0.58)}px`);
    if (docked && state.haloColor) ui.wrap.style.setProperty("--halo", state.haloColor);
    else ui.wrap.style.removeProperty("--halo");
    if (docked) sizeSpacer();
    const w = ui.wrap.offsetWidth || size;
    const h = ui.wrap.offsetHeight || size;
    let left, top, below;
    if (docked) {
      const sr = state.dock.spacer.getBoundingClientRect();
      left = sr.left;
      top = sr.top + (sr.height - h) / 2;
      below = sr.top < 240;
    } else {
      // 入力欄の箱の右の外側に置き、縦は箱の中央にそろえる (D-30)。箱の上には注意書きなど
      // ページの文字があることが多い。右に余白が無いときだけ箱の右上の上 (無ければ内側) に置く
      const r = composerBox(state.el);
      if (window.innerWidth - r.right - 8 >= w + 4) {
        left = r.right + 8;
        top = r.top + (r.height - h) / 2;
        below = r.top < 240;
      } else {
        top = r.top - h - 6;
        below = top < 4;
        if (below) top = r.top + 6;
        left = r.right - w - 8;
        if (left < 4) left = 4;
      }
    }
    ui.wrap.classList.toggle("below", below);
    ui.wrap.classList.toggle("align-left", left + w / 2 < window.innerWidth / 2);
    setHostPos(`display:block;left:${Math.round(left)}px;top:${Math.round(top)}px;`);
    // アイコン自体が動いたら、しばらくクリックを受け付けない (D-22)
    const tr = ui.toggle.getBoundingClientRect();
    const spot = `${Math.round(tr.left)},${Math.round(tr.top)},${Math.round(tr.width)}`;
    if (spot !== state.lastSpot) { state.lastSpot = spot; state.lastMovedAt = Date.now(); }
    exportLayout();
  }

  // ---- 設定の読み書き (chrome.storage.local に直接) ----------------------------
  function setEnabled(value) {
    state.enabled = !!value;
    if (state.enabled) state.summary = { count: 0, items: [] };
    render();
    applyTint(false);
    chrome.storage.local.set({ enabled: !!value }).catch((e) => LOG("storage write failed:", e && e.message));
    if (!state.enabled) scheduleScan(0);
  }
  function applyStored(stored) {
    const prevEnabled = state.enabled;
    let tintChanged = false;
    if ("secureComposerEnabled" in stored) scActive = SC_HOST && stored.secureComposerEnabled !== false;
    if ("interactive" in stored) state.interactive = stored.interactive !== false;
    if ("enabled" in stored) state.enabled = stored.enabled !== false;
    if ("chatTint" in stored) {
      const next = T.normalizeTint(stored.chatTint);
      if (next !== state.tint) { state.tint = next; tintChanged = true; }
    }
    if (Array.isArray(stored.maskAllowlist)) state.allowlist = stored.maskAllowlist.filter((v) => typeof v === "string");
    if (Array.isArray(stored.maskForceList)) {
      state.forceList = stored.maskForceList
        .map((e) => (typeof e === "string" ? { value: e, category: "OTHER" }
          : e && typeof e.value === "string" ? { value: e.value, category: typeof e.category === "string" ? e.category : "OTHER" } : null))
        .filter(Boolean);
    }
    if (state.enabled) state.summary = { count: 0, items: [] };
    render();
    applyTint(tintChanged);
    if (!state.enabled && (prevEnabled !== state.enabled || "maskAllowlist" in stored || "maskForceList" in stored)) scheduleScan(0);
  }
  chrome.storage.local.get(["enabled", "interactive", "maskAllowlist", "maskForceList", "chatTint", "secureComposerEnabled", E2E_FLAG]).then((s) => {
    exposeForTests = s[E2E_FLAG] === true;
    // 既定: SC ホストでは secureComposerEnabled 未設定を true 扱い (SC は既定で有効)。
    scActive = SC_HOST && s.secureComposerEnabled !== false;
    applyStored(s);
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (E2E_FLAG in changes) { exposeForTests = changes[E2E_FLAG].newValue === true; exportLayout(); exportPersistLayout(); }
    const stored = {};
    for (const k of ["enabled", "interactive", "maskAllowlist", "maskForceList", "chatTint", "secureComposerEnabled"]) if (k in changes) stored[k] = changes[k].newValue;
    if (Object.keys(stored).length) applyStored(stored);
  });

  // F-SC-10: Secure Composer (iframe) が送信時にマスクした件数を adapter 経由で受け取り、
  // 確認機能 OFF のときはピルを黄色にして「マスキングされたデータがあります」と気づかせる。
  let scNoticeTimer = null;
  window.addEventListener("mask-mcp:sc-maskinfo", (ev) => {
    const n = (ev && ev.detail && Number(ev.detail.maskedCount)) || 0;
    if (!scActive || state.interactive || n <= 0) return; // 確認機能 ON のときは不要
    state.scMaskNotice = { count: n, at: Date.now() };
    render();
    notice(`マスキングされたデータがあります (${n} 件)`);
    clearTimeout(scNoticeTimer);
    scNoticeTimer = setTimeout(() => { state.scMaskNotice = { count: 0, at: 0 }; render(); }, SC_NOTICE_MS);
  });

  // F-SC-08: 添付のマスク/ブロックを attachment-guard から受け取り、ピルに知らせる。
  let attachNoticeTimer = null;
  window.addEventListener("mask-mcp:attachment", (ev) => {
    const d = (ev && ev.detail) || {};
    const masked = Number(d.maskedCount) || 0;
    const blocked = Array.isArray(d.blocked) ? d.blocked.length : 0;
    const unmasked = Array.isArray(d.unmasked) ? d.unmasked.length : 0;
    const reason = typeof d.reason === "string" ? d.reason : "";
    if (masked <= 0 && blocked <= 0 && unmasked <= 0) return;
    state.attachNotice = { masked, blocked, unmasked, reason, at: Date.now() };
    render();
    if (blocked > 0 || unmasked > 0 || !state.interactive) notice(attachMsg(state.attachNotice));
    clearTimeout(attachNoticeTimer);
    attachNoticeTimer = setTimeout(() => { state.attachNotice = { masked: 0, blocked: 0, unmasked: 0, reason: "", at: 0 }; render(); }, SC_NOTICE_MS);
  });

  // F-EG-03/04: 原文の持ち出しガード (MAIN world の injected.js) が通信を止めた・伏せたとき。
  // detail は JSON 文字列 (MAIN world のオブジェクトはこの world から読めないため)。
  window.addEventListener("mask-mcp:egress", (ev) => {
    let d = {};
    try { d = JSON.parse(String((ev && ev.detail) || "{}")); } catch (_) { d = {}; }
    if (d.action === "block") notice("個人情報を含む通信を止めました");
    else if (d.action === "scrub") notice("通信の中の個人情報を伏せ字にしました");
  });

  // ---- オフ時の検出 -----------------------------------------------------------
  function scheduleScan(delay) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, delay == null ? DEBOUNCE_MS : delay);
  }
  async function scan() {
    if (state.enabled || !state.el) return;
    // Secure Composer が有効なホストでは、下書きは iframe 側。ネイティブ入力欄を走査しても
    // 空なので警告は出さない (SC が入力隔離を担う)。
    if (scActive) { if (state.summary.count) { state.summary = { count: 0, items: [] }; render(); } return; }
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

  // ---- オンのときのチャットの背景色 (D-23〜D-25) ----------------------------------
  // チャットの部分の背景を塗っている要素を探し、印を付けて、追加したスタイルで背景色を
  // 上書きする。基本の背景色と違う色の要素 (入力欄の箱、吹き出し、サイドバー) は変えない
  const TINT_ATTR = "data-pii-guard-tint";
  let tintStyle = null;
  let tintOriginal = new WeakMap(); // 印を付けた要素 → 印を付ける前の背景色
  let tintBase = null;
  let themeTimer = null;
  const tintActive = () => state.enabled && !!state.tint && !!T;
  const isOurs = (el) => !!(el && el.closest && el.closest("[data-pii-guard]"));
  function opaqueBg(el) {
    if (!el || el.nodeType !== 1) return null;
    const c = toRgb(getComputedStyle(el).backgroundColor);
    return c && c.a >= 0.99 ? c : null;
  }
  function originalBg(el) {
    if (el && el.hasAttribute && el.hasAttribute(TINT_ATTR) && tintOriginal.has(el)) return tintOriginal.get(el);
    return opaqueBg(el);
  }
  function bigEnough(el) {
    const r = el.getBoundingClientRect();
    return r.width >= window.innerWidth * 0.4 && r.height >= window.innerHeight * 0.4;
  }
  // 入力欄の上と、画面の上のほう、画面の中央
  function tintPoints() {
    const pts = [];
    const r = state.el && state.el.isConnected ? state.el.getBoundingClientRect() : null;
    const cx = r ? (r.left + r.right) / 2 : window.innerWidth / 2;
    if (r) pts.push([cx, Math.max(8, r.top - 120)]);
    pts.push([cx, window.innerHeight * 0.25]);
    pts.push([window.innerWidth / 2, window.innerHeight * 0.5]);
    return pts.filter(([x, y]) => x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight);
  }
  function clearTint() {
    for (const el of document.querySelectorAll(`[${TINT_ATTR}]`)) el.removeAttribute(TINT_ATTR);
    tintOriginal = new WeakMap();
    tintBase = null;
    if (tintStyle) { tintStyle.remove(); tintStyle = null; }
  }
  // 基本の背景色: body、無ければ html。どちらも透明なら、チャットの部分を塗っている大きな要素
  function findBase() {
    const fromRoot = originalBg(document.body) || originalBg(document.documentElement);
    if (fromRoot) return fromRoot;
    for (const [x, y] of tintPoints()) {
      for (const el of document.elementsFromPoint(x, y)) {
        if (isOurs(el)) continue;
        const c = originalBg(el);
        if (c && bigEnough(el)) return c;
      }
    }
    return null;
  }
  // reset: 印を付け直す (色の設定やテーマが変わったとき)
  function applyTint(reset) {
    if (!tintActive()) { if (tintStyle || tintBase) clearTint(); return; }
    if (reset) clearTint();
    const base = findBase();
    const value = base && T.tintedBackground(state.tint, base);
    if (!value) return;
    const targets = [];
    for (const el of [document.documentElement, document.body]) {
      if (el && T.sameColor(originalBg(el), base)) targets.push(el);
    }
    for (const [x, y] of tintPoints()) {
      for (const el of document.elementsFromPoint(x, y)) {
        if (targets.includes(el) || isOurs(el)) continue;
        if (T.sameColor(originalBg(el), base) && bigEnough(el)) targets.push(el);
      }
    }
    for (const el of targets) {
      if (!el.hasAttribute(TINT_ATTR)) { tintOriginal.set(el, originalBg(el)); el.setAttribute(TINT_ATTR, ""); }
    }
    tintBase = base;
    if (!tintStyle || !tintStyle.isConnected) {
      tintStyle = document.createElement("style");
      tintStyle.setAttribute("data-pii-guard", "tint-style");
      (document.head || document.documentElement).appendChild(tintStyle);
    }
    // value は tint.js が数値から組み立てた "rgb(r, g, b)" だけで、外部の文字列は入らない
    const css = `[${TINT_ATTR}]{background-color:${value} !important;transition:background-color .25s ease}`;
    if (tintStyle.textContent !== css) tintStyle.textContent = css;
  }
  // 画面の遷移で塗る要素が入れ替わっていないか (1 秒ごと)
  function checkTint() {
    if (!tintActive()) { if (tintStyle || tintBase) clearTint(); return; }
    if (!tintBase || !tintStyle || !tintStyle.isConnected) { applyTint(true); return; }
    const pts = tintPoints();
    if (!pts.length) return;
    for (const el of document.elementsFromPoint(pts[0][0], pts[0][1])) {
      if (isOurs(el) || el.hasAttribute(TINT_ATTR)) continue;
      const c = opaqueBg(el);
      if (c && T.sameColor(c, tintBase) && bigEnough(el)) { applyTint(false); return; }
    }
  }
  // テーマの切り替え: 元の色が変わるので、印を付け直す
  function scheduleThemeRefresh() {
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => { applyTheme(); applyTint(true); place(false); }, 150);
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
    guardHost(persistHost, HOST_CSS,
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
    if (!el) { setHostPos("display:none;"); removeDock(); return; }
    ensureHost();
    el.addEventListener("input", onInput);
    applyTheme();
    render();
    place(true);
    if (!state.enabled) scheduleScan(0);
    LOG("attached to", el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""));
  }
  function tick() {
    if (!state.el || !state.el.isConnected || !isVisible(state.el)) {
      const el = findComposer();
      if (el !== state.el) attachTo(el);
      else if (!el) { setHostPos("display:none;"); removeDock(); }
    } else {
      place(true);
    }
    checkTint();
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
    window.addEventListener("scroll", () => place(false), { passive: true, capture: true });
    window.addEventListener("resize", () => place(false), { passive: true });
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => place(false));
      const observed = new WeakSet();
      setInterval(() => { if (state.el && !observed.has(state.el)) { observed.add(state.el); ro.observe(state.el); } }, TICK_MS);
    }
    // テーマの切り替え (D-25)。自分の印 (data-pii-guard-tint) の変化は拾わない
    const themeAttrs = ["class", "style", "data-theme", "data-color-scheme", "data-mode"];
    const themeObserver = new MutationObserver(scheduleThemeRefresh);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: themeAttrs });
    if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: themeAttrs });
    try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", scheduleThemeRefresh); } catch (_) { /* 古いブラウザ */ }
    applyTint(false);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
