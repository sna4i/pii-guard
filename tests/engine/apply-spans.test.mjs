// tests/engine/apply-spans.test.mjs — 伏せる範囲を伏せ字に置き換える処理 (1.5.1)
//
// 設計は docs/release-1.5.1.md。テスト ID はそこに対応する。
// 1.5.0 までは、伏せる範囲が重なると伏せ字が途中で切れ、元の文字の断片が
// 送信されていた (「マイナンバーは <MY_NUMBER_1>89012」)。
//
// Run: node --test tests/engine/apply-spans.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agg = require("../../browser-extension/engine/aggregate.js");

const WELL_FORMED = /<[A-Z][A-Z_]*_\d+>/g;
const stray = (s) => (s.replace(WELL_FORMED, "").match(/[<>]/g) || []).length;

test("T-01 disjoint spans are replaced and the same surface keeps its number", () => {
  const text = "田中さんと佐藤さん、また田中さん";
  const out = agg.applySpans(text, [[0, 2, "PERSON"], [5, 7, "PERSON"], [12, 14, "PERSON"]]);
  assert.equal(out, "<PERSON_1>さんと<PERSON_2>さん、また<PERSON_1>さん");
});

test("T-02 a span inside another becomes one placeholder with no fragments left", () => {
  const text = "マイナンバーは 123456789012 です";
  const expected = "マイナンバーは <MY_NUMBER_1> です";
  assert.equal(agg.applySpans(text, [[8, 20, "MY_NUMBER"], [8, 15, "BANK_ACCOUNT"]]), expected);
  assert.equal(agg.applySpans(text, [[8, 15, "BANK_ACCOUNT"], [8, 20, "MY_NUMBER"]]), expected, "order does not matter");
});

test("T-02b spans that cross each other are joined under the longest span's label", () => {
  assert.equal(agg.applySpans("株式会社さくら物産です", [[0, 4, "COMPANY"], [2, 9, "ORGANIZATION"]]), "<ORGANIZATION_1>です");
});

test("T-02c a surname inside a full name does not leave the given name behind", () => {
  assert.equal(agg.applySpans("小田切 智子です", [[0, 3, "PERSON"], [0, 6, "JP_SURNAME"]]), "<JP_SURNAME_1>です");
});

test("T-03 spans that only touch stay separate", () => {
  assert.equal(agg.applySpans("AB", [[0, 1, "X"], [1, 2, "Y"]]), "<X_1><Y_1>");
});

test("T-04 malformed spans are ignored", () => {
  assert.equal(agg.applySpans("abcdef", [[-1, 2, "X"], [3, 3, "Y"], [5, 99, "Z"], [0, "a", "W"]]), "abcdef");
  assert.equal(agg.applySpans("abcdef", [[-1, 2, "X"], [1, 3, "Y"]]), "a<Y_1>def");
});

test("T-04b spans may be objects with label or entity_type", () => {
  assert.equal(agg.applySpans("abc", [{ start: 0, end: 1, entity_type: "X" }, { start: 2, end: 3, label: "Y" }]), "<X_1>b<Y_1>");
});

test("T-05 random spans never break a placeholder or leave a masked character", () => {
  // 決まった種で乱数を作る (mulberry32)。失敗したら同じ入力で再現できる
  let seed = 20261005;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = "あいう漢字カナ123abcXYZ 、。";
  const labels = ["A", "B_C", "PERSON"];
  for (let iter = 0; iter < 500; iter++) {
    const len = 10 + Math.floor(rand() * 50);
    const text = Array.from({ length: len }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
    const spans = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => {
      const s = Math.floor(rand() * len);
      const e = s + 1 + Math.floor(rand() * Math.min(12, len - s));
      return [s, e, labels[Math.floor(rand() * labels.length)]];
    });
    const covered = new Set();
    for (const [s, e] of spans) for (let k = s; k < e; k++) covered.add(k);
    const uncovered = [...text].filter((_, k) => !covered.has(k)).join("");
    const out = agg.applySpans(text, spans);
    const ctx = `text=${JSON.stringify(text)} spans=${JSON.stringify(spans)} out=${JSON.stringify(out)}`;
    assert.equal(stray(out), 0, `broken placeholder: ${ctx}`);
    assert.equal(out.replace(WELL_FORMED, ""), uncovered, `a masked character leaked or an unmasked one was lost: ${ctx}`);
  }
});

test("T-06 findOccurrences skips matches inside a longer word of letters or digits", () => {
  assert.deepEqual(agg.findOccurrences("口座 1234567、番号 123456789012", "1234567"), [[3, 10]]);
  assert.deepEqual(agg.findOccurrences("Kenji Anderson and Andersonville", "Anderson"), [[6, 14]]);
  assert.deepEqual(agg.findOccurrences("x@y.co と x@y.com", "x@y.co"), [[0, 6]]);
});

test("T-06b findOccurrences still matches inside Japanese text, which has no word breaks", () => {
  assert.deepEqual(agg.findOccurrences("田中さんと田中部長", "田中"), [[0, 2], [5, 7]]);
  assert.deepEqual(agg.findOccurrences("社員番号EMP-20931です", "EMP-20931"), [[4, 13]]);
  assert.deepEqual(agg.findOccurrences("abc", ""), []);
});

// ---- 人名の範囲 (1.5.1) ------------------------------------------------
// LLM が名字だけを返すと下の名前が残り (「<PERSON_1> 智子」)、フルネームを
// 返しても文中の別の場所の名字は伏せられなかった (「Anderson さん」)。

const at = (text, surface, from = 0) => {
  const i = text.indexOf(surface, from);
  return [i, i + surface.length];
};

test("T-07 a surname is extended to the given name that follows after a space", () => {
  const text = "経営企画室の小田切 智子です";
  assert.deepEqual(agg.personSpans(text, "小田切"), [at(text, "小田切 智子")]);
  const kana = "タナカ ユウキさんと面談";
  assert.deepEqual(agg.personSpans(kana, "タナカ"), [at(kana, "タナカ ユウキ")]);
});

test("T-07b titles and honorifics after a space are not taken as a given name", () => {
  assert.deepEqual(agg.personSpans("佐藤 部長と話した", "佐藤"), [[0, 2]]);
  assert.deepEqual(agg.personSpans("山田 様へ送付", "山田"), [[0, 2]]);
  assert.deepEqual(agg.personSpans("久保田部長が異動", "久保田"), [[0, 3]]);
});

test("T-07c the parts of a full name are also found where they appear alone", () => {
  const text = "後任は Kenji Anderson さんです。Anderson さんの社員番号";
  assert.deepEqual(agg.personSpans(text, "Kenji Anderson"), [at(text, "Kenji Anderson"), at(text, "Anderson", 20)]);
  const ja = "早川 美紀 様から連絡。早川さんご本人の希望です";
  assert.deepEqual(agg.personSpans(ja, "早川 美紀"), [at(ja, "早川 美紀"), at(ja, "早川", 6)]);
});
