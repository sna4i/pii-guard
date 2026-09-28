// engine/user-force-mask.js — user-curated force-mask list.
//
// ユーザーがサイドバーに文字列をドラッグ & ドロップで登録した
// "絶対にマスクしたい" 値のリストを、通常の regex / 辞書検出
// パイプラインに追加する。
//
// 永続化: chrome.storage.local.maskForceList = [{ value, category }]
// マッチ戦略: 完全一致 (case-sensitive、正規表現展開なし)
// 権限: content.js 経由の settings sync で injected.js に配布
"use strict";

(function attach(root) {
  const ALLOWED_CATEGORIES = [
    "PERSON",
    "LOCATION",
    "ORGANIZATION",
    "CONTACT",
    "FINANCIAL",
    "CREDENTIAL",
    "IDENTITY",
    "INTERNAL_ID",
    "OTHER",
  ];

  function normalizeCategory(c) {
    const upper = typeof c === "string" ? c.toUpperCase() : "";
    return ALLOWED_CATEGORIES.includes(upper) ? upper : "OTHER";
  }

  function entityTypeFor(category) {
    return "USER_DEFINED_" + normalizeCategory(category);
  }

  /**
   * Build detections for every occurrence of each user entry.
   * Exact string match, case-sensitive (設計判断 1-a)。
   *
   * @param {string} text - sanitize 対象の入力テキスト
   * @param {Array<{value:string, category?:string}>} entries - ユーザー登録リスト
   * @returns {Array<object>} Detection オブジェクトの配列
   */
  function detectUserForceMask(text, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    if (typeof text !== "string" || !text) return [];

    const out = [];
    for (const entry of entries) {
      if (!entry || typeof entry.value !== "string" || entry.value.length === 0) continue;
      const value = entry.value;
      const entityType = entityTypeFor(entry.category);

      let start = 0;
      while (start <= text.length) {
        const idx = text.indexOf(value, start);
        if (idx < 0) break;
        out.push({
          entity_type: entityType,
          start: idx,
          end: idx + value.length,
          text: value,
          score: 1.0,
          action: "masked",
        });
        // overlapping substring は不要 — 次は match 終端以降から探索。
        start = idx + value.length;
      }
    }
    return out;
  }

  const api = {
    ALLOWED_CATEGORIES,
    normalizeCategory,
    entityTypeFor,
    detectUserForceMask,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { userForceMask: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
