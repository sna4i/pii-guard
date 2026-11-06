// adapters/chatgpt-composer-adapter.js — ChatGPT のネイティブ入力欄に Secure Composer (iframe) を重ねる。
//
// content script (ISOLATED world)。manifest で content.js の後に読む。
//   - ネイティブ入力欄 (div#prompt-textarea.ProseMirror / textarea#mobile-composer-prompt) を探す
//   - その「文字を打つ領域」にぴったり拡張オリジンの iframe を重ねる (ページは contentDocument に触れない)
//   - 見た目 (フォント・色・入力面の色・余白・プレースホルダ) を測って iframe に渡す
//   - iframe からの commit (送信操作) で、マスク済み(ON)/原文(OFF) をネイティブに書いて正規送信する
//   - ページの SPA 作り直し・スクロール・リサイズに追従。原文はネイティブにも MAIN world にも置かない
//   - ChatGPT の入力欄を下書きの高さまで伸ばす。1 行の並びでは、合成の Shift+Enter で空の段落を足してもらい、ChatGPT
//     自身に 2 段の並びに替えてもらう (文字は入れない。docs/release-1.7.1.md の D-SC-27〜D-SC-31)
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
  // 送信ボタンの場所。ChatGPT は回答を作っている間 (考え中を含む)、ここに停止のボタンを出す (isStopButton)
  const SLOT_SEL = '#composer-submit-button, [data-testid="send-button"], button[data-composer-submit], button[type="submit"]';
  const BUTTON_WAIT_MS = 1500; // 書いてから送信ボタンが出るのを待つ (ChatGPT は文字が入ってから描き直して出す)
  const ACCEPT_WAIT_MS = 5000; // 送ってから、ChatGPT が受け付けた (入力欄が空になった) のを待つ (D-SC-15)

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
  let nativeStyled = false;   // ChatGPT の入力欄に高さの style を付けたか (外すときに、ChatGPT 自身の style には触れない)
  let nativeCap = 0;          // ChatGPT の入力欄が伸びきらなかったときの見えている高さ (iframe の上限にする)
  let raisedUp = false;       // 保護入力欄を入力欄の行から上に伸ばしているか (ChatGPT の入力欄が伸びない並び、D-SC-17)
  // 1 行の並びでは、ChatGPT の入力欄に空の段落を足してもらい、ChatGPT 自身に 2 段の並びに替えてもらう (D-SC-27)
  const EXPAND_WAIT_MS = 800; // Shift+Enter を送ってから、並びが替わるのを待つ時間
  let expandAt = 0;           // Shift+Enter を送った時刻。0 なら待っていない
  let expandFailed = false;   // 送っても替わらなかった (D-SC-31)。下書きが空になるか入力欄が替わるまで送り直さない
  let expandTimer = 0;
  let lastLayout = "";        // ChatGPT の入力欄の並び。替わったら余白などを測り直す (D-SC-30)
  let sizeObserver = null;    // 入力欄と form の大きさの変化 (並びが替わる間の動き) を見る (D-SC-30)
  // ChatGPT の入力欄が、ページのほかの表示 (ダイアログ、メニュー) に覆われているか (D-SC-36)。覆われている間は
  // 保護入力欄を見せない。覆われている間に来たフォーカスは外し、覆いが消えたら保護入力欄に移す (D-SC-37)
  let covered = false;
  let refocusWhenUncovered = false;
  // 上に伸ばしている間の見た目。会話の上に重なった板に見えるように、角丸と薄い縁と影を付ける
  const RAISED_SHADOW = "0 0 0 1px rgba(127,127,127,0.28), 0 -6px 18px rgba(0,0,0,0.22)";
  const E2E_FLAG = "__pii_guard_e2e";
  let exposeForTests = false;
  // 拡張機能との連絡が切れたか (読み込み直し・更新・オフのあと、開いたままのタブに残った古い部品)。
  // 切れると chrome.runtime.id を読めなくなる (docs/release-1.7.1.md の D-SC-21)
  let orphaned = false;
  const STALE_TEXT = "PII Guard が更新か停止されたので、この入力欄は使えなくなったよ。このタブを読み込み直してね。";
  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

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
      // 上に伸ばしている間は、文の欄を下 (入力欄の行) に置き、案内と確認をその上に出してもらう (D-SC-18)
      anchor: raisedUp ? "bottom" : "top",
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
    if (orphaned) {
      // 連絡が切れたあとに入力欄が作り直された (SPA の移動): 新しい入力欄にも知らせを重ねる
      (document.body || document.documentElement).appendChild(host);
      showStaleNotice();
      return;
    }
    iframe = document.createElement("iframe");
    iframe.src = EXT;
    iframe.title = "PII Guard Secure Composer";
    iframe.setAttribute("allow", "clipboard-read; clipboard-write");
    iframe.style.cssText = "display:block;width:100%;height:100%;border:0;margin:0;padding:0;background:transparent;color-scheme:normal;";
    host.appendChild(iframe);
    (document.body || document.documentElement).appendChild(host);
    if (exposeForTests) host.setAttribute("data-sc-host", "1");
  }

  // 連絡が切れたときの知らせ (D-SC-21)。古い保護入力欄 (iframe) を外し、閉じた Shadow DOM の文と
  // 「読み込み直す」ボタンに置き換える。色は ChatGPT の入力欄から測る (拡張機能の機能は使わない)。
  // ChatGPT の入力欄の Enter と mousedown は止めたまま (保護されないまま送らない)
  let staleButton = null;
  function showStaleNotice() {
    if (!host) return;
    host.textContent = "";
    iframe = null;
    const t = native ? readTheme(native) : { surface: "rgb(255, 255, 255)", color: "rgb(13, 13, 13)", fontFamily: "system-ui" };
    const box = document.createElement("div");
    box.style.cssText = "display:block;width:100%;height:100%;margin:0;padding:0;border:0;";
    const shadow = box.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      .stale { box-sizing: border-box; display: flex; align-items: center; gap: 10px; min-height: 100%; margin: 0;
        padding: 6px 10px; font: 13px/1.45 system-ui, sans-serif; }
      .stale span { flex: 1; min-width: 0; }
      .stale button { flex: none; font: inherit; padding: 4px 12px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.55);
        background: transparent; color: inherit; cursor: pointer; }
    </style><div class="stale"><span></span><button type="button">読み込み直す</button></div>`;
    const wrap = shadow.querySelector(".stale");
    wrap.style.background = t.surface;
    wrap.style.color = t.color;
    if (t.fontFamily) wrap.style.fontFamily = t.fontFamily;
    shadow.querySelector("span").textContent = STALE_TEXT;
    staleButton = shadow.querySelector("button");
    staleButton.addEventListener("click", (e) => { if (e.isTrusted) location.reload(); });
    host.appendChild(box);
    // 知らせが入る高さ。1 行の並びに入らなければ、place() が上に伸ばす (D-SC-17)
    iframeHeight = Math.ceil(wrap.scrollHeight) || 40;
    draftEmpty = false;
    lastRect = "";
    if (exposeForTests) host.setAttribute("data-sc-stale", "1");
  }
  function goStale() {
    if (orphaned) return;
    orphaned = true;
    if (host && host.isConnected) showStaleNotice();
    schedulePlace();
  }
  // テスト用: 「読み込み直す」ボタンの位置 (箱の左上からの相対) をホストの data 属性に写す
  function exportStaleLayout() {
    if (!exposeForTests || !host || !staleButton) return;
    const h = host.getBoundingClientRect();
    const b = staleButton.getBoundingClientRect();
    host.dataset.staleButton = JSON.stringify([b.left - h.left, b.top - h.top, b.width, b.height].map(Math.round));
  }

  // ---- ChatGPT の入力欄の並び (D-SC-27〜D-SC-31) ------------------------------------
  // ChatGPT は、入力欄の中身 (段落が 2 つ以上・改行・1 行からあふれた文) で 1 行の並びと 2 段の並びを決め、空なら
  // 1 行の並びに戻す。1 行の並びの入力欄は高さが固定で、min-height を付けても伸びない (2026-11-04 に実物の CSS と
  // JavaScript で確認)。保護入力欄を使う間は ChatGPT の入力欄が空なので、空の段落を 1 つ足してもらって替える

  // 並び: いちばん近い data-composer-input-layout、無ければ data-composer-layout ("single-line" / "multiline")
  function composerLayout(el) {
    const box = el.closest("[data-composer-input-layout]");
    if (box) return box.getAttribute("data-composer-input-layout") || "";
    const lay = el.closest("[data-composer-layout]");
    return lay ? lay.getAttribute("data-composer-layout") || "" : "";
  }
  // 段落を足して並びを替えてもらえるのは ProseMirror の編集欄だけ (ログインなしの textarea は替えられない)
  const canExpand = (el) => !!el && el.isContentEditable && el.classList.contains("ProseMirror");
  const paragraphCount = (el) => el.querySelectorAll(":scope > p").length;
  // 入力欄が空の段落だけでできているか (足した段落を戻してよいか。文字のある入力欄には触れない)
  function onlyEmptyParagraphs(el) {
    const kids = Array.from(el.children);
    return kids.length > 0 && kids.every((c) => c.tagName === "P" && !(c.textContent || "").trim());
  }
  // 合成のキー (泡立たない keydown) を ChatGPT の入力欄に送る。受けるのは編集欄の ProseMirror の keymap だけで、
  // フォーカスは動かない (保護入力欄の変換も切れない)。DOM に段落を直接足すと、ProseMirror は Enter のキー (送信) と
  // 読み替えるので使わない (D-SC-27)
  function sendKey(el, key, shift) {
    const keyCode = key === "Enter" ? 13 : key === "Backspace" ? 8 : 46;
    el.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, keyCode, which: keyCode, shiftKey: !!shift, bubbles: false, cancelable: true }));
  }
  // 2 段の並びに替えてもらう (D-SC-27)。替わるのを待っている間は true。替えられない、または 800ms たっても替わらない
  // ときは false (保護入力欄を上に伸ばす、D-SC-31)
  function requestExpand() {
    if (committing) return true; // 送っている途中は、入力欄に何も送らず、今の重ね方のまま
    if (expandFailed || !canExpand(native)) return false;
    const now = Date.now();
    if (!expandAt) {
      expandAt = now;
      sendKey(native, "Enter", true);
      clearTimeout(expandTimer);
      expandTimer = setTimeout(schedulePlace, EXPAND_WAIT_MS + 20);
      return true;
    }
    if (now - expandAt < EXPAND_WAIT_MS) return true;
    expandAt = 0;
    expandFailed = true;
    if (window.PiiGuardDiagLog) window.PiiGuardDiagLog.log("composer.not_expanded", {});
    return false;
  }
  // 足した空の段落を戻す (D-SC-29)。ChatGPT は 1 行の並びに戻る。空の段落だけで 2 つ以上あるときだけ送る
  function collapseNative(el) {
    expandAt = 0;
    if (!canExpand(el) || !el.isConnected || committing) return;
    for (let i = 0; i < 4 && paragraphCount(el) > 1 && onlyEmptyParagraphs(el); i++) {
      const n = paragraphCount(el);
      sendKey(el, "Backspace");
      if (paragraphCount(el) >= n) sendKey(el, "Delete");
      if (paragraphCount(el) >= n) break; // 効かない (作りが変わった)。何度も送らない
    }
  }

  // ChatGPT の入力欄の高さを、iframe の下書きの高さに合わせる (D-SC-03, F-SC-15)。2 段の並びでは、入力欄に
  // min-height を付けると ChatGPT の入力欄の箱ごと伸びる (2026-10-28 に利用者の画面で確認)。文字は入れない。
  // 幅が付けたときのままなら、下書きの高さにそのまま合わせる。幅が変わったとき (ChatGPT が並びを切り替えた
  // とき) は、1 行分を超えて低くなるまで縮めない。高さと並びが互いを変えて、行ったり来たりしないようにする。
  // 足した空の段落があるうちは height も付け、空の段落 (2 行分) のぶんで高くならないようにする (D-SC-28)
  function fitNativeHeight() {
    if (!native) return;
    if (draftEmpty || !iframeHeight) {
      clearNativeStyle();
      if (nativeCap) { nativeCap = 0; pushTheme(); }
      collapseNative(native);
      expandFailed = false;
      return;
    }
    const cs = getComputedStyle(native);
    const w = Math.round(native.getBoundingClientRect().width);
    const slack = w === appliedW ? 0 : (parseFloat(cs.lineHeight) || 24);
    const lost = appliedMinH > 0 && !native.style.minHeight; // ページが style を書き換えて、付けた高さが消えた
    const padded = paragraphCount(native) > 1 && onlyEmptyParagraphs(native);
    const heightOff = padded !== !!native.style.height; // 足した段落が増えたか消えたのに、height が合っていない
    if (lost || heightOff || iframeHeight > appliedMinH || iframeHeight < appliedMinH - slack) {
      const extra = cs.boxSizing === "border-box" ? 0
        : (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      // ChatGPT の入力欄のもとの min-height (2 段の並びで 40px など) を、付けたものを外して測る。下書きが低くても
      // それより低くしない (ChatGPT に直接打ったときと同じ高さ)
      native.style.minHeight = "";
      native.style.height = "";
      const base = parseFloat(getComputedStyle(native).minHeight) || 0;
      const target = Math.max(0, iframeHeight - extra, base);
      appliedMinH = iframeHeight;
      appliedW = w;
      nativeStyled = true;
      native.style.minHeight = target + "px";
      native.style.height = padded ? target + "px" : "";
      native.style.overflow = padded ? "hidden" : "";
    }
  }
  function clearNativeStyle() {
    if (native && nativeStyled) {
      native.style.minHeight = "";
      native.style.height = "";
      native.style.overflow = "";
    }
    nativeStyled = false;
    appliedMinH = 0;
    appliedW = 0;
  }
  function restoreNativeHeight() {
    clearNativeStyle();
    nativeCap = 0;
    if (native) collapseNative(native);
    expandFailed = false;
    lastLayout = "";
    clearTimeout(expandTimer);
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

  // ChatGPT の入力欄が、ページのほかの表示に覆われているか (D-SC-36)。見えている範囲の 1 行目の高さの中ほどで、
  // 幅の 25%・50%・75% の 3 点を調べる。自分の部品と、点が要素自身の箱の外にある要素 (トップレイヤーの透明な
  // ::backdrop。ChatGPT のファイルのパネルのつまみなど。:modal は除く) を飛ばした、いちばん上の要素が、
  // <html>・<body> か ChatGPT の入力欄の form の中なら覆われていない。1 点でも覆われていたら覆われている
  function coveredByPage(r) {
    const root = native.closest("form") || native.parentElement;
    const y = r.top + Math.min(r.height / 2, 18);
    for (const fx of [0.25, 0.5, 0.75]) {
      const x = r.left + r.width * fx;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
      for (const el of document.elementsFromPoint(x, y)) {
        if (el.closest("[data-pii-guard], [data-pii-guard-secure]")) continue;
        const b = el.getBoundingClientRect();
        const inBox = x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
        if (!inBox && !el.matches(":modal")) continue;
        if (el === document.documentElement || el === document.body) break;
        if (root && root.contains(el)) break;
        return true;
      }
    }
    return false;
  }
  // 覆われたら保護入力欄を見せない (visibility:hidden はクリックも受けない)。覆いが消えたとき、覆われている間に
  // ChatGPT の入力欄にフォーカスが来ていて、今フォーカスがどこにも無い (<body>) か ChatGPT の入力欄にあれば、
  // 保護入力欄に移す (D-SC-37)
  function setCovered(v) {
    covered = v;
    if (!host) return;
    host.style.visibility = v ? "hidden" : "visible";
    if (exposeForTests) host.toggleAttribute("data-sc-covered", v);
    if (!v && refocusWhenUncovered) {
      refocusWhenUncovered = false;
      const a = document.activeElement;
      if (!a || a === document.body || a === native) focusComposer();
    }
  }

  // 入力欄の 2 行分の高さ (行の高さ × 2 + 上下の余白)。見えている範囲がこれより低ければ、伸びない並びとみなす
  function twoLines(el) {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.5;
    return 2 * lh + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  }

  function place() {
    if (!active || !native || !native.isConnected) return;
    // 並びが替わったら、ChatGPT の入力欄の余白・もとの高さ・上限を測り直す (D-SC-30)
    const layout = composerLayout(native);
    if (layout !== lastLayout) {
      const changed = lastLayout !== "";
      lastLayout = layout;
      if (layout !== "single-line") { expandAt = 0; clearTimeout(expandTimer); }
      if (changed) { appliedMinH = 0; appliedW = 0; nativeCap = 0; pushTheme(); }
    }
    fitNativeHeight();
    const r = visibleRect(native);
    if (r.width < 40 || r.height < 8) { host && (host.style.display = "none"); return; }
    // 保護入力欄は ChatGPT の入力欄の見えている範囲にぴったり重ねる。要る高さに足りないとき:
    //  - 1 行の並び: ChatGPT の入力欄に空の段落を足してもらい、2 段の並びに替えてもらう (D-SC-27)。替わるまで
    //    (0.8 秒まで) は今の行に重ねたまま
    //  - 2 行分以上見えている (2 段の並びで ChatGPT の上限に達した): その高さを iframe の上限として渡し、
    //    iframe の中でスクロールさせる (D-SC-03)
    //  - 1 行の並びが替わらない (入力欄が ProseMirror でない、または替わらなかった)、2 行分も見えない並び:
    //    下の端を入力欄の行に置いたまま、保護入力欄を上に伸ばす。高さは画面の 40% まで (D-SC-17, D-SC-31)
    let top = r.top; // ネイティブの入力面の上端に合わせる
    let h = r.height;
    let up = false;
    if (iframeHeight > r.height + 2 && !draftEmpty) {
      const single = layout === "single-line";
      if (single ? !requestExpand() : r.height < twoLines(native)) {
        up = true;
        const bottom = r.top + r.height;
        top = Math.max(8, bottom - Math.min(iframeHeight, Math.round(window.innerHeight * 0.4)));
        h = bottom - top;
      } else if (!single) {
        const cap = Math.round(r.height);
        if (cap !== nativeCap) { nativeCap = cap; pushTheme(); }
      }
    }
    // ページのほかの表示に覆われているか (D-SC-36)。覆われている間は見せない (D-SC-37)
    const cov = coveredByPage(r);
    if (cov !== covered) setCovered(cov);
    if (up !== raisedUp) {
      raisedUp = up;
      if (up) nativeCap = 0; // 上に伸ばす間は、見えている範囲を上限にしない
      host.style.borderRadius = up ? "12px" : "0";
      host.style.boxShadow = up ? RAISED_SHADOW : "none";
      pushTheme();
    }
    const key = `${Math.round(r.left)},${Math.round(top)},${Math.round(r.width)},${Math.round(h)}`;
    if (key === lastRect && host.style.display !== "none") return;
    lastRect = key;
    host.style.display = "block";
    host.style.left = Math.round(r.left) + "px";
    host.style.top = Math.round(top) + "px";
    host.style.width = Math.round(r.width) + "px";
    host.style.height = Math.round(h) + "px";
    if (exposeForTests) host.setAttribute("data-sc-rect", key);
    if (orphaned) exportStaleLayout();
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
  // 送信と停止のボタンは、ChatGPT の入力欄を含む form の中で探す。会話の中のボタン
  // (「読み上げを停止」など) を取り違えないため。form が無い作りでは文書全体で探す
  const scopeOf = (el) => el.closest("form") || document;
  function shown(b) {
    if (!b || !b.isConnected || b.offsetParent === null) return false;
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== "hidden";
  }
  // 停止のボタンか (docs/release-1.7.1.md の D-SC-13)。送信ボタンと同じ要素や同じ id のことがあるので、送信ボタンを
  // 探すときも除く。
  //  - ログインなしの画面は、送信ボタンそのものが aria-label を data-stop-label (「生成を中止」) に替える
  //    (2026-10-29 に実サイトで確認)
  //  - ログイン後は data-testid="stop-button" と見込む (実物は未確認)
  //  - 言葉 (停止・中止・stop) で見分けるのは送信ボタンの場所だけ。form の中の「アップロードを中止」などを取り違えない
  function isStopButton(b) {
    if (b.matches('[data-testid*="stop"]')) return true;
    const label = b.getAttribute("aria-label") || "";
    const stopLabel = b.getAttribute("data-stop-label");
    if (stopLabel && label === stopLabel) return true;
    return b.matches(SLOT_SEL) && /停止|中止|stop/i.test(label);
  }
  // ChatGPT が回答を作っている途中か (停止のボタンが見えている)
  function pageBusy(el) {
    for (const b of scopeOf(el).querySelectorAll("button")) if (shown(b) && isStopButton(b)) return true;
    return false;
  }
  function findSendButton(scope) {
    for (const b of scope.querySelectorAll(SEND_SEL)) if (shown(b) && !b.disabled && !isStopButton(b)) return b;
    return null;
  }
  // ChatGPT の入力欄が空か (空白と記号を除いて何も残っていない)
  const nativeEmpty = (el) => comparable(el.tagName === "TEXTAREA" ? el.value : el.innerText) === "";
  function clearNative(el) {
    if (el.tagName === "TEXTAREA") { writeNative(el, ""); return; }
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges(); sel.addRange(range);
    document.execCommand("delete");
  }
  // fn が値を返すまで 50 ms ごとに試す。ms を過ぎたら null
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await new Promise((r) => setTimeout(r, 50));
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
      // 回答を作っている途中は ChatGPT が受け付けない。書かずに返し、下書きは保護入力欄に残す (F-SC-24)
      if (pageBusy(el)) return { committed: false, error: "page busy" };
      const wrote = writeNative(el, text);
      if (!wrote) return { committed: false, error: "write failed" };
      // 正規送信: 送信ボタンが出るのを待って押す。form の中に出なければ文書全体を一度だけ探し、
      // それでも無ければ Enter (F-SC-26)
      const btn = (await waitFor(() => findSendButton(scopeOf(el)), BUTTON_WAIT_MS)) || findSendButton(document);
      const path = btn ? "button" : "enter";
      if (btn) btn.click();
      else { el.focus(); fireEnter(el); }
      // 受け付けたか: 入力欄が空になった、または停止のボタンが出た (回答を作り始めた) (F-SC-25)。
      // 書いた入力欄が外れたときも受け付けたとみなす (新しい会話を送ると、ChatGPT は会話の画面に移って入力欄を
      // 作り直す。外れた要素には書いた文が残るので、空かどうかでは判断できない)
      const accepted = await waitFor(() => !el.isConnected || nativeEmpty(el) || pageBusy(el), ACCEPT_WAIT_MS);
      if (!accepted) {
        // 書いた文を残すと、保護入力欄の裏に隠れたままになる。消して、下書きは保護入力欄に残してもらう
        clearNative(el);
        return { committed: false, error: "not accepted", path };
      }
      return { committed: true, path };
    } catch (e) {
      return { committed: false, error: String((e && e.message) || e) };
    } finally {
      committing = false;
      // 書くために ChatGPT の入力欄に移したフォーカスが残っていたら、保護入力欄に戻す。続けて打った文字が
      // ChatGPT の入力欄に入らないように (送っている間は redirectFocus が戻さない、D-SC-38)
      const a = document.activeElement;
      if (active && native && a && (a === native || native.contains(a))) redirectFocus();
      // 書いたときにページの選択範囲が ChatGPT の入力欄に残る。残すと、あとでフォーカスがそこへ戻る (D-SC-39)
      dropNativeSelection();
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
    boundary.on("commit", async (payload) => {
      const r = await doCommit(payload);
      // 送れたら、アイコンの添付の警告を消してもらう (添付は送った文と一緒に出ていった、D-SC-25)
      if (r && r.committed) notePillSent();
      return r;
    });
    boundary.on("resize", (p) => {
      if (p && typeof p.height === "number") { iframeHeight = p.height; draftEmpty = p.empty === true; schedulePlace(); }
      return true;
    });
    // F-SC-16: オフのときの下書きの検出結果 (件数と種類の名前だけ)。同じ isolated world の composer-toggle の
    // 関数を直接呼ぶ。window のイベントはページも送れるので使わない (警告を消させない)
    boundary.on("draftinfo", (p) => { setPillDraftInfo(p); return true; });
    boundary.on("ready", () => {
      // 初めての ready は iframe が読み込まれたとき。それ以外はつなぎ直したとき (iframe は前の見た目を持っている)
      const first = !scReady;
      scReady = true;
      if (first) deliveredTheme = "";
      pushTheme(); schedulePlace(); reportLive(active && !!native);
      // 読み込み直後に ChatGPT が自分の入力欄にフォーカスしたとき、準備の前は保護入力欄に移せない。準備ができたら、
      // フォーカスが ChatGPT の入力欄にあれば、iframe の中から文の欄にフォーカスしてもらう (D-SC-38)。iframe に既に
      // あるときは頼まない (つなぎ直すたびに頼むと、打っている最中に文の欄のフォーカスを呼び直すことになる、D-SC-41)
      const a = document.activeElement;
      if (iframe && native && a && (a === native || native.contains(a))) { dropNativeSelection(); boundary.post("focus", {}); }
      return true;
    });
    boundary.on("state", () => true);
    // F-SC-10: SC がマスクした件数を同じ ISOLATED world の composer-toggle (ピル) へ渡す。
    boundary.on("maskinfo", (p) => {
      try { window.dispatchEvent(new CustomEvent("mask-mcp:sc-maskinfo", { detail: { maskedCount: (p && p.maskedCount) || 0 } })); } catch (_) {}
      return true;
    });
    boundary.on("blocked", () => { /* iframe が保護を保証できない: 重ねを外して従来経路に委ねる */ teardownOverlay(); return true; });
    // iframe の上にファイルのドラッグが来た (iframe はファイルを受けない)。透過にしてページ側へ通す。
    boundary.on("dragfiles", () => { dragPassthrough(); return true; });
    // 保護入力欄に貼られたファイル (D-SC-23)。添付の見張り (同じ ISOLATED world) に渡し、＋ ボタンや
    // ドラッグと同じく、伏せて (オン) から ChatGPT のファイルの入力に載せる。中身はページを通らない
    boundary.on("paste-files", async (p) => {
      const guard = window.__localMaskMCP && window.__localMaskMCP.attachmentGuard;
      if (!guard || typeof guard.attachFiles !== "function") return { attached: 0, blocked: 0, reason: "no-guard" };
      const files = (p && Array.isArray(p.files) ? p.files : []).slice(0, 10).map(fileFromPayload).filter(Boolean);
      if (!files.length) return { attached: 0, blocked: 0, reason: "empty" };
      return guard.attachFiles(files, "paste");
    });
  }
  // 連絡路で届いたファイル ({ name, type, lastModified, data: Base64 }) を File に戻す
  function fileFromPayload(f) {
    if (!f || typeof f.data !== "string") return null;
    try {
      const bin = atob(f.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const name = typeof f.name === "string" && f.name ? f.name : "pasted";
      return new File([bytes], name, { type: typeof f.type === "string" ? f.type : "", lastModified: Number(f.lastModified) || Date.now() });
    } catch (_) { return null; }
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
  // 見た目を iframe に送る。前に届けたものと同じなら送らない (つなぎ直すたびに送ると、iframe が文の欄の属性を
  // 付け直し、Windows の IME が状態を戻すことがある、D-SC-41)。届けたかどうかは、送ったときに相手がそろっていたかで
  // 見る (そろっていなければ、次の機会にもう一度送る)
  let deliveredTheme = "";
  function pushTheme() {
    if (!boundary || !native || orphaned) return;
    const t = readTheme(native);
    // iframe の要素の color-scheme も中と同じにする (違うと、ブラウザが iframe の下に不透明な地を敷く)
    if (iframe && iframe.style.colorScheme !== t.scheme) iframe.style.colorScheme = t.scheme;
    const key = JSON.stringify(t);
    if (key === deliveredTheme && boundary.isReady()) return;
    boundary.post("theme", t);
    deliveredTheme = boundary.isReady() ? key : "";
  }
  function notePillSent() {
    try {
      const ct = window.__localMaskMCP && window.__localMaskMCP.composerToggle;
      if (ct && typeof ct.noteSent === "function") ct.noteSent();
    } catch (_) { /* 何もしない */ }
  }
  function setPillDraftInfo(p) {
    try {
      const ct = window.__localMaskMCP && window.__localMaskMCP.composerToggle;
      if (ct && typeof ct.setScDraftInfo === "function") ct.setScDraftInfo(p || {});
    } catch (_) { /* 何もしない */ }
  }

  // 並びが替わる間 (ChatGPT は高さを 0.22 秒かけて動かす) も重ね直す (D-SC-30)。入力欄、入力欄の箱、form の
  // 大きさが変わったら、次の描画で重ね直す
  function observeSizes(el) {
    if (typeof ResizeObserver !== "function") return;
    if (!sizeObserver) sizeObserver = new ResizeObserver(() => schedulePlace());
    sizeObserver.disconnect();
    for (const t of [el, el.closest("[data-composer-input-layout]"), el.closest("form")]) if (t) sizeObserver.observe(t);
  }

  function attach(el) {
    native = el;
    ensureHost();
    observeSizes(el);
    if (!boundary && !orphaned) connectBoundary();
    // ネイティブ入力欄にフォーカスが来たら iframe に移す (原文をネイティブに打たせない)
    native.addEventListener("focusin", redirectFocus);
    native.addEventListener("mousedown", onNativeDown, true);
    // ネイティブへの Enter は無効化する。送信は doCommit がボタンのクリックで行うので、
    // commit 中にネイティブが一瞬 focus を持っても、迷子の Enter で二重送信されない (INV / 二重送信防止)。
    native.addEventListener("keydown", onNativeKey, true);
    pushTheme();
    schedulePlace();
    // 作り直された入力欄に、見つける前から ChatGPT がフォーカスしていた (新しい会話への移動など)。保護入力欄に戻す
    const a = document.activeElement;
    if (a && (a === native || native.contains(a))) redirectFocus();
  }
  // 保護入力欄にフォーカスを移す (D-SC-38)。iframe の要素の focus() を同じ処理の中で呼ぶ (連絡路の状態に頼らず、
  // ChatGPT の入力欄に文字が入る隙を作らない)。続けて、文の欄へのフォーカスを連絡路で頼む (iframe の中で最後に
  // フォーカスがあった所が文の欄でないときのため)。連絡が切れたあとは、知らせのボタンへ (D-SC-21)
  function focusComposer() {
    dropNativeSelection();
    if (orphaned) { if (staleButton) try { staleButton.focus(); } catch (_) {} return; }
    // ページの側から iframe にフォーカスを渡すのは、保護入力欄の準備ができてから。読み込み中の iframe (別のプロセス) に
    // 渡すと、Chrome の中でキー入力の行き先がずれ、打った文字がどこにも入らないことがある (負荷をかけた繰り返しで確認)。
    // 準備の前は、準備ができたときに iframe の中から文の欄にフォーカスしてもらう (ready の受け口)
    if (iframe && scReady) { try { iframe.focus(); } catch (_) {} }
    if (boundary) boundary.post("focus", {});
  }
  // ページの選択範囲が ChatGPT の入力欄の中に残っていたら消す (D-SC-39)。残っていると、ページがフォーカスを取り戻すとき
  // (保護入力欄をクリックした瞬間など) に、Chrome が選択範囲のある ChatGPT の入力欄にフォーカスを戻し、打った文字が
  // そこに入る。ProseMirror は、フォーカスの無いときの選択範囲の変化を読まない (中身の選択は変わらない)
  function dropNativeSelection() {
    try {
      const sel = document.getSelection();
      if (sel && sel.rangeCount && native && sel.anchorNode && native.contains(sel.anchorNode)) sel.removeAllRanges();
    } catch (_) { /* 何もしない */ }
  }
  // ChatGPT の入力欄にフォーカスが来たら、その場で保護入力欄に移す (F-SC-44)。送っている途中 (doCommit が ChatGPT の
  // 入力欄に書く間) は移さない。覆われている間は外すだけにし、覆いが消えたら移す (D-SC-37)
  function redirectFocus() {
    if (!active || committing) return;
    if (covered) { refocusWhenUncovered = true; try { native.blur(); } catch (_) {} dropNativeSelection(); return; }
    focusComposer();
  }
  // ChatGPT が入力欄を作り直して、新しい入力欄にすぐフォーカスしたとき (新しい会話への移動など)、見張りを付け直す前に
  // 打った文字がそこに入らないように、ページ全体のフォーカスを見て、その場で付け直して戻す (D-SC-39)。
  // 対象は送信の入力欄の id だけにする (会話の中の「編集」の入力欄などには触れない)
  const COMPOSER_IDS = new Set(["prompt-textarea", "mobile-composer-prompt"]);
  function onDocFocusIn(e) {
    if (!active) return;
    const t = e.target;
    if (!t || t === native || !t.id || !COMPOSER_IDS.has(t.id) || !isEditable(t) || !visible(t)) return;
    adopt(t); // attach() が、フォーカスのある新しい入力欄から保護入力欄に戻す
    // 送っている途中に作り直された入力欄は、書き込みの相手 (doCommit が持つ前の入力欄) ではないので、その場で戻す。
    // attach() の redirectFocus は、送っている途中は戻さない
    if (committing && document.activeElement === t) {
      if (covered) { refocusWhenUncovered = true; try { t.blur(); } catch (_) {} dropNativeSelection(); }
      else focusComposer();
    }
  }
  function onNativeDown(e) {
    if (!active || committing) return;
    e.preventDefault();
    if (!covered) focusComposer();
  }
  function onNativeKey(e) {
    if (!active || committing) {
      // commit 中 (doCommit がボタンを押す瞬間) はネイティブのキーに触らない
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); focusComposer(); }
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
  // 新しい ChatGPT の入力欄に付け替える (前の入力欄の見張りは外す)
  function adopt(el) {
    if (native) { restoreNativeHeight(); native.removeEventListener("focusin", redirectFocus); native.removeEventListener("mousedown", onNativeDown, true); native.removeEventListener("keydown", onNativeKey, true); }
    active = true;
    attach(el);
  }
  function sync() {
    if (!orphaned && !contextAlive()) goStale();
    const el = findNative();
    if (el && el !== native) adopt(el);
    else if (el && !active) { active = true; host && (host.style.display = "block"); }
    else if (!el) { restoreNativeHeight(); native = null; if (host) host.style.display = "none"; reportLive(false); } // 入力欄が消えたら素通ししない
    if (active) schedulePlace();
    // 入力欄があり iframe も ready なら live を再確認 (SPA の作り直しからの復帰)。
    // 連絡が切れたあとは知らせない (content.js も拡張機能の機能を使えず、設定を配り直せない)
    if (!orphaned) reportLive(active && scReady && !!native);
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
    // ページの要素が増えたり減ったりしたら、すぐ重ね直す (ダイアログやメニューに覆われたかを調べる、D-SC-36)
    const mo = new MutationObserver(() => { scheduleSync(); schedulePlace(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // 作り直された入力欄にフォーカスが来たら、その場で付け直して保護入力欄に戻す (D-SC-39)
    document.addEventListener("focusin", onDocFocusIn, true);
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
