// security/leak-detector.js — 文字列が「別の形に変えられた状態で」含まれていないかを調べる。
//
// 使う場所は 2 つ:
//   1. Secure Composer (iframe) の送信前の自己検査。伏せた後の本文に、伏せたはずの
//      値がそのまま、あるいは変換された形で残っていないかを確かめる (fail-closed)
//   2. テスト (tests/fixtures)。通信の URL・ヘッダー・本文・WebSocket のフレームに
//      カナリアが混ざっていないかを調べる
//
// 検査する形 (spec 12.2):
//   raw / NFC / NFKC / 全角・半角 / JSON エスケープ / \uXXXX エスケープ /
//   URL エンコード (encodeURIComponent と form の + 区切り) / Base64 (3 通りの区切り位置)
//
// 依存なしの UMD。Node (require) でも、拡張機能のページ (script タグ) でも、
// service worker (import) でも同じものを使う。文字列はログに出さない。
"use strict";

(function attach(root) {
  const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

  function utf8Bytes(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    // eslint-disable-next-line no-undef
    return Uint8Array.from(Buffer.from(s, "utf8"));
  }

  function base64OfBytes(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // 全角英数字・記号 (U+FF01–FF5E) と半角の相互変換。NFKC では半角→全角は作れないので別に持つ
  function toFullWidth(s) {
    return String(s).replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  }

  // JSON.stringify の ensure_ascii 相当 (非 ASCII を \uXXXX にする)
  function jsonAsciiEscape(s) {
    return JSON.stringify(String(s)).slice(1, -1).replace(/[\u007f-￿]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }

  // Base64 は前に何バイトあるかで区切りが変わる。0/1/2 バイトずらした 3 通りについて、
  // 前後の他のバイトに影響される端の 4 文字を落とした「必ず現れる部分」を作る
  function base64Cores(value) {
    const b = utf8Bytes(value);
    const out = [];
    for (let k = 0; k < 3; k++) {
      const padded = new Uint8Array(k + b.length);
      padded.set(b, k);
      let s = base64OfBytes(padded).replace(/=+$/, "");
      const head = k === 0 ? 0 : 4;
      const tailPartial = (k + b.length) % 3 !== 0;
      s = s.slice(head, tailPartial ? Math.max(head, s.length - 4) : s.length);
      if (s.length >= 8) out.push(s);
    }
    return out;
  }

  /**
   * value のさまざまな変換形を返す。
   * @param {string} value
   * @returns {Array<{kind:string, text:string}>} 重複は除く。短すぎる形 (2 文字未満) は返さない
   */
  function variantsOf(value) {
    const v = String(value == null ? "" : value);
    const seen = new Set();
    const out = [];
    const add = (kind, text) => {
      if (typeof text !== "string" || text.length < 2 || seen.has(text)) return;
      seen.add(text);
      out.push({ kind, text });
    };
    add("raw", v);
    add("nfc", v.normalize("NFC"));
    add("nfkc", v.normalize("NFKC"));
    add("fullwidth", toFullWidth(v.normalize("NFKC")));
    add("no-zero-width", v.replace(ZERO_WIDTH, ""));
    add("json", JSON.stringify(v).slice(1, -1));
    add("json-ascii", jsonAsciiEscape(v));
    add("json-double", JSON.stringify(JSON.stringify(v)).slice(2, -2));
    try { add("url", encodeURIComponent(v)); } catch (_) { /* lone surrogate */ }
    try { add("url-form", encodeURIComponent(v).replace(/%20/g, "+")); } catch (_) {}
    try { add("url-lower", encodeURIComponent(v).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())); } catch (_) {}
    for (const core of base64Cores(v)) add("base64", core);
    return out;
  }

  /**
   * haystack の中に values のどれか (の変換形) が含まれていれば、その一覧を返す。
   * 返り値には値そのものを入れず、何番目の値がどの形で見つかったかだけを入れる
   * (結果をログに残しても原文が残らないように)。
   * @param {string} haystack
   * @param {string[]} values
   * @returns {Array<{index:number, kind:string, at:number}>}
   */
  function findLeaks(haystack, values) {
    const hay = String(haystack == null ? "" : haystack);
    if (!hay) return [];
    const hits = [];
    (Array.isArray(values) ? values : []).forEach((value, index) => {
      for (const { kind, text } of variantsOf(value)) {
        const at = hay.indexOf(text);
        if (at >= 0) { hits.push({ index, kind, at }); break; }
      }
    });
    return hits;
  }

  // JSON の本文を再帰的にたどって、すべての文字列 (キーも含む) を 1 本につなぐ。
  // JSON でなければ元の文字列を返す。partial_query.content.parts だけに限らないため
  function flattenJsonStrings(body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { return String(body == null ? "" : body); }
    const parts = [];
    const walk = (x, depth) => {
      if (depth > 64 || x == null) return;
      if (typeof x === "string") { parts.push(x); return; }
      if (typeof x !== "object") { parts.push(String(x)); return; }
      for (const [k, v] of Object.entries(x)) { parts.push(k); walk(v, depth + 1); }
    };
    walk(parsed, 0);
    return parts.join("\n");
  }

  /**
   * 通信 1 件 (URL・ヘッダー・本文) を検査する。本文は生のまま + JSON をほどいた形の両方を見る。
   */
  function scanRequest(req, values) {
    const fields = [
      ["url", req && req.url],
      ["headers", req && req.headers ? JSON.stringify(req.headers) : ""],
      ["body", req && req.body],
      ["body-json", req && typeof req.body === "string" ? flattenJsonStrings(req.body) : ""],
    ];
    const hits = [];
    for (const [field, text] of fields) {
      for (const h of findLeaks(text, values)) hits.push({ field, ...h });
    }
    return hits;
  }

  const api = { variantsOf, findLeaks, scanRequest, flattenJsonStrings, toFullWidth, base64Cores };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.PiiGuardLeakDetector = api;
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
