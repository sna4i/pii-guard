// engine/force-mask.js — port of src/app/services/force_mask.py.
// PHASE 1: plain substring match (case-insensitive for ASCII).
// PHASE 2 TODO: Kuromoji POS-aware match for Japanese keywords.
"use strict";

(function attach(root) {
  const DEFAULT_KEYWORDS = ["リーク", "未公開", "機密", "confidential", "leak"];
  const DEFAULT_CATEGORIES = ["PERSON", "ORGANIZATION", "FINANCIAL"];

  function isAsciiKeyword(keyword) {
    for (const ch of keyword) {
      if (ch.charCodeAt(0) > 127) return false;
    }
    return true;
  }

  function detectForceMaskTrigger(text, keywords) {
    if (!text || !keywords || keywords.length === 0) return [];
    const fired = [];
    const textLower = text.toLowerCase();
    for (const kw of keywords) {
      if (!kw) continue;
      if (isAsciiKeyword(kw)) {
        if (textLower.indexOf(kw.toLowerCase()) !== -1) fired.push(kw);
      } else {
        // Phase 2 TODO: Kuromoji POS-aware check (currently plain substring).
        if (text.indexOf(kw) !== -1) fired.push(kw);
      }
    }
    return fired;
  }
  function resolveForcedCategories(fired, configuredCategories) {
    if (!fired || fired.length === 0) return [];
    const seen = new Set(), out = [];
    for (const cat of configuredCategories || []) {
      if (!seen.has(cat)) { seen.add(cat); out.push(cat); }
    }
    return out;
  }
  function applyForceMask(aggregated, forcedCategories) {
    if (!forcedCategories || forcedCategories.length === 0) return aggregated.slice();
    const forced = new Set(forcedCategories);
    return aggregated.map((e) =>
      forced.has(e.category) && !e.masked ? { ...e, masked: true } : e
    );
  }

  const api = { DEFAULT_KEYWORDS, DEFAULT_CATEGORIES, detectForceMaskTrigger, resolveForcedCategories, applyForceMask };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { forceMask: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
