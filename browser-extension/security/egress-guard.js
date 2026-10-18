// security/egress-guard.js — ページから出ていく通信に、利用者の原文 (個人情報) が混ざっていないかを調べ、
// 伏せ字にするか止める (F-EG-01〜04)。MAIN world (injected.js が使う) と Node (テスト) の両方で読める純粋関数。
//
// なぜ要るか (2026-10-18 実測): Claude は送信を protobuf の RPC に、Gemini は WebChannel (フォームの中に
// Base64 の protobuf) に変えていて、JSON しか見ない従来のアダプタは黙って素通し (fail-open) になっていた。
// Manus は解析ツール (Amplitude) がクリックした入力欄の文字を外へ送っていた。
// ここでは「形を知っている送信」は中身を書き換え、「形を知らない通信」に検出済みの値が入っていたら
// 置き換えるか止める。サイトが形を変えても、素通しではなく止める側に倒れる。
"use strict";

(function attach(root) {
  // ---- UTF-8 ---------------------------------------------------------------------
  const enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  const decStrict = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: true }) : null;
  const utf8 = (s) => enc.encode(s);
  // 文字列として読めるか (正しい UTF-8 で、制御文字は \t \n \r だけ)。読めなければ null。
  function asText(u8) {
    let s;
    try { s = decStrict.decode(u8); } catch (_) { return null; }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) return null;
    return s;
  }
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function latin1Of(u8, max = u8.length) {
    let s = "";
    const end = Math.min(u8.length, max);
    for (let i = 0; i < end; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(end, i + 0x8000)));
    return s;
  }
  function indexOfBytes(hay, needle, from = 0) {
    if (!needle.length || needle.length > hay.length) return -1;
    const first = needle[0];
    const last = hay.length - needle.length;
    for (let i = from; i <= last; i++) {
      if (hay[i] !== first) continue;
      let j = 1;
      while (j < needle.length && hay[i + j] === needle[j]) j++;
      if (j === needle.length) return i;
    }
    return -1;
  }

  // ---- protobuf (スキーマなし) -----------------------------------------------------
  function readVarint(u8, i) {
    let x = 0;
    let mul = 1;
    for (let k = 0; k < 10; k++) {
      if (i >= u8.length) throw new RangeError("varint");
      const b = u8[i++];
      x += (b & 0x7f) * mul;
      if (!(b & 0x80)) return [x, i];
      mul *= 128;
    }
    throw new RangeError("varint too long");
  }
  function encodeVarint(n) {
    const out = [];
    let x = n;
    while (x >= 0x80) { out.push((x % 128) | 0x80); x = Math.floor(x / 128); }
    out.push(x);
    return Uint8Array.from(out);
  }
  /** 全体をフィールドの並びとして読めれば配列、読めなければ null (グループ型は扱わない) */
  function parseMessage(u8) {
    const fields = [];
    let i = 0;
    try {
      while (i < u8.length) {
        const start = i;
        let key;
        [key, i] = readVarint(u8, i);
        const num = Math.floor(key / 8);
        const wt = key % 8;
        if (num < 1 || num > 536870911) return null;
        let valStart = i;
        if (wt === 0) [, i] = readVarint(u8, i);
        else if (wt === 1) i += 8;
        else if (wt === 5) i += 4;
        else if (wt === 2) { let n; [n, i] = readVarint(u8, i); valStart = i; i += n; }
        else return null;
        if (i > u8.length) return null;
        fields.push({ num, wt, start, valStart, end: i });
      }
    } catch (_) { return null; }
    return fields;
  }
  const fieldBytes = (num, value) => concat([encodeVarint(num * 8 + 2), encodeVarint(value.length), value]);

  // 道筋の各段: 数 = その番号の最初の出現、{n, k} = n 番の k 番目の出現 (繰り返しのフィールド)
  function pick(fields, step) {
    const n = typeof step === "number" ? step : step.n;
    const k = typeof step === "number" ? 0 : step.k;
    let c = -1;
    for (const f of fields) if (f.num === n && f.wt === 2 && ++c === k) return f;
    return null;
  }
  /** フィールド番号の道筋 (例 [2, 3]) の先の値を返す。無ければ null */
  function getAtPath(u8, path) {
    let cur = u8;
    for (const step of path) {
      const fields = parseMessage(cur);
      if (!fields) return null;
      const f = pick(fields, step);
      if (!f) return null;
      cur = cur.subarray(f.valStart, f.end);
    }
    return cur;
  }
  /** 道筋の先で、番号 n の (長さ付きの) フィールドがいくつあるか */
  function countAt(u8, path, n) {
    const v = path.length ? getAtPath(u8, path) : u8;
    const fields = v ? parseMessage(v) : null;
    return fields ? fields.filter((f) => f.num === n && f.wt === 2).length : 0;
  }
  /** 道筋の先の値を newValue に差し替え、長さを直して組み直す。道筋が無ければ null */
  function setAtPath(u8, path, newValue) {
    if (!path.length) return newValue;
    const fields = parseMessage(u8);
    if (!fields) return null;
    const f = pick(fields, path[0]);
    if (!f) return null;
    const inner = setAtPath(u8.subarray(f.valStart, f.end), path.slice(1), newValue);
    if (!inner) return null;
    return concat([u8.subarray(0, f.start), fieldBytes(f.num, inner), u8.subarray(f.end)]);
  }
  function textLoose(u8) { try { return decStrict.decode(u8); } catch (_) { return null; } }

  /**
   * 文字列フィールドの中身を書き換える。値 (バイト列) を含むフィールドについて、入れ子として読めて
   * 中で書き換わればそれを使い、だめなら文字列として書き換える。長さの入れ子は直して組み直す。
   * @param {Uint8Array} u8
   * @param {{mayContain:(Uint8Array)=>boolean, rewrite:(string)=>string}} rw
   * @param {(path:number[])=>boolean} [skip] この道筋のフィールドは触らない (確認画面で決めた本文など)
   * @returns {{bytes:Uint8Array, changed:boolean, stuck:boolean}|null} 全体が protobuf で読めなければ null。
   *   stuck = 値を含むのに書き換えられない (文字列でないバイト列) フィールドがあった
   */
  function rewriteProto(u8, rw, skip, path = [], depth = 0) {
    const fields = parseMessage(u8);
    if (!fields) return null;
    let changed = false;
    let stuck = false;
    const parts = [];
    let last = 0;
    for (const f of fields) {
      if (f.wt !== 2) continue;
      const p = path.concat(f.num);
      const val = u8.subarray(f.valStart, f.end);
      if ((skip && skip(p)) || !rw.mayContain(val)) continue;
      let next = null;
      let fieldStuck = false;
      if (depth < 24 && val.length >= 2) {
        const inner = rewriteProto(val, rw, skip, p, depth + 1);
        if (inner && inner.changed) next = inner.bytes;
        if (inner && inner.stuck) fieldStuck = true;
      }
      if (!next) {
        // 入れ子の中で書き換えられなかった: このフィールドを文字列として書き換える
        const t = asText(val);
        if (t !== null) {
          const t2 = rw.rewrite(t);
          if (t2 !== t) { next = utf8(t2); fieldStuck = false; }
          else fieldStuck = fieldStuck || rw.mayContain(val);
        } else fieldStuck = true;
      }
      if (fieldStuck) stuck = true;
      if (next) {
        changed = true;
        parts.push(u8.subarray(last, f.start), fieldBytes(f.num, next));
        last = f.end;
      }
    }
    if (!changed) return { bytes: u8, changed: false, stuck };
    parts.push(u8.subarray(last));
    return { bytes: concat(parts), changed: true, stuck };
  }

  // ---- Base64 ---------------------------------------------------------------------
  function b64decode(s) {
    const urlsafe = /[-_]/.test(s);
    const std = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = std + "===".slice((std.length + 3) % 4);
    let bin;
    if (typeof atob === "function") bin = atob(padded);
    else bin = Buffer.from(padded, "base64").toString("latin1");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { bytes: out, urlsafe, padded: /=$/.test(s) };
  }
  function b64encode(u8, { urlsafe, padded }) {
    let bin = "";
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    let s = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "latin1").toString("base64");
    if (urlsafe) s = s.replace(/\+/g, "-").replace(/\//g, "_");
    if (!padded) s = s.replace(/=+$/, "");
    return s;
  }

  // ---- WebChannel のフォーム (count=1&ofs=1&req0___data__=<Base64>) --------------------
  const WC_DATA = /^req\d+___data__$/;
  function parseWebChannelForm(body) {
    if (typeof body !== "string" || !/(^|&)req\d+___data__=/.test(body)) return null;
    const pairs = body.split("&").map((kv) => {
      const eq = kv.indexOf("=");
      return eq < 0 ? { raw: kv } : { raw: kv, key: kv.slice(0, eq), value: kv.slice(eq + 1) };
    });
    const items = [];
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      if (!p.key || !WC_DATA.test(p.key)) continue;
      let text;
      try { text = decodeURIComponent(p.value.replace(/\+/g, " ")); } catch (_) { return null; }
      try { const b = b64decode(text.trim()); items.push({ pair: i, ...b }); } catch (_) { return null; }
    }
    return items.length ? { pairs, items } : null;
  }
  function buildWebChannelForm(model) {
    const pairs = model.pairs.map((p) => ({ ...p }));
    for (const it of model.items) {
      pairs[it.pair].raw = `${pairs[it.pair].key}=${encodeURIComponent(b64encode(it.bytes, it))}`;
    }
    return pairs.map((p) => p.raw).join("&");
  }

  // ---- 検出済みの値の集合 --------------------------------------------------------------
  const ZW = /[​-‍⁠﻿]/g;
  const toFull = (s) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  const jsonAscii = (s) => JSON.stringify(s).slice(1, -1).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  function textVariants(v) {
    const out = [];
    const seen = new Set();
    const add = (kind, text, replaceable) => {
      if (typeof text !== "string" || text.length < 2 || seen.has(text)) return;
      seen.add(text);
      out.push({ kind, text, replaceable });
    };
    add("raw", v, true);
    add("nfkc", v.normalize("NFKC"), true);
    add("fullwidth", toFull(v.normalize("NFKC")), true);
    add("no-zero-width", v.replace(ZW, ""), true);
    add("json", JSON.stringify(v).slice(1, -1), true);
    add("json-ascii", jsonAscii(v), true);
    try { add("url", encodeURIComponent(v), true); } catch (_) {}
    try { add("url-form", encodeURIComponent(v).replace(/%20/g, "+"), true); } catch (_) {}
    try { add("url-lower", encodeURIComponent(v).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), true); } catch (_) {}
    return out;
  }
  // Base64 の中に値があるか (3 通りのずれ)。置き換えはできないので見つけるだけ
  function base64Cores(v) {
    const bytes = utf8(v);
    const cores = [];
    for (let shift = 0; shift < 3; shift++) {
      const pre = new Uint8Array(shift);
      const s = b64encode(concat([pre, bytes]), { urlsafe: false, padded: true });
      const startChar = shift === 0 ? 0 : shift === 1 ? 2 : 3;
      const usable = Math.floor((shift + bytes.length) / 3) * 4;
      const core = s.slice(startChar, usable);
      if (core.length >= 8) { cores.push(core); cores.push(core.replace(/\+/g, "-").replace(/\//g, "_")); }
    }
    return cores;
  }
  const isCjk = (s) => /[^\u0000-\u007f]/.test(s);

  function createSensitiveSet(opts = {}) {
    const ttlMs = opts.ttlMs || 30 * 60 * 1000;
    const max = opts.max || 500;
    const map = new Map(); // value -> {label, placeholder, t, variants, bytes, b64}
    const counters = Object.create(null);
    function add(value, label, now = Date.now()) {
      if (typeof value !== "string") return;
      const v = value.trim();
      if (v.length < (isCjk(v) ? 2 : 4)) return;
      const prev = map.get(v);
      if (prev) { prev.t = now; return; }
      const lab = String(label || "PII").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      counters[lab] = (counters[lab] || 0) + 1;
      const variants = textVariants(v);
      map.set(v, {
        label: lab, placeholder: `<${lab}_${counters[lab]}>`, t: now, variants,
        bytes: [...new Set(variants.filter((x) => x.replaceable).map((x) => x.text))].map((t) => utf8(t)),
        b64: base64Cores(v),
      });
      if (map.size > max) map.delete(map.keys().next().value);
    }
    function prune(now = Date.now()) { for (const [k, e] of map) if (now - e.t > ttlMs) map.delete(k); }
    // 長い値から順に (短い値が長い値の一部のとき、長い方を先に伏せる)
    const entries = () => [...map.entries()].sort((a, b) => b[0].length - a[0].length);
    function findIn(text) {
      if (typeof text !== "string" || !text || !map.size) return [];
      const hits = [];
      for (const [value, e] of entries()) {
        for (const vr of e.variants) if (text.includes(vr.text)) { hits.push({ value, kind: vr.kind, replaceable: true }); break; }
        if (!hits.length || hits[hits.length - 1].value !== value) {
          for (const c of e.b64) if (text.includes(c)) { hits.push({ value, kind: "base64", replaceable: false }); break; }
        }
      }
      return hits;
    }
    function scrubText(text) {
      let out = text;
      for (const [, e] of entries()) {
        for (const vr of e.variants) {
          if (!out.includes(vr.text)) continue;
          const ph = /^url/.test(vr.kind) ? encodeURIComponent(e.placeholder) : e.placeholder;
          out = out.split(vr.text).join(ph);
        }
      }
      return out;
    }
    function mayContainBytes(u8) {
      for (const [, e] of map) for (const b of e.bytes) if (indexOfBytes(u8, b) >= 0) return true;
      return false;
    }
    return {
      add, prune, findIn, scrubText, mayContainBytes,
      get size() { return map.size; },
      values: () => [...map.keys()],
      placeholderOf: (v) => (map.get(v) || {}).placeholder,
    };
  }

  // ---- 下書きの一部が出ていないか (外部の宛先向け) ---------------------------------------
  // 下書きの minLen 文字の断片を全部集合にしておき、本文を 1 文字ずつずらして照合する (本文の長さに比例)。
  // 本文は「そのまま」「URL デコード」「JSON の文字列を全部つないだもの」(\\u エスケープもほどける) で見る。
  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const ECHO_SCAN_MAX = 256 * 1024;
  function draftGrams(drafts, minLen = 16) {
    const set = new Set();
    for (const d of drafts || []) {
      const t = squash(d);
      for (let i = 0; i + minLen <= t.length; i++) set.add(t.slice(i, i + minLen));
    }
    return set;
  }
  function jsonStrings(text) {
    let j;
    try { j = JSON.parse(text); } catch (_) { return null; }
    const parts = [];
    const walk = (x, d) => {
      if (d > 32 || x == null) return;
      if (typeof x === "string") { parts.push(x); return; }
      if (typeof x !== "object") return;
      for (const v of Object.values(x)) walk(v, d + 1);
    };
    walk(j, 0);
    return parts.join("\n");
  }
  function echoesDraft(text, drafts, minLen = 16, grams) {
    if (typeof text !== "string" || !text) return false;
    const set = grams || draftGrams(drafts, minLen);
    if (!set.size) return false;
    const cands = [text];
    if (/%[0-9a-f]{2}|\+/i.test(text)) { try { cands.push(decodeURIComponent(text.replace(/\+/g, " "))); } catch (_) {} }
    if (/^\s*[[{]/.test(text)) { const js = jsonStrings(text); if (js) cands.push(js); }
    for (const c of cands) {
      const t = squash(c).slice(0, ECHO_SCAN_MAX);
      for (let i = 0; i + minLen <= t.length; i++) if (set.has(t.slice(i, i + minLen))) return true;
    }
    return false;
  }

  /**
   * 通信 1 件を判定する。アダプタ (確認画面を含む送信の処理) が扱わなかった通信に使う。
   * @param {{url:string, host:string, text?:string|null, bytes?:Uint8Array|null, unreadable?:boolean}} req
   * @param {{sensitive:ReturnType<typeof createSensitiveSet>, drafts:string[], firstParty:(host:string)=>boolean, echoMin?:number}} ctx
   * @returns {{action:"pass"}|{action:"scrub", text?:string, bytes?:Uint8Array}|{action:"block", reason:string}}
   */
  function decide(req, ctx) {
    const s = ctx.sensitive;
    const third = !ctx.firstParty(req.host || "");
    const echoMin = ctx.echoMin || 16;
    const grams = ctx.grams || draftGrams(ctx.drafts, echoMin);
    let url = req.url || "";
    try { url = decodeURIComponent(url); } catch (_) {}
    if (s.findIn(req.url || "").length || s.findIn(url).length) return { action: "block", reason: "url-has-pii" };
    if (third && echoesDraft(req.url || "", ctx.drafts, echoMin, grams)) return { action: "block", reason: "url-echoes-draft" };
    if (req.unreadable) {
      // 中身を読めない (同期 API の Blob 等)。外部宛てで、守る原文があるなら止める
      return third && (s.size || ctx.drafts.length) ? { action: "block", reason: "unreadable-third-party" } : { action: "pass" };
    }
    if (typeof req.text === "string") {
      if (third && echoesDraft(req.text, ctx.drafts, echoMin, grams)) return { action: "block", reason: "body-echoes-draft" };
      const hits = s.findIn(req.text);
      if (!hits.length) return { action: "pass" };
      if (third) return { action: "block", reason: "third-party-pii" };
      if (hits.some((h) => !h.replaceable)) {
        // Base64 等の中: WebChannel ならほどいて置き換えを試す
        const wc = parseWebChannelForm(req.text);
        if (wc) {
          const r = scrubWebChannel(wc, s);
          if (r && r.changed && !r.stuck) {
            const out = s.scrubText(buildWebChannelForm(wc));
            if (!s.findIn(out).length) return { action: "scrub", text: out };
          }
        }
        return { action: "block", reason: "pii-in-encoded-body" };
      }
      const out = s.scrubText(req.text);
      return s.findIn(out).length ? { action: "block", reason: "scrub-incomplete" } : { action: "scrub", text: out };
    }
    if (req.bytes) {
      const u8 = req.bytes;
      const latin = latin1Of(u8, 2 * 1024 * 1024);
      const b64Hit = s.findIn(latin).some((h) => !h.replaceable);
      if (!s.mayContainBytes(u8) && !b64Hit) {
        if (third) { const t = asText(u8); if (t && echoesDraft(t, ctx.drafts, echoMin, grams)) return { action: "block", reason: "body-echoes-draft" }; }
        return { action: "pass" };
      }
      if (third || b64Hit) return { action: "block", reason: third ? "third-party-pii" : "pii-in-encoded-body" };
      const r = rewriteProto(u8, { mayContain: (v) => s.mayContainBytes(v), rewrite: (t) => s.scrubText(t) });
      if (r && r.changed && !r.stuck && !s.mayContainBytes(r.bytes)) return { action: "scrub", bytes: r.bytes };
      const t = asText(u8);
      if (t !== null) {
        const out = s.scrubText(t);
        if (!s.findIn(out).length) return { action: "scrub", bytes: utf8(out) };
      }
      return { action: "block", reason: "pii-in-binary" };
    }
    return { action: "pass" };
  }

  // WebChannel の各 item (Base64 の protobuf) の中の値を置き換える (その場で it.bytes を更新)
  function scrubWebChannel(model, s) {
    let stuck = false;
    let changed = false;
    for (const it of model.items) {
      if (!s.mayContainBytes(it.bytes)) continue;
      const r = rewriteProto(it.bytes, { mayContain: (v) => s.mayContainBytes(v), rewrite: (t) => s.scrubText(t) });
      if (r && r.changed && !s.mayContainBytes(r.bytes)) { it.bytes = r.bytes; changed = true; }
      else stuck = true;
    }
    return { changed, stuck };
  }

  // ---- 送信アダプタ (形を知っている送信は、本文を取り出して確認画面とマスクに載せる) ----------
  // 取り出し: 決まった道筋の文字列 + (形が変わったとき用に) 下書きと同じ中身の文字列フィールド
  function findTextFieldsEqual(u8, wanted, path = [], depth = 0, out = []) {
    const fields = parseMessage(u8);
    if (!fields || depth > 24) return out;
    for (const f of fields) {
      if (f.wt !== 2) continue;
      const val = u8.subarray(f.valStart, f.end);
      const p = path.concat(f.num);
      const t = asText(val);
      if (t !== null && wanted.has(squash(t))) { out.push({ path: p, text: t }); continue; }
      if (val.length >= 2) findTextFieldsEqual(val, wanted, p, depth + 1, out);
    }
    return out;
  }
  function protoTexts(u8, knownPath, drafts) {
    const got = [];
    const v = getAtPath(u8, knownPath);
    if (v) {
      let t = null;
      try { t = decStrict.decode(v); } catch (_) { t = null; }
      if (t !== null && t.trim()) got.push({ path: knownPath, text: t });
    }
    if (!got.length && drafts && drafts.length) {
      const wanted = new Set(drafts.map(squash).filter((x) => x.length >= 1));
      for (const f of findTextFieldsEqual(u8, wanted)) if (f.text.trim()) got.push(f);
    }
    return got;
  }
  function protoReplace(u8, fields, masked) {
    let cur = u8;
    fields.forEach((f, i) => {
      if (typeof masked[i] !== "string" || masked[i] === f.text) return;
      const next = setAtPath(cur, f.path, utf8(masked[i]));
      if (!next) throw new Error("egress-guard: field path vanished");
      cur = next;
    });
    return cur;
  }

  // 本文 (確認画面で利用者が決めたもの) 以外のフィールドに残る検出済みの値を伏せる
  const rwOf = (sens) => ({ mayContain: (v) => sens.mayContainBytes(v), rewrite: (t) => sens.scrubText(t) });
  const skipOf = (fields) => { const set = new Set(fields.map((f) => f.path.join("."))); return (p) => set.has(p.join(".")); };

  const adapters = {
    // Claude: Connect の unary (application/proto)。2026-10-18 実測で本文は root.2.3
    claudeRpc: {
      name: "claude-rpc",
      knownPath: [2, 3],
      match: (url) => /(^|\.)claude\.(ai|com)$/.test(hostOf(url)) && /\/claudeai-rpc\/[\w.]+\.ConversationService\/PerformAction(?:[?#]|$)/.test(url),
      decode(bytes, drafts) {
        if (!parseMessage(bytes)) return null;
        return { bytes, fields: protoTexts(bytes, this.knownPath, drafts) };
      },
      extractInputs: (m) => m.fields.map((f) => f.text),
      replaceInputs: (m, masked) => ({ ...m, bytes: protoReplace(m.bytes, m.fields, masked), fields: m.fields.map((f, i) => ({ ...f, text: typeof masked[i] === "string" ? masked[i] : f.text })) }),
      encode: (m) => m.bytes,
      // 添付 (2026-10-18 実測: root.2.15 が 1 件ずつ {1: ファイル名, 2: サイズ, 3: 種類, 4: 中身のテキスト})。
      // 確認画面は本文だけに出し、添付の中身とファイル名は自動でマスクする (injected.js がエンジンを掛ける)
      autoFields(m) {
        const out = [];
        const n = countAt(m.bytes, [2], 15);
        for (let k = 0; k < n; k++) {
          for (const [sub, kind] of [[4, "content"], [1, "name"]]) {
            const v = getAtPath(m.bytes, [2, { n: 15, k }, sub]);
            const t = v ? textLoose(v) : null;
            if (t && t.trim()) out.push({ path: [2, { n: 15, k }, sub], text: t, kind });
          }
        }
        return out;
      },
      setField(m, path, text) {
        const next = setAtPath(m.bytes, path, utf8(text));
        if (!next) throw new Error("egress-guard: field path vanished");
        return { ...m, bytes: next };
      },
      scrubOthers(m, sens) {
        if (!sens || !sens.size || !sens.mayContainBytes(m.bytes)) return { model: m, stuck: false };
        const r = rewriteProto(m.bytes, rwOf(sens), skipOf(m.fields));
        return { model: r && r.changed ? { ...m, bytes: r.bytes } : m, stuck: !r || r.stuck };
      },
    },
    // Gemini: WebChannel のフォーム。各 reqN___data__ が Base64 の protobuf。2026-10-18 実測で本文は root.2.9.1
    geminiSession: {
      name: "gemini-session",
      knownPath: [2, 9, 1],
      match: (url) => /(^|\.)(clients6\.google\.com|googleapis\.com|gemini\.google\.com)$/.test(hostOf(url)) && /\/processSession(?:[/?#]|$)/.test(url),
      decode(text, drafts) {
        const wc = parseWebChannelForm(text);
        if (!wc) return null;
        const fields = [];
        wc.items.forEach((it, k) => { for (const f of protoTexts(it.bytes, this.knownPath, drafts)) fields.push({ item: k, ...f }); });
        return { wc, fields };
      },
      extractInputs: (m) => m.fields.map((f) => f.text),
      replaceInputs(m, masked) {
        m.fields.forEach((f, i) => {
          const it = m.wc.items[f.item];
          it.bytes = protoReplace(it.bytes, [f], [masked[i]]);
          f.text = typeof masked[i] === "string" ? masked[i] : f.text;
        });
        return m;
      },
      encode: (m) => buildWebChannelForm(m.wc),
      scrubOthers(m, sens) {
        let stuck = false;
        if (!sens || !sens.size) return { model: m, stuck };
        m.wc.items.forEach((it, k) => {
          if (!sens.mayContainBytes(it.bytes)) return;
          const r = rewriteProto(it.bytes, rwOf(sens), skipOf(m.fields.filter((f) => f.item === k)));
          if (r && r.changed) it.bytes = r.bytes;
          if (!r || r.stuck) stuck = true;
        });
        return { model: m, stuck };
      },
    },
  };

  function hostOf(url) { try { return new URL(url, "https://invalid.invalid/").hostname; } catch (_) { return ""; } }

  // サイト自身の宛先 (外部の解析ツール等は含めない)
  const FIRST_PARTY = [
    { site: /(^|\.)(claude\.(ai|com))$/, own: /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/ },
    { site: /(^|\.)gemini\.google\.com$/, own: /(^|\.)(google\.com|googleapis\.com|gstatic\.com)$/ },
    { site: /(^|\.)manus\.im$/, own: /(^|\.)(manus\.im|butterfly-effect\.dev|manus\.space)$/ },
    { site: /(^|\.)(chatgpt\.com|openai\.com)$/, own: /(^|\.)(chatgpt\.com|openai\.com|oaiusercontent\.com|oaistatic\.com)$/ },
  ];
  function firstPartyFor(pageHost) {
    const rule = FIRST_PARTY.find((r) => r.site.test(pageHost));
    const ownRe = rule ? rule.own : null;
    return (host) => !!host && (host === pageHost || (ownRe ? ownRe.test(host) : false));
  }

  const api = {
    parseMessage, getAtPath, setAtPath, countAt, rewriteProto, encodeVarint, asText, latin1Of,
    b64decode, b64encode, parseWebChannelForm, buildWebChannelForm, scrubWebChannel,
    createSensitiveSet, echoesDraft, draftGrams, decide, adapters, firstPartyFor, hostOf, textVariants, base64Cores,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") { root.__localMaskMCP = root.__localMaskMCP || {}; root.__localMaskMCP.egress = api; }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
