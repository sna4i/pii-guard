// attachments/attachment-guard.js — 添付ファイルの中身を、アップロード前にマスクする (F-SC-07/08)。
//
// 背景 (実測): ChatGPT の添付は、入力欄も Secure Composer も通らず、
//   POST /backend-api/files → PUT *.oaiusercontent.com/files/<uuid>/raw → POST process_upload_stream
// の流れで中身が別オリジンへ直接 PUT される。だから「先にマスクしてからファイル化」= ファイル
// 選択の瞬間に横取りして差し替えるのが正道 (PUT だけ書き換えるとサイズ不整合で壊れる)。
//
// 実装 (content script = ISOLATED world、document_start で window の capture に登録):
//   - file input の change を捕まえ、ページ (React) が元ファイルを読む前に止める。
//     テキスト系はエンジンでマスクし、マスク済み内容の File に差し替えて change を投げ直す。
//   - ドラッグ&ドロップ (F-SC-13): ページのどこへの drop でも先に捕まえて止め、マスク済み File を
//     ChatGPT 自身の「何でも受ける」file input に載せて change を投げる (＋ボタンと同じ経路)。
//     入力欄の上は iframe が重なっているので、ファイルのドラッグ中だけ adapter が iframe を透過に
//     して、drop がこちら (ページ側) に落ちるようにしている。
//   - ダイアログ (プロジェクトのファイル追加など) への drop は、行き先を取り違えないよう止めて
//     ファイル選択 (こちらは change でマスクされる) を使うよう知らせる。
//   - マスキング ON: バイナリ/巨大/マスク失敗/文字コード不明は fail-closed でブロックし、ピルに警告。
//     マスキング OFF: 利用者の選択どおり全部通し、「未マスクの添付」としてピルに知らせる (F-SC-08)。
//   - エンジンも除外リスト等の機密も ISOLATED world 側を使う (MAIN world に出さない, V-02)。
"use strict";

(function attach() {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof chrome === "undefined" || !chrome.storage) return;
  if (!/(^|\.)(chatgpt\.com|openai\.com)$/.test(location.hostname)) return;

  const NS = (window.__localMaskMCP = window.__localMaskMCP || {});
  const E2E_FLAG = "__pii_guard_e2e";
  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|ya?ml|xml|html?|ini|conf|cfg|srt|vtt|rtf|tex)$/i;
  const TEXT_MIME = /^text\/|application\/(json|xml|x-yaml|x-ndjson|csv)/i;
  const MAX_TEXT_BYTES = 2 * 1024 * 1024; // これを超えるテキストはマスクに時間がかかるのでブロック側へ
  const EDITOR_SEL = '#prompt-textarea, div.ProseMirror[contenteditable="true"], textarea#mobile-composer-prompt';
  // ChatGPT 本体。ここでは drop を常に横取りする (入力欄の作り直し中でも素通しさせない)。
  const CHATGPT_HOST = /(^|\.)chatgpt\.com$|^chat\.openai\.com$/.test(location.hostname);

  // 設定が読めるまでは「SC 有効・マスク ON」として扱う (読み込み前の添付も素通しさせない)。
  const settings = { enabled: true, scEnabled: true, maskForceList: [], mlEnabled: false };
  let exposeForTests = false;
  async function loadSettings() {
    try {
      const s = await chrome.storage.local.get(["enabled", "secureComposerEnabled", "maskForceList", "mlEnabled", E2E_FLAG]);
      settings.enabled = s.enabled !== false;
      settings.scEnabled = s.secureComposerEnabled !== false;
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

  async function maskOneFile(file) {
    const text = decodeText(await file.arrayBuffer());
    const res = await NS.engine.maskSanitize(text, { userForceMaskEntries: settings.maskForceList, mlEnabled: settings.mlEnabled });
    if (!res || typeof res.sanitized_text !== "string") throw new Error("mask produced no text");
    const count = Array.isArray(res.detections) ? res.detections.length : 0;
    // 出力は UTF-8。元が Shift_JIS/UTF-16 でも、ChatGPT は UTF-8 のほうが確実に読める。
    const out = new File([res.sanitized_text], file.name, { type: file.type || "text/plain", lastModified: Date.now() });
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

  function setInputFiles(input, files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
  }

  // ChatGPT 自身の「何でも受ける」file input (入力欄の form 内、accept 無し)。id は React の
  // useId (_r_g_ など) で変わるので属性で選ぶ。見つからなければ null (呼び出し側が fail-closed)。
  function findUploadInput() {
    const pick = (scope) => {
      if (!scope) return null;
      const all = Array.from(scope.querySelectorAll('input[type="file"]')).filter((i) => !i.accept);
      return all.find((i) => i.multiple) || all[0] || null;
    };
    const editor = document.querySelector(EDITOR_SEL);
    return pick(editor && editor.closest("form")) || pick(document);
  }

  const reentrant = new WeakSet(); // 投げ直した change を自分で再処理しないため

  async function onChange(e) {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
    if (reentrant.has(input)) { reentrant.delete(input); return; }
    if (!settings.scEnabled) return; // SC が担当するホストでのみ介入
    const files = input.files;
    if (!files || files.length === 0) return;
    // ページ (React) が元ファイルを読む前に止める
    e.stopImmediatePropagation();
    e.preventDefault();
    const r = await processFiles(files);
    reentrant.add(input);
    setInputFiles(input, r.masked); // ブロック分は除外。マスク済み (OFF なら元のまま) だけを渡す
    input.dispatchEvent(new Event("change", { bubbles: true }));
    notifyPill(r);
  }

  // ---- ドラッグ&ドロップ (F-SC-13) ---------------------------------------------
  const hasFiles = (dt) => !!dt && Array.prototype.includes.call(dt.types || [], "Files");

  // ChatGPT は dragenter/dragleave の対で「ここにドロップ」の表示を出し入れする。drop を止めると
  // 閉じる合図が届かないので、落とした要素に dragleave を送って閉じさせる (中身は空)。
  function closePageDropUi(target) {
    try {
      const el = target && target.isConnected ? target : document.documentElement;
      el.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, composed: true, dataTransfer: new DataTransfer() }));
    } catch (_) {}
  }

  async function onDrop(e) {
    if (!settings.scEnabled || !hasFiles(e.dataTransfer)) return;
    // ほかの openai.com (platform.openai.com 等のアップロード画面) は、ChatGPT の入力欄があるときだけ
    if (!CHATGPT_HOST && !document.querySelector(EDITOR_SEL)) return;
    // DataTransfer はイベントの間しか読めないので、先に File を取り出しておく
    const files = Array.from(e.dataTransfer.files || []);
    if (!settings.enabled) {
      // マスキング OFF: ChatGPT の drop 処理にそのまま任せる (行き先も ChatGPT のまま)。未マスクだけ知らせる。
      if (files.length) notifyPill({ maskedCount: 0, blocked: [], unmasked: files.map((f) => f.name) });
      return;
    }
    // ページ (ChatGPT の drop 処理) に元ファイルを渡さない。ブラウザの既定動作 (ファイルを開く) も止める。
    e.preventDefault();
    e.stopImmediatePropagation();
    const t = e.target;
    closePageDropUi(t);
    if (files.length === 0) return;
    if (t && t.closest && t.closest('[role="dialog"], dialog')) {
      // 行き先 (プロジェクトのファイル等) を入力欄の添付と取り違えないよう止める。
      notifyPill({ maskedCount: 0, blocked: files.map((f) => f.name), unmasked: [] }, "dialog");
      return;
    }
    const r = await processFiles(files);
    let reason = "";
    if (r.masked.length) {
      const input = findUploadInput();
      if (!input) {
        // 渡し先が見つからない: 送らない (fail-closed)
        r.blocked.push(...r.masked.map((f) => f.name));
        r.masked = [];
        reason = "no-target";
      } else {
        reentrant.add(input);
        setInputFiles(input, r.masked);
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    notifyPill(r, reason);
  }

  // document_start で、ページのスクリプトより先に window の capture に付ける。
  window.addEventListener("change", onChange, true);
  window.addEventListener("drop", onDrop, true);
  loadSettings();

  // テスト用の最小公開
  if (typeof module === "object" && module.exports) module.exports = { isText, processFiles, decodeText, _internal: { settings } };
  NS.attachmentGuard = { isText };
})();
