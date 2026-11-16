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
// 結合文字 (濁点・アクセント) と、まとめた形 (「デ」・「é」)
const DAKUTEN = fromCodes(0x3099);
const ACUTE = fromCodes(0x0301);
const DE = fromCodes(0x30c7);
const E_ACUTE = fromCodes(0x00e9);
const GA = fromCodes(0x304c);
const PA = fromCodes(0x30d1);
const HANDAKUTEN = fromCodes(0x309a);
const BACKSLASH = fromCodes(92); // バックスラッシュ。エスケープ (u と 16 進数) を、ファイルに書かずに組み立てるため
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

test("T-CR-14 語と正規表現が、エンジンが照合する本文の形 (NFKC・見えない文字・数字に挟まれたハイフン類・分解された形・1 桁ずつ空白で区切った数字) と合っている。検査を通した正規表現は、同じ本文に当たる", () => {
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

  // 検査を通した正規表現は、まったく同じ本文に当たる (通したのに、黙って効かない形を作らない)。組ごとに、
  // 「validateRule が断る」か「エンジンがその本文で検出する」のどちらか。断ってばかりで空回りしないよう、通すべき形が通り、当たることも確かめる
  const settle = (pattern, text) => {
    if (!validateRule(regex(pattern)).ok) return "断った";
    assert.ok(detect(regex(pattern), text).length >= 1, `通したのに、エンジンの本文に当たらない: ${JSON.stringify(pattern)} (${codes(pattern)}) / ${JSON.stringify(text)} (${codes(text)})`);
    return "当たった";
  };
  const D = DASHES[0];
  const tel = `TEL 090${D}1234${D}5678 desu`;
  // グループの端や繰り返しの継ぎ目にあるハイフン類
  for (const p of [`\\d{3}(${D}\\d{4})`, `\\d{2,4}(${D}\\d{2,4}){2}`, `(\\d{3}${D})\\d{4}`, `(?:\\d{3}${D}){2}\\d{4}`, `0\\d{1,4}(?:${D}\\d{1,4}){2}`]) {
    assert.equal(settle(p, tel), "断った", p);
  }
  // 前後が数字に当たりうる・パターンの先頭と末尾
  assert.equal(settle(`[0-9A-Z]${D}[0-9A-Z]`, `1${D}2`), "断った");
  assert.equal(settle(`\\w+${D}\\d+`, `A123${D}456`), "断った");
  assert.equal(settle(`${D}\\d{4}`, `123${D}4567`), "断った");
  assert.equal(settle(`\\d{4}${D}`, `1234${D}567`), "断った");
  // 分解された形 (NFD) は、NFC の本文にも NFD の本文にも当たらない
  const nfdDe = `テ${DAKUTEN}ータ\\d{4}`;
  assert.equal(settle(nfdDe, `${DE}ータ1234`), "断った");
  assert.equal(settle(nfdDe, `テ${DAKUTEN}ータ1234`), "断った");
  const nfdCafe = `cafe${ACUTE}-\\d{2}`;
  assert.equal(settle(nfdCafe, `caf${E_ACUTE}-12`), "断った");
  assert.equal(settle(nfdCafe, `cafe${ACUTE}-12`), "断った");
  // 通すべき形は通り、当たる
  assert.equal(settle(`${DE}ータ\\d{4}`, `${DE}ータ1234`), "当たった");
  assert.equal(settle(`${DE}ータ\\d{4}`, `テ${DAKUTEN}ータ1234`), "当たった", "NFD の本文も、エンジンが NFC に直す");
  assert.equal(settle(`caf${E_ACUTE}-\\d{2}`, `cafe${ACUTE}-12`), "当たった");
  assert.equal(settle(`x${ACUTE}\\d`, `x${ACUTE}1`), "当たった", "どの文字ともまとまらない結合文字は、そのまま残る");
  assert.equal(settle(`\\d{3}[${D}-]\\d{4}`, `123${D}4567`), "当たった");
  assert.equal(settle("\\d{3}-\\d{4}", `123${D}4567`), "当たった");
  assert.equal(settle(`\\d+${D}${D}\\d+`, `1${D}${D}2`), "当たった", "ハイフン類が 2 つ続くものは、エンジンも - に直さない");
  // 乱数 (決めた種) で作った正規表現と本文の組も同じ。生の本文に当たる正規表現を検査が通したなら、エンジンの本文にも当たる。
  // 数字・ハイフン類・かな・英字だけの短い本文と、グループ・繰り返し・選択肢・先読み・後読みを含む正規表現
  let seedB = 20261117;
  const rand = () => { seedB = (Math.imul(seedB, 1664525) + 1013904223) >>> 0; return seedB / 4294967296; };
  const from = (list) => list[Math.floor(rand() * list.length)];
  const atoms = ["\\d", "[0-9]", "[0-9A]", "\\w", ".", "1", "2", DASHES[0], DASHES[1], `[${DASHES[0]}-]`, "-", "あ", "A", "[あA]", `[${DASHES[0]}あ]`, "\\D", "[^a]"];
  const quants = ["", "", "", "?", "*", "+", "{2}", "{1,2}"];
  const sequence = (depth) => {
    let s = "";
    for (let i = 0, count = 1 + Math.floor(rand() * 4); i < count; i++) {
      const r = rand();
      if (depth > 0 && r < 0.3) s += from(["(", "(?:"]) + sequence(depth - 1) + (rand() < 0.3 ? "|" + sequence(depth - 1) : "") + ")" + from(quants);
      else if (r < 0.36) s += from(["(?=\\d)", "(?<!x)", "\\b", "(?<=\\d)"]);
      else s += from(atoms) + from(quants);
    }
    return s;
  };
  const textChars = ["1", "2", "7", DASHES[0], DASHES[1], "-", "あ", "A"];
  let accepted = 0;
  let compared = 0;
  for (let n = 0; n < 400; n++) {
    const pattern = sequence(2);
    if (pattern.length > 60 || !validateRule(regex(pattern)).ok) continue;
    accepted++;
    const rawRe = new RegExp(pattern, "u");
    for (let k = 0; k < 20; k++) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 7) }, () => from(textChars)).join("");
      if (!rawRe.test(text)) continue;
      compared++;
      assert.ok(detect(regex(pattern), text).length >= 1, `検査を通した正規表現が、同じ本文に当たらない: ${JSON.stringify(pattern)} / ${JSON.stringify(text)} (${codes(text)})`);
    }
  }
  assert.ok(accepted > 100 && compared > 500, `受け付けた正規表現 ${accepted} 個、比べた組 ${compared}`);

  // 結合文字・全角・エスケープを含む正規表現も同じ。パターンと、そのパターンに必ず当たる例の本文を、同じ乱数から作る。
  // 分解された形など、本文では別の形に直される文字を含むものは、例の本文 (生の字のまま) には当たっても、エンジンの本文には当たらない。
  // 検査を通したものは、エンジンでも例に当たる (ここで断られたものがあることも確かめる)
  const lits = ["テ", DE, "か", GA, "ハ", PA, DAKUTEN, HANDAKUTEN, "e", E_ACUTE, ACUTE, "x", "a", "1", "-", "ー", "c", "ＡＢ"];
  const kinds = [["[あ-ん]", "あ"], ["[a-z]", "a"], ["\\w", "a"], [".", "x"], ["\\S", "x"], [`[${DE}か]`, "か"]];
  const escapes = [[`${BACKSLASH}u0301`, ACUTE], [`${BACKSLASH}u3099`, DAKUTEN], [`${BACKSLASH}u00e9`, E_ACUTE], [`${BACKSLASH}uFF21`, fromCodes(0xff21)]];
  const counts = [["", [1]], ["", [1]], ["?", [0, 1]], ["+", [1, 2]], ["{2}", [2]]];
  const build = (depth) => {
    let pat = "";
    let inst = "";
    for (let i = 0, count = 1 + Math.floor(rand() * 5); i < count; i++) {
      const r = rand();
      const [quant, times] = from(counts);
      const repeat = from(times);
      let p;
      let s;
      if (depth > 0 && r < 0.18) {
        const a = build(depth - 1);
        const b = rand() < 0.3 ? build(depth - 1) : null;
        p = from(["(", "(?:"]) + a.pat + (b ? `|${b.pat}` : "") + ")";
        s = (b && rand() < 0.5 ? b : a).inst;
      } else if (r < 0.3) [p, s] = from(kinds);
      else if (r < 0.35) [p, s] = from(escapes);
      else { p = from(lits); s = p; }
      pat += p + quant;
      inst += s.repeat(repeat);
    }
    return { pat, inst };
  };
  let acceptedLive = 0;
  let rejectedLive = 0;
  for (let n = 0; n < 500; n++) {
    const { pat, inst } = build(2);
    let rawRe;
    try { rawRe = new RegExp(pat, "u"); } catch { continue; }
    if (pat.length > 70 || inst === "" || !rawRe.test(inst)) continue;
    if (!validateRule(regex(pat)).ok) { rejectedLive++; continue; }
    acceptedLive++;
    assert.ok(detect(regex(pat), inst).length >= 1, `検査を通した正規表現が、必ず当たるはずの例に当たらない: ${JSON.stringify(pat)} (${codes(pat)}) / ${codes(inst)}`);
  }
  assert.ok(acceptedLive > 100 && rejectedLive > 30, `通した ${acceptedLive} 個、断った ${rejectedLive} 個`);

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
