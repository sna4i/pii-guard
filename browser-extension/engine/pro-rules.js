// engine/pro-rules.js — Pro 版のルールパック (docs/pro-license.md の F-PRO-06、D-PRO-07)
//
// エンジンは、Pro のとき (engine.setProEnabled(true)) だけ、ここのルールを今のルールに足す。
// 形は patterns.js のルールと同じ { entity_type, pattern, validate? } に、止める単位の category を足したもの。
// Phase 1 では中身は空。Phase 2 で、カスタムルールなどをここから足す。
"use strict";

(function attach(root) {
  const PRO_RULE_PACK = [];

  // 止めた分類 (disabledCategories) は、今のルールと同じく使わない
  function getProPatterns(disabledCategories) {
    if (PRO_RULE_PACK.length === 0) return PRO_RULE_PACK;
    const disabled = disabledCategories instanceof Set ? disabledCategories : new Set(disabledCategories || []);
    return PRO_RULE_PACK.filter((p) => !disabled.has(p.category || p.entity_type));
  }

  const api = { PRO_RULE_PACK, getProPatterns };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { proRules: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
