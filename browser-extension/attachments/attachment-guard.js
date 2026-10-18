// attachments/attachment-guard.js — 添付ファイルの中身を、アップロード前にマスクする (F-SC-07/08)。
//
// 背景 (実測): ChatGPT の添付は、入力欄も Secure Composer も通らず、
//   POST /backend-api/files → PUT *.oaiusercontent.com/files/<uuid>/raw → POST process_upload_stream
// の流れで中身が別オリジンへ直接 PUT される。だから「先にマスクしてからファイル化」= ファイル
// 選択の瞬間に横取りして差し替えるのが正道 (PUT だけ書き換えるとサイズ不整合で壊れる)。
//
// 実装 (content script = ISOLATED world):
//   - file input の change を capture フェーズで捕まえ、ページ (React) が元ファイルを読む前に止める。
//   - テキスト系はエンジンでマスクし、マスク済み内容の File に差し替えて change を投げ直す。
//   - バイナリ/巨大/マスク失敗は fail-closed でブロックし、ピルに警告 (F-SC-08)。
//   - エンジンも除外リスト等の機密も ISOLATED world 側を使う (MAIN world に出さない, V-02)。
//   - ドラッグ&ドロップも同様に drop を capture で捕まえ、file input 経由に載せ替える。
"use strict";

(function attach() {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof chrome === "undefined" || !chrome.storage) return;
  if (!/(^|\.)(chatgpt\.com|openai\.com)$/.test(location.hostname)) return;

  const NS = (window.__localMaskMCP = window.__localMaskMCP || {});
  const E2E_FLAG = "__pii_guard_e2e";
  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|ya?ml|xml|html?|ini|conf|cfg|srt|vtt|rtf|tex)$/i;
  const TEXT_MIME = /^text\/|application\/(json|xml|x-yaml|x-ndjson|csv)/i;
  const MAX_TEXT_BYTES = 2 * 1024 * 1024; // これを超えるテキストはマスクに時間がかかるのでブロック側へ

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

  async function maskOneFile(file) {
    const text = await file.text();
    const res = await NS.engine.maskSanitize(text, { userForceMaskEntries: settings.maskForceList, mlEnabled: settings.mlEnabled });
    if (!res || typeof res.sanitized_text !== "string") throw new Error("mask produced no text");
    const count = Array.isArray(res.detections) ? res.detections.length : 0;
    const out = new File([res.sanitized_text], file.name, { type: file.type || "text/plain", lastModified: Date.now() });
    return { file: out, count, changed: res.sanitized_text !== text };
  }

  // 元ファイル群 → { masked: File[], blocked: string[], maskedCount }。
  // テキスト以外・巨大・マスク失敗は blocked (fail-closed、アップロードさせない)。
  async function processFiles(fileList) {
    const masked = [];
    const blocked = [];
    let maskedCount = 0;
    for (const f of Array.from(fileList || [])) {
      if (settings.enabled && isText(f) && f.size <= MAX_TEXT_BYTES && engineReady()) {
        try { const m = await maskOneFile(f); masked.push(m.file); maskedCount += m.count; }
        catch (_) { blocked.push(f.name); }
      } else if (!settings.enabled && isText(f) && f.size <= MAX_TEXT_BYTES) {
        // マスキング OFF: 中身はそのまま通すが、未マスクであることをピルに知らせる (警告のみ)。
        masked.push(f); blocked.push("(未マスク) " + f.name);
      } else {
        blocked.push(f.name); // バイナリ/巨大/エンジン不在 → マスク不能なのでブロック
      }
    }
    return { masked, blocked, maskedCount };
  }

  function notifyPill(maskedCount, blocked) {
    try { window.dispatchEvent(new CustomEvent("mask-mcp:attachment", { detail: { maskedCount, blocked: blocked.slice() } })); } catch (_) {}
    if (exposeForTests) NS.__lastAttachment = { maskedCount, blocked: blocked.slice(), at: Date.now() };
  }

  function setInputFiles(input, files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
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
    const { masked, blocked, maskedCount } = await processFiles(files);
    reentrant.add(input);
    setInputFiles(input, masked); // ブロック分は除外。マスク済みだけを渡す
    input.dispatchEvent(new Event("change", { bubbles: true }));
    notifyPill(maskedCount, blocked);
  }

  // ドラッグ&ドロップ: ページが drop を処理する前に止め、隠し input に載せ替えて同じ経路へ。
  let dropInput = null;
  function ensureDropInput() {
    if (dropInput && dropInput.isConnected) return dropInput;
    dropInput = document.createElement("input");
    dropInput.type = "file";
    dropInput.multiple = true;
    dropInput.style.display = "none";
    (document.body || document.documentElement).appendChild(dropInput);
    dropInput.addEventListener("change", onChange, true);
    return dropInput;
  }
  async function onDrop(e) {
    const dt = e.dataTransfer;
    if (!dt || !dt.files || dt.files.length === 0) return;
    // 入力欄まわりへのドロップだけ対象 (ページ全体の他の drop は邪魔しない)
    const target = e.target;
    const composerish = target && (target.closest && (target.closest('[data-composer-input]') || target.closest('form') || target.closest('[class*="composer" i]')));
    if (!composerish) return;
    if (!settings.scEnabled) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const inp = ensureDropInput();
    reentrant.delete(inp);
    setInputFiles(inp, Array.from(dt.files));
    // onChange を直接呼ぶ (隠し input にはページのハンドラが付いていないので投げ直し不要)
    const fake = { target: inp, stopImmediatePropagation() {}, preventDefault() {} };
    await onChange(fake);
  }

  loadSettings().then(() => {
    document.addEventListener("change", onChange, true);
    document.addEventListener("drop", onDrop, true);
  });

  // テスト用の最小公開
  if (typeof module === "object" && module.exports) module.exports = { isText, processFiles, _internal: { settings } };
  NS.attachmentGuard = { isText };
})();
