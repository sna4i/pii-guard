// tests/engine/custom-rules-normalization.test.mjs — カスタムルールの語・正規表現が、エンジンが照合する本文の形と合っている
// (Pro Phase 2 の設計 (P1)、T-CR-14)
//
// エンジン (engine/engine.js の nfkcWithMap) は、本文を NFKC に直すだけでなく、見えない文字を落とし、数字に挟まれた
// ハイフン類 (ー ‐ ― − など) を - に直し、1 桁ずつ空白で区切った数字の空白を落としてから、ルールを当てる。
// ルールの語がこの形とずれると、同じ見た目の本文に黙って当たらない。tests/engine/custom-rules.test.mjs の hits() は
// NFKC だけの近似なので、ここでは本物のエンジン (collectDetections) に、テストの中でだけ Pro のルールとして入れて確かめる
// (tests/engine/pro-gate.test.mjs と同じ入れ方)。エンジンの本文の形が変わって、ずれたときは、このテストが落ちる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = "../../browser-extension/engine/";
for (const m of ["dictionaries", "patterns", "classification", "severity", "categories", "aggregate", "force-mask", "blocklist", "user-force-mask", "confidential"]) require(E + m + ".js");
const engine = require(E + "engine.js");
const proRules = require(E + "pro-rules.js");
const { validateRule, compileRule } = require(E + "custom-rules.js");

// 見えない文字・全角の空白・ハイフン類は、文字そのものをファイルに書かず、コード番号から作る
const fromCodes = (...codes) => String.fromCharCode(...codes);
const ZWSP = fromCodes(0x200b);
const SOFT_HYPHEN = fromCodes(0x00ad);
const IDEOGRAPHIC_SPACE = fromCodes(0x3000);
// エンジンが、数字に挟まれたときに - に直すハイフン類: ー・U+2010〜U+2015・U+2212・U+FE63 (U+2011 と U+FE63 は NFKC で先に変わる)
const DASHES = [0x30fc, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe63].map((c) => fromCodes(c));
const LABEL = "NORM_TEST";

const exact = (...words) => ({ kind: "words", words, match: "exact", label: LABEL });
const partial = (...words) => ({ kind: "words", words, match: "partial", label: LABEL });
const regex = (pattern) => ({ kind: "regex", pattern, label: LABEL });

// ルールを Pro のルールパックに一時的に入れて、エンジンの検出を取る。終わったら外して、Pro をオフに戻す。
// 返すのは、当たった所の元の文の字 (全角のまま、見えない文字を含む)
function detect(rule, text) {
  const compiled = compileRule(rule);
  assert.ok(compiled, `組み立てられるルールで試す: ${JSON.stringify(rule)}`);
  proRules.PRO_RULE_PACK.push(compiled);
  engine.setProEnabled(true);
  try {
    return engine.collectDetections(text, {}).filter((d) => d.entity_type === LABEL).map((d) => d.text);
  } finally {
    proRules.PRO_RULE_PACK.splice(proRules.PRO_RULE_PACK.indexOf(compiled), 1);
    engine.setProEnabled(false);
  }
}
const codes = (s) => [...s].map((c) => c.codePointAt(0).toString(16)).join(" ");

test("T-CR-14 語と正規表現が、エンジンが照合する本文の形 (NFKC・見えない文字・数字に挟まれたハイフン類・1 桁ずつ空白で区切った数字) と合っている", () => {
  // 全角の本文 (Pro Phase 2 の設計 (P1) の例)
  assert.deepEqual(detect(exact("ACME-1234"), "コードはＡＣＭＥ－１２３４です"), ["ＡＣＭＥ－１２３４"]);
  assert.deepEqual(detect(regex("ACME-\\d{4}"), "コードはＡＣＭＥ－１２３４です"), ["ＡＣＭＥ－１２３４"]);
  // 見えない文字が本文に紛れている
  assert.deepEqual(detect(exact("アルファ計画"), `これはアルファ${ZWSP}計画です`), [`アルファ${ZWSP}計画`]);
  // 語に見えない文字が紛れている
  assert.deepEqual(detect(partial(`アルファ${SOFT_HYPHEN}計画`), "これはアルファ計画です"), ["アルファ計画"]);
  // 見えない文字は、エンジンが本文から落とすものすべて (ソフトハイフン・ゼロ幅スペース・ゼロ幅の非結合子と結合子・単語結合子・BOM)。
  // 語のほうも、すべて落とす。後ろの確認は、エンジンが落とす文字が変わったときに気づくための確認
  for (const c of [0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((code) => fromCodes(code))) {
    assert.deepEqual(detect(partial(`ア${c}イ`), "前アイ後"), ["アイ"], `語の見えない文字 ${codes(c)}`);
    assert.deepEqual(detect(partial("アイ"), `前ア${c}イ後`), [`ア${c}イ`], `本文の見えない文字 ${codes(c)}`);
  }

  // 数字に挟まれたハイフン類は、エンジンが - に直す。語を、本文と同じ字で書いても、- で書いても当たる
  for (const d of DASHES) {
    const phone = `090${d}1234${d}5678`;
    const text = `連絡先は${phone}です`;
    assert.deepEqual(detect(partial(phone), text), [phone], `部分一致 ${codes(d)}`);
    assert.deepEqual(detect(exact(phone), text), [phone], `完全一致 ${codes(d)}`);
    assert.deepEqual(detect(exact("090-1234-5678"), text), [phone], `- で書いた語 ${codes(d)}`);
    assert.deepEqual(detect(regex("\\d{3}-\\d{4}-\\d{4}"), text), [phone], `- で書いた正規表現 ${codes(d)}`);
    // 正規表現にそのハイフン類を書くと、本文では - に直されるので当たらない。保存のときに断る
    assert.equal(validateRule(regex(`\\d{3}${d}\\d{4}`)).ok, false, `断る ${codes(d)}`);
  }
  // 数字に挟まれていないハイフン類 (カタカナの伸ばす棒など) は、そのまま
  assert.deepEqual(detect(exact("サーバー"), "このサーバーです"), ["サーバー"]);
  assert.deepEqual(detect(partial(`1${DASHES[0]}A`), `x1${DASHES[0]}Ay`), [`1${DASHES[0]}A`]);
  assert.deepEqual(detect(partial(`ID${DASHES[0]}7`), `ID${DASHES[0]}7`), [`ID${DASHES[0]}7`]);

  // 1 桁ずつ空白で区切った数字 (OCR や PDF の貼り付け) は、エンジンが空白を落とす。語に同じ並びを書いても当たる
  assert.deepEqual(detect(partial("0 9 0 1 2 3 4 5 6 7 8"), "電話 0 9 0 1 2 3 4 5 6 7 8 です"), ["0 9 0 1 2 3 4 5 6 7 8"]);
  assert.deepEqual(detect(partial("09012345678"), "電話 0 9 0 1 2 3 4 5 6 7 8 です"), ["0 9 0 1 2 3 4 5 6 7 8"]);
  assert.deepEqual(detect(partial("0 9 0-1 2 3 4-5 6 7 8"), "電話 0 9 0-1 2 3 4-5 6 7 8 です"), ["0 9 0-1 2 3 4-5 6 7 8"]);
  assert.deepEqual(detect(partial(`０${IDEOGRAPHIC_SPACE}９ ０`), `前０ ９${IDEOGRAPHIC_SPACE}０後`), [`０ ９${IDEOGRAPHIC_SPACE}０`]);
  // 2 桁までの並びは、エンジンも空白を落とさない。ただし、ハイフン類で次の数字のかたまりにつながるときは落とす
  assert.deepEqual(detect(partial("1 2"), "前1 2後"), ["1 2"]);
  assert.deepEqual(detect(partial("12"), "前1 2後"), []);
  assert.deepEqual(detect(partial("1 2-3 4"), "前1 2-3 4後"), ["1 2-3 4"]);
  assert.deepEqual(detect(partial("12-34"), "前1 2-3 4後"), ["1 2-3 4"]);

  // 語の組み立てが、本文の形とずれていないかを、決めた種のランダムな語で確かめる。
  // 数字・ハイフン類・空白・全角と半角・見えない文字を混ぜた語は、その語が入った本文に必ず当たる
  const tokens = [
    "0", "1", "2", "7", "9", "0", "1", "2", "7", "9", "0", "1", "2", "7", "9", "a", "Z", "ア", "漢", "あ", "-",
    ...DASHES, fromCodes(0xff0d), " ", " ", IDEOGRAPHIC_SPACE, fromCodes(0xff11), fromCodes(0xff19), fromCodes(0xff21),
    fromCodes(0xff71), fromCodes(0xff76, 0xff9e), fromCodes(0x3231), ZWSP, SOFT_HYPHEN, fromCodes(0xfeff), fromCodes(0x2060), fromCodes(0x200d),
  ];
  let seed = 20261116;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let tried = 0;
  for (let n = 0; n < 400; n++) {
    const word = Array.from({ length: 1 + Math.floor(random() * 9) }, () => tokens[Math.floor(random() * tokens.length)]).join("").trim();
    if (!validateRule(partial(word)).ok) continue;
    tried++;
    assert.ok(detect(partial(word), `前${word}後`).length >= 1, `語が本文に当たらない: ${codes(word)}`);
  }
  assert.ok(tried > 300, `試した語の数: ${tried}`);
});
