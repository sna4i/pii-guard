// engine/aggregate.js — port of src/app/services/aggregation.py +
// tag-mask numbering/sub from masking_service.py.
// Depends on engine.{categories,classification,severity}.
"use strict";

(function attach(root) {
  function pick(a, b) { return a || (b && typeof b === "object" ? b : null); }
  function resolveDeps() {
    let c = null, cl = null, s = null;
    if (typeof require === "function") {
      try { c = require("./categories"); } catch (_) {}
      try { cl = require("./classification"); } catch (_) {}
      try { s = require("./severity"); } catch (_) {}
    }
    const ns = (root && root.__localMaskMCP && root.__localMaskMCP.engine) || {};
    return { categories: pick(c, ns.categories), classification: pick(cl, ns.classification), severity: pick(s, ns.severity) };
  }

  // プレースホルダ番号を決めるためのキー。表記ゆれで同じ実体が別番号に
  // ならないよう、内部の空白だけ畳む。「氏名：山田 太郎」と
  // 「山田太郎様」は同一人物なので同じ <JP_SURNAME_1> を指すべきで、
  // 別番号になると復元時に 2 人に分かれてしまう。
  // 表示と置換には元の表記をそのまま使う — ここで正規化するのは
  // グルーピングのキーだけ。
  function groupKey(entityType, surface) {
    return entityType + "\x00" + String(surface).replace(/[\s\u3000]+/g, "");
  }

  // aggregate_detections(detections) → AggregatedEntity[].
  function aggregateDetections(detections) {
    const { categories, classification, severity } = resolveDeps();
    if (!categories || !classification || !severity) {
      throw new Error("mask-mcp engine aggregate: missing deps");
    }
    const order = [];
    const byValue = new Map();
    for (const det of detections) {
      if (!byValue.has(det.text)) { order.push(det.text); byValue.set(det.text, []); }
      byValue.get(det.text).push(det);
    }
    // Numbering pass (matches _tag_mask pass 1 and aggregate_detections).
    const counters = new Map();
    const numbering = new Map();
    const flat = [];
    for (const hits of byValue.values()) for (const h of hits) flat.push(h);
    flat.sort((a, b) => a.start - b.start || a.end - b.end);
    for (const det of flat) {
      const key = groupKey(det.entity_type, det.text);
      if (!numbering.has(key)) {
        const n = (counters.get(det.entity_type) || 0) + 1;
        counters.set(det.entity_type, n);
        numbering.set(key, n);
      }
    }

    const aggregated = [];
    for (const value of order) {
      const hits = byValue.get(value);
      // Best label = smallest start; tie-break prefers category != OTHER.
      const keyOf = (h) => [h.start, categories.categoryFor(h.entity_type) !== "OTHER" ? 0 : 1];
      let best = hits[0], bestKey = keyOf(best);
      for (let i = 1; i < hits.length; i++) {
        const k = keyOf(hits[i]);
        if (k[0] < bestKey[0] || (k[0] === bestKey[0] && k[1] < bestKey[1])) {
          best = hits[i]; bestKey = k;
        }
      }
      const label = best.entity_type;
      const category = categories.categoryFor(label);
      // Dedupe (start, end) — first-occurrence wins.
      const seen = new Set();
      const positions = [];
      for (const h of hits) {
        const span = h.start + ":" + h.end;
        if (seen.has(span)) continue;
        seen.add(span);
        positions.push([h.start, h.end]);
      }
      positions.sort((a, b) => a[0] - b[0]);
      // Drop polite-phrase false positives mis-tagged as PERSON.
      if ((label === "PERSON" || label === "PROPER_NOUN_PERSON") &&
          severity.isFalsePositivePerson(value)) {
        continue;
      }
      const masked = hits.some((h) => (h.action || "masked") === "masked");
      const n = numbering.get(label + "\x00" + value) || 1;
      aggregated.push({
        value, label, category,
        count: positions.length,
        positions, masked,
        placeholder: "<" + label + "_" + n + ">",
        classification: classification.classificationFor(label),
        severity: severity.severityForSurface(label, value),
      });
    }
    return aggregated;
  }

  // _tag_mask port — 2-pass numbering + reverse-order substitution.
  // 伏せる範囲 (spans) を伏せ字 <LABEL_N> に置き換える (1.5.1)。
  // spans は [start, end, label] か {start, end, label | entity_type} の配列。
  //
  // 重なる範囲は 1 つにまとめて伏せる。1.5.0 までは置き換えが 4 か所にあり、
  // 重なりを想定していなかった。元の文字位置のまま右から置き換えるので先に
  // 入れた伏せ字が途中で切れ (「<MY_NUMBER_1>89012」)、範囲を捨てる方式では
  // はみ出した部分が伏せられなかった。まとめれば、どの規則が伏せると決めた
  // 文字も必ず伏せられ、少し広く伏せることはあっても漏れはしない。
  // ラベルは、まとめた中で最も長い範囲のもの (同じ長さなら先に渡されたもの)。
  // 接しているだけの範囲はまとめない。番号はラベルと文字列の組ごとに左から振る。
  function applySpans(originalText, spans) {
    const text = String(originalText);
    const norm = [];
    (Array.isArray(spans) ? spans : []).forEach((x, order) => {
      const arr = Array.isArray(x);
      const s = arr ? x[0] : x && x.start;
      const e = arr ? x[1] : x && x.end;
      const label = arr ? x[2] : x && (x.label || x.entity_type);
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > text.length || e <= s) return;
      norm.push({ start: s, end: e, label: String(label || "MASKED"), order });
    });
    norm.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);

    const groups = [];
    for (const sp of norm) {
      const g = groups[groups.length - 1];
      if (g && sp.start < g.end) {
        g.end = Math.max(g.end, sp.end);
        if (sp.end - sp.start > g.longest) {
          g.longest = sp.end - sp.start;
          g.label = sp.label;
        }
      } else {
        groups.push({ start: sp.start, end: sp.end, label: sp.label, longest: sp.end - sp.start });
      }
    }

    const counters = new Map();
    const numbers = new Map();
    for (const g of groups) {
      const key = groupKey(g.label, text.slice(g.start, g.end));
      if (!numbers.has(key)) {
        const n = (counters.get(g.label) || 0) + 1;
        counters.set(g.label, n);
        numbers.set(key, n);
      }
      g.n = numbers.get(key);
    }

    // 右から置き換えれば、まだ置き換えていない左側の位置は変わらない。
    // 範囲が重ならないことは上でまとめた時点で保証されている。
    let out = text;
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      out = out.slice(0, g.start) + "<" + g.label + "_" + g.n + ">" + out.slice(g.end);
    }
    return out;
  }

  // 正規表現の経路の置き換え。applySpans() に任せる。
  function applyTagMask(originalText, detections) {
    return applySpans(originalText, detections);
  }

  // LLM が返した値の出現位置を探す (1.5.1)。値の端が英数字なら、隣の文字も
  // 英数字である出現は語の途中なので除く。口座番号の「1234567」をマイナン
  // バー「123456789012」の中で見つけないため。日本語には語の区切りが無い
  // ので、端が英数字でなければそのまま探す。
  const ALNUM = /[A-Za-z0-9]/;
  function findOccurrences(text, value) {
    const t = String(text);
    const v = String(value == null ? "" : value);
    const out = [];
    if (!v) return out;
    const headAlnum = ALNUM.test(v[0]);
    const tailAlnum = ALNUM.test(v[v.length - 1]);
    let i = t.indexOf(v);
    while (i >= 0) {
      const before = i > 0 ? t[i - 1] : "";
      const after = t[i + v.length] || "";
      const insideWord = (headAlnum && before && ALNUM.test(before)) || (tailAlnum && after && ALNUM.test(after));
      if (insideWord) {
        i = t.indexOf(v, i + 1);
      } else {
        out.push([i, i + v.length]);
        i = t.indexOf(v, i + v.length);
      }
    }
    return out;
  }

  // LLM が人名とした値の範囲 (1.5.1)。LLM は名字だけを返すことがあり、
  // 「小田切 智子」の「智子」が伏せられずに残った。またフルネームを返しても、
  // 文中で別に出てくる「Anderson さん」は伏せられなかった。
  //  - 名字の直後に空白を挟んで短い語 (漢字 1〜3 字か、カタカナ 2〜6 字) が
  //    続けば、下の名前として範囲に含める。役職や敬称の語は含めない
  //  - フルネームの各部分 (漢字・カナは 2 字以上、英字は 3 字以上) が単独で
  //    出てくる箇所も伏せる
  // どちらも伏せる範囲を広げる方向にだけ働く。
  const NAME_FOLLOWERS = new Set([
    "部長", "課長", "係長", "主任", "社長", "専務", "常務", "取締役", "本部長", "支店長", "室長",
    "所長", "次長", "会長", "理事", "代表", "担当", "先生", "教授", "博士", "医師", "氏", "様",
    "殿", "君", "宛", "他", "各位", "御中", "一同", "本人", "夫妻", "マネージャー", "リーダー",
  ]);
  const GIVEN_NAME = /^[ 　]((?:\p{Script=Han}{1,3}|[\p{Script=Katakana}ー]{2,6}))(?![\p{Script=Han}\p{Script=Katakana}ー])/u;
  function personSpans(text, value) {
    const t = String(text);
    const v = String(value == null ? "" : value).trim();
    if (!v) return [];
    const spans = [];
    const single = !/[\s　]/.test(v);
    for (const [s, e] of findOccurrences(t, v)) {
      const m = single ? GIVEN_NAME.exec(t.slice(e)) : null;
      spans.push(m && !NAME_FOLLOWERS.has(m[1]) ? [s, e + m[0].length] : [s, e]);
    }
    const parts = single ? [] : v.split(/[\s　]+/).filter((p) =>
      !NAME_FOLLOWERS.has(p) && (/[A-Za-z]/.test(p) ? p.length >= 3 : p.length >= 2));
    for (const p of parts) {
      for (const [s, e] of findOccurrences(t, p)) {
        if (!spans.some(([a, b]) => s >= a && e <= b)) spans.push([s, e]);
      }
    }
    spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    return spans.filter((x, i) => i === 0 || x[0] !== spans[i - 1][0] || x[1] !== spans[i - 1][1]);
  }

  const api = { aggregateDetections, applyTagMask, applySpans, findOccurrences, personSpans };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { aggregate: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
