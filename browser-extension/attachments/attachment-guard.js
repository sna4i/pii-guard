// attachments/attachment-guard.js — 添付ファイルの中身とファイル名を、ページが読む前にマスクする
// (F-SC-07/08/13, F-EG-05/06)。
//
// 背景 (実測):
//   - ChatGPT: 添付の中身は POST /backend-api/files → PUT *.oaiusercontent.com/files/<uuid>/raw で、
//     入力欄も Secure Composer も通らずに別オリジンへ直接出る。
//   - Claude (2026-10-18): テキストの添付は送信の本文 (PerformAction) に中身とファイル名が入る。
//   - Gemini (2026-10-18): ファイルを選んだ瞬間に push.clients6.google.com/upload/ へ名前と中身が出る。
//   - Manus (2026-10-18): ファイルを選んだ瞬間に GenerateDocumentSuggestion へ中身が、Amplitude へ
//     ファイル名が出る。
// どれも「ページがファイルを読む前に、マスク済みの File に差し替える」で塞がる (後段の通信は全部、
// マスク済みの中身と名前しか運ばない)。通信だけを書き換えるとサイズや形の不整合で壊れる。
//
// 実装 (content script = ISOLATED world、document_start で window の capture に登録):
//   - ファイル選択: file input の change を捕まえ、ページが元ファイルを読む前に止めて差し替え、投げ直す。
//     ページにつながっていない input は change が window に届かないので、MAIN world の injected.js が
//     click の前にページへつなぐ。
//   - ドラッグ&ドロップ: drop を先に捕まえて止める。ChatGPT と、ページに汎用の file input がある
//     サイト (Claude) はその input に載せて change を投げる (＋ボタンと同じ経路)。input が無いサイト
//     (Gemini・Manus) は、マスク済みの File を載せた drop を落とした場所へ投げ直す。
//     ChatGPT の入力欄の上は iframe が重なっているので、ファイルのドラッグ中だけ adapter が透過にする。
//   - ファイルの貼り付け: 同じく止めて、マスク済みの File (と一緒に貼られた文字) で投げ直す。
//   - ダイアログ (プロジェクトのファイル追加など) への drop は、行き先を取り違えないよう止めて知らせる。
//   - マスキング ON: テキストは中身とファイル名をマスクする。バイナリ/巨大/マスク失敗/文字コード不明は
//     fail-closed で止め、ピルに警告。マスキング OFF: 利用者の選択どおり通し、「未マスク」を知らせる。
//   - エンジンも除外リスト等の機密も ISOLATED world 側を使う (MAIN world に出さない, V-02)。
"use strict";

(function attach() {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof chrome === "undefined" || !chrome.storage) return;
  const HOST = location.hostname;
  if (!/(^|\.)(chatgpt\.com|openai\.com|claude\.ai|claude\.com|gemini\.google\.com|manus\.im)$/.test(HOST)) return;

  const NS = (window.__localMaskMCP = window.__localMaskMCP || {});
  const E2E_FLAG = "__pii_guard_e2e";
  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|ya?ml|xml|html?|ini|conf|cfg|srt|vtt|rtf|tex)$/i;
  const TEXT_MIME = /^text\/|application\/(json|xml|x-yaml|x-ndjson|csv)/i;
  const MAX_TEXT_BYTES = 2 * 1024 * 1024; // これを超えるテキストはマスクに時間がかかるのでブロック側へ
  const EDITOR_SEL = '#prompt-textarea, div.ProseMirror[contenteditable="true"], textarea#mobile-composer-prompt, .ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"]';
  // 入力欄のある AI サイト本体。ここでは drop を常に横取りする (openai.com の別画面は入力欄があるときだけ)。
  const CHAT_HOST = /(^|\.)(chatgpt\.com|claude\.ai|claude\.com|gemini\.google\.com|manus\.im)$|^chat\.openai\.com$/.test(HOST);
  const IS_CHATGPT = /(^|\.)chatgpt\.com$|(^|\.)openai\.com$/.test(HOST);

  // 設定が読めるまでは「マスク ON」として扱う (読み込み前の添付も素通しさせない)。
  const settings = { enabled: true, maskForceList: [], mlEnabled: false };
  let exposeForTests = false;
  async function loadSettings() {
    try {
      const s = await chrome.storage.local.get(["enabled", "maskForceList", "mlEnabled", E2E_FLAG]);
      settings.enabled = s.enabled !== false;
      settings.mlEnabled = s.mlEnabled === true;
      exposeForTests = s[E2E_FLAG] === true;
      settings.maskForceList = Array.isArray(s.maskForceList)
        ? s.maskForceList.map((e) => (typeof e === "string" ? { value: e, category: "OTHER" }
            : e && typeof e.value === "string" ? { value: e.value, category: typeof e.category === "string" ? e.category : "OTHER" } : null)).filter(Boolean)
        : [];
    } catch (_) {}
  }
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local") loadSettings(); });

  const engineReady = () => !!(NS.engine && NS.engine.ready && typeof NS.engine.maskSanitize === "function");
  const isText = (file) => TEXT_EXT.test(file.name || "") || TEXT_MIME.test(file.type || "");
  const opts = () => ({ userForceMaskEntries: settings.maskForceList, mlEnabled: settings.mlEnabled });
  const LOG = (...a) => console.debug("[pii-guard] attachment-guard:", ...a); // 値は出さない (件数と経路だけ)

  // 日本の CSV は Shift_JIS、Windows のツールは UTF-16 で書くことが多い。UTF-8 決め打ちだと
  // 文字化けで検出できず、UTF-16 は数字の間に NUL が挟まってパターンをすり抜ける。
  // BOM → UTF-8 (厳密) → Shift_JIS の順に読み、NUL が残るものは読めていない扱い (fail-closed)。
  function decodeText(buf) {
    const b = new Uint8Array(buf);
    let text;
    if (b[0] === 0xff && b[1] === 0xfe) text = new TextDecoder("utf-16le").decode(buf);
    else if (b[0] === 0xfe && b[1] === 0xff) text = new TextDecoder("utf-16be").decode(buf);
    else {
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
      catch (_) { text = new TextDecoder("shift_jis").decode(buf); }
    }
    if (text.includes("\u0000")) throw new Error("undecodable text (NUL)");
    return text;
  }

  // ファイル名の個人情報も伏せる (拡張子は残す)。伏せ字の < > はファイル名に向かないので [ ] にする
  async function maskName(name) {
    const m = /^(.*?)(\.[A-Za-z0-9]{1,8})?$/.exec(String(name || ""));
    const base = m ? m[1] : String(name || "");
    const ext = m && m[2] ? m[2] : "";
    if (!base) return { name, count: 0 };
    const res = await NS.engine.maskSanitize(base, opts());
    if (!res || typeof res.sanitized_text !== "string") throw new Error("mask produced no name");
    const count = Array.isArray(res.detections) ? res.detections.length : 0;
    return { name: count ? res.sanitized_text.replace(/</g, "[").replace(/>/g, "]") + ext : name, count };
  }

  async function maskOneFile(file) {
    const text = decodeText(await file.arrayBuffer());
    const res = await NS.engine.maskSanitize(text, opts());
    if (!res || typeof res.sanitized_text !== "string") throw new Error("mask produced no text");
    const nm = await maskName(file.name);
    const count = (Array.isArray(res.detections) ? res.detections.length : 0) + nm.count;
    // 出力は UTF-8。元が Shift_JIS/UTF-16 でも、サイトは UTF-8 のほうが確実に読める。
    const out = new File([res.sanitized_text], nm.name, { type: file.type || "text/plain", lastModified: Date.now() });
    return { file: out, count };
  }

  // 元ファイル群 → { masked: File[] (渡すもの), blocked: string[], unmasked: string[], maskedCount }。
  async function processFiles(fileList) {
    const masked = [];
    const blocked = [];
    const unmasked = [];
    let maskedCount = 0;
    for (const f of Array.from(fileList || [])) {
      if (!settings.enabled) {
        // マスキング OFF: 中身はそのまま通す (利用者の選択)。未マスクであることだけ知らせる。
        masked.push(f); unmasked.push(f.name);
      } else if (isText(f) && f.size <= MAX_TEXT_BYTES && engineReady()) {
        try { const m = await maskOneFile(f); masked.push(m.file); maskedCount += m.count; }
        catch (_) { blocked.push(f.name); }
      } else {
        blocked.push(f.name); // バイナリ/巨大/エンジン不在 → マスク不能なのでブロック
      }
    }
    return { masked, blocked, unmasked, maskedCount };
  }

  function notifyPill(r, reason) {
    const detail = { maskedCount: r.maskedCount, blocked: r.blocked.slice(), unmasked: r.unmasked.slice(), reason: reason || "" };
    try { window.dispatchEvent(new CustomEvent("mask-mcp:attachment", { detail })); } catch (_) {}
    if (exposeForTests) NS.__lastAttachment = { ...detail, at: Date.now() };
  }

  const dataTransferOf = (files) => { const dt = new DataTransfer(); for (const f of files) dt.items.add(f); return dt; };
  function setInputFiles(input, files) { input.files = dataTransferOf(files).files; }

  // input の accept (".txt,.pdf,text/*" 等) が、このファイルを受けるか
  function accepts(input, file) {
    const acc = String(input.accept || "").trim();
    if (!acc || acc === "*" || acc === "*/*") return true;
    const name = String(file.name || "").toLowerCase();
    const type = String(file.type || "").toLowerCase();
    return acc.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).some((a) =>
      a.startsWith(".") ? name.endsWith(a) : a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a);
  }
  // 渡すファイルを全部受けるページの file input (入力欄の form 内を優先、何でも受ける・複数可を優先)。
  // id は React の useId 等で変わるので属性で選ぶ。見つからなければ null。
  function findUploadInput(files) {
    const pick = (scope) => {
      if (!scope) return null;
      const ok = Array.from(scope.querySelectorAll('input[type="file"]')).filter((i) => !i.disabled && files.every((f) => accepts(i, f)));
      const rank = (i) => (accepts(i, { name: "x.bin", type: "application/octet-stream" }) ? 2 : 0) + (i.multiple ? 1 : 0);
      return ok.sort((a, b) => rank(b) - rank(a))[0] || null;
    };
    const editor = document.querySelector(EDITOR_SEL);
    return pick(editor && editor.closest("form")) || pick(document);
  }

  const reentrant = new WeakSet(); // 投げ直した change を自分で再処理しないため
  const ours = new WeakSet();      // 投げ直した drop / paste を自分で再処理しないため

  async function onChange(e) {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
    if (reentrant.has(input)) { reentrant.delete(input); return; }
    const files = input.files;
    if (!files || files.length === 0) return;
    // ページ (React 等) が元ファイルを読む前に止める
    e.stopImmediatePropagation();
    e.preventDefault();
    const r = await processFiles(files);
    reentrant.add(input);
    setInputFiles(input, r.masked); // ブロック分は除外。マスク済み (OFF なら元のまま) だけを渡す
    input.dispatchEvent(new Event("change", { bubbles: true }));
    notifyPill(r);
  }

  // ---- ドラッグ&ドロップ (F-SC-13 / F-EG-05) ------------------------------------------
  const hasFiles = (dt) => !!dt && Array.prototype.includes.call(dt.types || [], "Files");

  // ページは dragenter/dragleave の対で「ここにドロップ」の表示を出し入れする。drop を止めると
  // 閉じる合図が届かないので、落とした要素に dragleave を送って閉じさせる (中身は空)。
  function closePageDropUi(target) {
    try {
      const el = target && target.isConnected ? target : document.documentElement;
      el.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, composed: true, dataTransfer: new DataTransfer() }));
    } catch (_) {}
  }

  async function onDrop(e) {
    if (ours.has(e) || !hasFiles(e.dataTransfer)) return;
    // openai.com の別画面 (platform 等のアップロード画面) は、入力欄があるときだけ
    if (!CHAT_HOST && !document.querySelector(EDITOR_SEL)) return;
    // DataTransfer はイベントの間しか読めないので、先に File を取り出しておく
    const files = Array.from(e.dataTransfer.files || []);
    if (!settings.enabled) {
      // マスキング OFF: ページの drop 処理にそのまま任せる (行き先もページのまま)。未マスクだけ知らせる。
      if (files.length) notifyPill({ maskedCount: 0, blocked: [], unmasked: files.map((f) => f.name) });
      return;
    }
    // ページに元ファイルを渡さない。ブラウザの既定動作 (ファイルを開く) も止める。
    e.preventDefault();
    e.stopImmediatePropagation();
    const t = e.target;
    const point = { clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY };
    if (files.length === 0) { closePageDropUi(t); return; }
    if (t && t.closest && t.closest('[role="dialog"], dialog')) {
      // 行き先 (プロジェクトのファイル等) を入力欄の添付と取り違えないよう止める。
      closePageDropUi(t);
      notifyPill({ maskedCount: 0, blocked: files.map((f) => f.name), unmasked: [] }, "dialog");
      return;
    }
    const r = await processFiles(files);
    let reason = "";
    if (!r.masked.length) closePageDropUi(t);
    else {
      const input = findUploadInput(r.masked);
      if (input) {
        closePageDropUi(t);
        reentrant.add(input);
        setInputFiles(input, r.masked);
        input.dispatchEvent(new Event("change", { bubbles: true }));
        LOG(`drop → file input (${r.masked.length} file(s))`);
      } else if (!IS_CHATGPT && t && t.isConnected) {
        // input の無いサイト: マスク済みの File を載せた drop を、落とした場所へ投げ直す
        const ev = new DragEvent("drop", { bubbles: true, cancelable: true, composed: true, ...point, dataTransfer: dataTransferOf(r.masked) });
        ours.add(ev);
        const accepted = !t.dispatchEvent(ev);
        LOG(`drop → re-dispatched on <${t.tagName.toLowerCase()}> (${r.masked.length} file(s), page ${accepted ? "accepted" : "did not cancel"})`);
      } else {
        LOG(`drop → no target (target ${t ? (t.isConnected ? "connected" : "detached") : "none"})`);
        // 渡し先が見つからない: 送らない (fail-closed)
        closePageDropUi(t);
        r.blocked.push(...r.masked.map((f) => f.name));
        r.masked = [];
        reason = "no-target";
      }
    }
    notifyPill(r, reason);
  }

  // ---- ファイルの貼り付け (F-EG-05) ---------------------------------------------------
  // スクリーンショットや、ファイラでコピーしたファイルの貼り付け。文字だけの貼り付けには触らない。
  async function onPaste(e) {
    if (ours.has(e)) return;
    const cd = e.clipboardData;
    const files = cd && cd.files ? Array.from(cd.files) : [];
    if (!files.length) return;
    if (!settings.enabled) { notifyPill({ maskedCount: 0, blocked: [], unmasked: files.map((f) => f.name) }); return; }
    const text = cd.getData("text/plain");
    const html = cd.getData("text/html");
    const target = e.target;
    e.preventDefault();
    e.stopImmediatePropagation();
    const r = await processFiles(files);
    if (r.masked.length || text) {
      const dt = dataTransferOf(r.masked);
      if (text) dt.setData("text/plain", text);
      if (html) dt.setData("text/html", html);
      const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt });
      ours.add(ev);
      const el = target && target.isConnected ? target : document.activeElement || document.body;
      const handled = !el.dispatchEvent(ev);
      // 貼り付けを自分で処理しない入力欄 (素の textarea 等) には、文字だけ入れる
      if (!handled && text && document.activeElement && (document.activeElement.isContentEditable || /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName))) {
        try { document.execCommand("insertText", false, text); } catch (_) {}
      }
    }
    if (r.maskedCount || r.blocked.length) notifyPill(r);
  }

  // document_start で、ページのスクリプトより先に window の capture に付ける。
  window.addEventListener("change", onChange, true);
  window.addEventListener("drop", onDrop, true);
  window.addEventListener("paste", onPaste, true);
  loadSettings();

  // テスト用の最小公開
  if (typeof module === "object" && module.exports) module.exports = { isText, processFiles, decodeText, _internal: { settings } };
  NS.attachmentGuard = { isText };
})();
