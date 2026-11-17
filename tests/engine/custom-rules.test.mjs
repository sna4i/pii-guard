// tests/engine/custom-rules.test.mjs — Pro のカスタムルールの部品 engine/custom-rules.js
// (Pro Phase 2 の設計 (P1)、T-CR-01〜13・54)
//
// ルールの検査 (validateRule・isRiskyPattern・stressTest)、組み立て (compileRule・compileRules)、
// 書き出しと読み込み (exportRules・importRules) を、部品だけで確かめる。エンジンへの組み込みは別のテスト。
// 使う値はすべて架空のもの (アルファ計画・ACME-1234・山田商事)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  LIMITS, LABEL_RE, DEFAULT_LABEL, STORAGE_KEY,
  validateRule, isRiskyPattern, stressTest, compileRule, compileRules, exportRules, importRules,
} = require("../../browser-extension/engine/custom-rules.js");

// 見えない文字・全角の空白・ハイフン類は、文字そのものをファイルに書かず、コード番号から作る
const fromCodes = (...codes) => String.fromCharCode(...codes);
const ZWSP = fromCodes(0x200b); // ゼロ幅スペース
const SOFT_HYPHEN = fromCodes(0x00ad);
const BOM = fromCodes(0xfeff);
const IDEOGRAPHIC_SPACE = fromCodes(0x3000); // 全角の空白
// 数字に挟まれると、エンジンが - に直すハイフン類のうち、NFKC では変わらないもの (ー・U+2010・U+2012〜U+2015・U+2212)
const DASHES = [0x30fc, 0x2010, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212].map((c) => fromCodes(c));
// 結合文字 (濁点・アクセント)。「テ」+ 濁点は NFKC で「デ」に、「e」+ アクセントは「é」にまとめられる
const DAKUTEN = fromCodes(0x3099);
const ACUTE = fromCodes(0x0301);
const BACKSLASH = fromCodes(92); // バックスラッシュ。エスケープ (u と 16 進数) を、ファイルに書かずに組み立てるため

// エンジンと同じに、組み立てた pattern を NFKC に直した文に当て、当たった文字列を文の順に返す。
// これは NFKC だけの近似。見えない文字・数字に挟まれたハイフン類・1 桁ずつ空白で区切った数字まで含めて、
// エンジンの本文の形と合うかは、tests/engine/custom-rules-normalization.test.mjs が本物のエンジンで確かめる
function hits(rule, text) {
  const compiled = compileRule(rule);
  assert.ok(compiled, `組み立てられるルールで試す: ${JSON.stringify(rule)}`);
  const re = new RegExp(compiled.pattern.source, compiled.pattern.flags);
  return [...text.normalize("NFKC").matchAll(re)].map((m) => m[0]);
}
const exact = (...words) => ({ kind: "words", words, match: "exact" });
const partial = (...words) => ({ kind: "words", words, match: "partial" });
const regex = (pattern, extra) => ({ kind: "regex", pattern, ...extra });
function ruleOf(input) {
  const r = validateRule(input);
  assert.equal(r.ok, true, `通るはず: ${JSON.stringify(input)} ${r.ok ? "" : r.errors.join(" / ")}`);
  return r.rule;
}
function errorsOf(input) {
  const r = validateRule(input);
  assert.equal(r.ok, false, `断るはず: ${JSON.stringify(input)}`);
  assert.ok(Array.isArray(r.errors) && r.errors.length >= 1 && r.errors.every((m) => typeof m === "string" && m.length > 0));
  return r.errors;
}
// 試しの時間をいつも 0 と測る時計 (本物の時計だと、実行する環境の揺れで読み込みの結果が変わりうる)
const noStress = { clock: () => 0 };
const fileOf = (rules) => JSON.stringify({ format: "pii-guard-custom-rules", version: 1, rules });

test("T-CR-01 正しいルールを受け付け、名前が無ければ CUSTOM、enabled の既定は true", () => {
  const r = validateRule({ kind: "regex", pattern: "ACME-\\d{4}" });
  assert.equal(r.ok, true);
  assert.equal(r.rule.label, "CUSTOM");
  assert.equal(r.rule.enabled, true);
  assert.equal(r.rule.ignoreCase, false);
  assert.equal(typeof r.rule.id, "string");
  assert.ok(r.rule.id.length > 0);
  assert.notEqual(ruleOf(regex("a1")).id, ruleOf(regex("a1")).id, "id が無いルールには、毎回別の id を付ける");
  assert.equal(ruleOf(regex("a1", { label: "" })).label, "CUSTOM", "名前が空の文字でも CUSTOM");
  assert.equal(ruleOf({ kind: "words", words: ["アルファ計画"] }).match, "exact", "完全一致か部分一致かの指定が無ければ完全一致");

  // 渡した id・名前・enabled はそのまま残る。種類に関係ない項目と未知の項目は取り除く。入力は書き換えない
  const given = Object.freeze({ id: "r-1", label: "PROJECT_1", kind: "words", enabled: false, words: Object.freeze(["アルファ計画"]), match: "partial", ignoreCase: true, junk: 1 });
  assert.deepEqual(validateRule(given), { ok: true, rule: { id: "r-1", label: "PROJECT_1", kind: "words", enabled: false, words: ["アルファ計画"], match: "partial" } });
  const { id, ...rest } = ruleOf({ kind: "regex", pattern: "a1", words: ["x"], match: "exact", junk: 1 });
  assert.ok(id);
  assert.deepEqual(rest, { label: "CUSTOM", kind: "regex", enabled: true, pattern: "a1", ignoreCase: false });

  // 正しくない形は、例外にせず理由を返す
  for (const bad of [null, undefined, "regex", 42, [], {}, { kind: "glob", pattern: "a" }, { kind: "regex" }, { kind: "regex", pattern: 5 }]) errorsOf(bad);
  // 真偽値でない enabled・ignoreCase、決まった値でない match、文字列でない id を、黙って通さない
  assert.equal(errorsOf(regex("a1", { enabled: "false" })).length, 1);
  assert.equal(errorsOf(regex("a1", { ignoreCase: "yes" })).length, 1);
  assert.equal(errorsOf({ kind: "words", words: ["a1"], match: "fuzzy" }).length, 1);
  assert.equal(errorsOf(regex("a1", { id: 5 })).length, 1);
});

test("T-CR-02 名前の形: PROJECT_1 は通り、project・1ABC・33 文字は断る", () => {
  for (const label of ["PROJECT_1", "A", "ACME_ID", "A".repeat(32)]) assert.equal(ruleOf(regex("a1", { label })).label, label);
  for (const label of ["project", "Project", "1ABC", "_ABC", "ABC-1", "ABC DEF", " ABC", "ABC\n", "ＰＲＯＪＥＣＴ", "A".repeat(33), 5]) {
    assert.ok(errorsOf(regex("a1", { label })).some((m) => m.includes("英大文字")), `名前 ${JSON.stringify(label)} は断る`);
  }
  assert.ok(errorsOf({ ...exact("アルファ計画"), label: "project" }).some((m) => m.includes("英大文字")), "単語リストも同じ");
  assert.equal(LABEL_RE.test("PROJECT_1"), true);
  assert.equal(LABEL_RE.test("project"), false);
});

test("T-CR-03 正規表現: 文法の誤り・空の文字に当たるもの (x*、\\b、^)・201 文字は断る。200 文字ちょうどは通る (境界値)", () => {
  for (const bad of ["(", "[a-", "a{2,1}", "*a", "(?<n>a)(?<n>b)"]) assert.ok(errorsOf(regex(bad)).length >= 1, `文法の誤り: ${bad}`);
  // 空の文字に当たるもの。\b や ^ のように、幅 0 で当たるものも含む
  for (const empty of ["x*", "\\b", "^", "$", "a?", "(?:)", "(?=a)", "\\d*", "(ACME)?", "[A-Z]*", "\\B"]) {
    assert.ok(errorsOf(regex(empty)).some((m) => m.includes("空")), `空の文字に当たる: ${empty}`);
  }
  // 文脈があるときだけ空に当たる形 (先読み・後読みだけ、後ろが省けるもの) も断る。
  // エンジンは長さ 0 の当たりを飛ばして 1 文字進むので、何も伏せないルールになる
  for (const context of ["(?=ACME)", "(?<=ID:)", "(?<=ACME-)\\d*", "(?=ACME)|ACME-\\d{4}"]) {
    assert.ok(errorsOf(regex(context)).some((m) => m.includes("空")), `文脈があるときだけ空に当たる: ${context}`);
  }
  // 中身のあるものと一緒に使う \b・^・$・先読みは通る。\p{...} も使える (エンジンの今のルールと同じ u フラグ)
  for (const fine of ["\\b\\d{4}\\b", "^ACME-\\d{4}$", "(?<![A-Za-z0-9])ACME(?![A-Za-z0-9])", "\\p{Script=Han}{2,4}さん"]) {
    assert.equal(validateRule(regex(fine)).ok, true, fine);
  }
  assert.ok(errorsOf(regex("")).length >= 1, "何も書いていない");
  // 200 文字ちょうどは通り、201 文字は断る
  const p200 = "[A-Z]".repeat(40);
  assert.equal(p200.length, 200);
  assert.equal(validateRule(regex(p200)).ok, true);
  assert.ok(errorsOf(regex(p200 + "a")).some((m) => m.includes("200")));
  // 理由は全部出す (名前と正規表現の両方が正しくない)
  assert.equal(errorsOf(regex("(", { label: "bad" })).length, 2);
});

test("T-CR-04 危ない形を断る: (a+)+ / (a*)* / (\\w+\\s?)+ / (a|aa)* は true、ACME-\\d{4} / [A-Z]{2,5}-\\d+ は false (isRiskyPattern を直接と、validateRule の errors の両方で)", () => {
  const risky = [
    "(a+)+", "(a*)*", "(\\w+\\s?)+", "(a|aa)*",
    "([a-zA-Z]+)*", "(a|a?)+", "(.*a){20}", "^(([a-z])+.)+[A-Z]([a-z])+$",
    "(x+x+)+y", "(\\d|\\w)+", "(?:a+)+", "(?<w>a+)+", "((a+))+", "(a{1,3})+", "(a+){2,}",
    "(a|b|ab)*", "(\\d{3}|\\d{4})+", "(.|\\s)*", "(?:a|aa)+", "(?<w>a|aa)+", "(a{1,3}){2,}",
    // 先読み・後読みは幅 0 なので、選択肢の最初の文字には数えない ((?<!x)a は a で始まる)
    "(?:(?<!x)a|a)+",
    // 繰り返しも選択肢も無く見えても、中身が全部省けて空に当たりうる並びの繰り返し ("ab" の列で指数的に遅い)
    "(a?b?)+c",
    // \p{...} で書いた文字の種類も、見本の文字 (アラビア・ヘブライ・タイ・ハングルなど) で、重なりを調べる
    "(\\p{Script=Arabic}|\\p{L})+$", "(\\p{Script=Thai}|\\p{L})+x", "(\\p{Script=Thai}|[ก-๛])+x",
  ];
  const safe = [
    "ACME-\\d{4}", "[A-Z]{2,5}-\\d+", "\\d{3}-\\d{4}-\\d{4}", "(?:090|080|070)-\\d{4}-\\d{4}", "(株)?山田商事", "https?://[^\\s]+",
    "\\d{1,3}(,\\d{3})+", "(\\d{1,3}\\.){3}\\d{1,3}", "(?:a|b)+c", "(東京|大阪|名古屋)支社", "\\b\\d{4}\\b", "(?:\\d{3}-?){2,}",
    "a|aa", "x(a|aa)?y", "((a|)b)+", "(\\p{Script=Arabic}|\\p{Script=Hebrew})+x",
    // エスケープした括弧やクラスの中の + は、グループや繰り返しとして数えない
    "\\(\\d+\\)+", "([+-]\\d)+", "[(+*]+x",
  ];
  for (const p of risky) {
    assert.equal(isRiskyPattern(p), true, `危ない形: ${p}`);
    assert.ok(errorsOf(regex(p)).some((m) => m.includes("繰り返し")), `validateRule も断る: ${p}`);
  }
  for (const p of safe) {
    assert.equal(isRiskyPattern(p), false, `安全な形: ${p}`);
    assert.equal(validateRule(regex(p)).ok, true, `validateRule は通す: ${p}`);
  }
  // 読み解けないほど深い入れ子は、例外にせず、危ない形として扱う
  assert.equal(isRiskyPattern("(".repeat(20000) + ")".repeat(20000)), true);
});

test("T-CR-05 単語リスト: 空・501 語・101 文字の語は断る。500 語と 100 文字はちょうど通る。重複と前後の空白は取り除く", () => {
  const words = (list, extra) => ({ kind: "words", words: list, match: "exact", ...extra });
  assert.ok(errorsOf(words([])).length >= 1, "空のリスト");
  assert.ok(errorsOf(words(["", "   ", "\t\n"])).length >= 1, "空白だけの行は語として数えない");
  assert.ok(errorsOf(words([ZWSP, ` ${SOFT_HYPHEN}${BOM} `])).length >= 1, "見えない文字だけの行も、語として数えない (組み立てると空の語になる)");
  assert.ok(errorsOf({ kind: "words", match: "exact" }).length >= 1, "words が無い");
  assert.ok(errorsOf(words([123])).length >= 1, "文字列でない語");

  const many = (n) => Array.from({ length: n }, (_, i) => `語${String(i).padStart(4, "0")}`);
  assert.equal(ruleOf(words(many(500))).words.length, 500);
  assert.ok(errorsOf(words(many(501))).some((m) => m.includes("500")));

  assert.equal(ruleOf(words(["あ".repeat(100)])).words[0].length, 100);
  assert.ok(errorsOf(words(["あ".repeat(101)])).some((m) => m.includes("100")));
  // NFKC に直すと 100 文字を超える語も断る (「ﷺ」は NFKC で 18 文字になる)
  assert.ok(errorsOf(words(["ﷺ".repeat(6)])).some((m) => m.includes("100")));

  // 前後の空白 (全角の空白を含む) と重複を取り除く。順番は最初に出てきた順
  assert.deepEqual(ruleOf(words(["  アルファ計画 ", "アルファ計画", "山田商事", "\t山田商事\n", `${IDEOGRAPHIC_SPACE}ACME-1234${IDEOGRAPHIC_SPACE}`])).words, ["アルファ計画", "山田商事", "ACME-1234"]);
  // 語の途中の空白は残す
  assert.deepEqual(ruleOf(words(["山田 商事"])).words, ["山田 商事"]);
  // 重複を除いて 500 語に収まるなら通る
  assert.equal(ruleOf(words([...many(500), ...many(10)])).words.length, 500);
});

test("T-CR-06 完全一致の境界: 同じ種類の文字が続くなら当たらず、種類の切り替わり・記号・空白・文の端なら当たる。部分一致はどこでも当たる (Pro Phase 2 の設計 (P1) の例)", () => {
  // [語, 本文, 当たるはずの文字列]。種類は 英数字・ひらがな・カタカナ (ー を含む)・漢字 (々 を含む) の 4 つ
  const cases = [
    ["アルファ計画", "アルファ計画は来週", ["アルファ計画"]],
    ["アルファ計画", "弊社のアルファ計画、", ["アルファ計画"]],
    ["アルファ計画", "アルファ計画書", []],
    ["アルファ計画", "新アルファ計画", ["アルファ計画"]],
    ["アルファ計画", "ベータアルファ計画", []],
    ["アルファ計画", "ベータ・アルファ計画", ["アルファ計画"]],
    ["山田商事", "山田商事さんから", ["山田商事"]],
    ["山田商事", "弊社と山田商事の", ["山田商事"]],
    ["山田商事", "株式会社山田商事", []],
    ["山田商事", "山田商事株式会社", []],
    ["山田商事", "山田商事 山田商事、山田商事.", ["山田商事", "山田商事", "山田商事"]],
    ["ABC-123", "ID: ABC-123,", ["ABC-123"]],
    ["ABC-123", "ABC-1234", []],
    ["ABC-123", "XABC-123", []],
    ["ABC-123", "ABC-123X", []],
    ["ABC-123", "ID（ABC-123）", ["ABC-123"]],
    ["ABC-123", "日本ABC-123", ["ABC-123"]],
    ["ABC-123", "ABC-123", ["ABC-123"]],
    // 語の端がひらがなのときは、隣のひらがなと区切れない (その語は部分一致を使う)
    ["さくら", "さくらさん", []],
    ["さくら", "桜さくら", ["さくら"]],
    // カタカナの伸ばす棒 (ー) はカタカナ、々は漢字
    ["サーバー", "サーバーです", ["サーバー"]],
    ["サーバー", "サーバーサイド", []],
    ["我々", "我々は", ["我々"]],
    ["我々", "我々人間", []],
    // 記号で始まる (終わる) 語は、その側に条件を付けない
    ["#アルファ", "x#アルファです", ["#アルファ"]],
    ["ABC-", "ABC-123", ["ABC-"]],
    // 英数字と漢字が混ざる語は、端ごとに見る
    ["A社", "BA社", []],
    ["A社", "A社員", []],
    ["A社", "A社の", ["A社"]],
    ["A社", "あA社", ["A社"]],
  ];
  for (const [word, text, want] of cases) assert.deepEqual(hits(exact(word), text), want, `完全一致 ${word} / ${text}`);

  // 先頭の文字の種類が違う語 (漢字・カタカナ・英数字・記号・ひらがな) を 1 つのリストに混ぜても、語ごとに自分の境界で当たる
  const mixed = exact("山田商事", "アルファ計画", "ABC-123", "#アルファ", "さくら");
  assert.deepEqual(hits(mixed, "山田商事、アルファ計画、ABC-123、x#アルファ、さくら"), ["山田商事", "アルファ計画", "ABC-123", "#アルファ", "さくら"]);
  assert.deepEqual(hits(mixed, "株式会社山田商事 ベータアルファ計画 XABC-123 ABC-1234 アルファ計画書 山田商事株式会社 さくらさん"), []);
  // 500 語でも、後読みは先頭の文字の種類ごとに 1 つだけ (語の数だけ置くと、長い本文で 10 倍ほど遅い)
  const kinds = ["山", "ア", "A", "あ", "#"];
  const big = compileRule(exact(...Array.from({ length: 500 }, (_, i) => `${kinds[i % 5]}${String(i).padStart(3, "0")}語`)));
  assert.ok((big.pattern.source.match(/\(\?<!/g) || []).length <= 4, "後読みの数");

  // 部分一致はどこでも当たる
  assert.deepEqual(hits(partial("アルファ計画"), "アルファ計画書"), ["アルファ計画"]);
  assert.deepEqual(hits(partial("ABC-123"), "ABC-1234"), ["ABC-123"]);
  assert.deepEqual(hits(partial("さくら"), "さくらさん"), ["さくら"]);

  // 長い語を先に試す: 短い語が同じ所で当たっても、長い語を取る
  assert.deepEqual(hits(partial("アルファ", "アルファ計画"), "アルファ計画書"), ["アルファ計画"]);
  assert.deepEqual(hits(exact("アルファ", "アルファ計画"), "アルファ計画は"), ["アルファ計画"]);
  // 複数の語は、本文に出てくる順に当たる
  assert.deepEqual(hits(exact("アルファ計画", "山田商事"), "山田商事とアルファ計画"), ["山田商事", "アルファ計画"]);
  // 正規表現の記号を含む語は、そのままの文字として当たる
  const symbols = "a.b*c(1)[x]{2}|d+e?f^g$h\\i";
  assert.deepEqual(hits(partial(symbols), `z ${symbols} z axb*c(1)[x]{2}|d+e?f^g$h\\i`), [symbols]);
  assert.deepEqual(hits(exact(symbols), `z ${symbols} z axb*c(1)[x]{2}|d+e?f^g$h\\i`), [symbols]);
});

test("T-CR-07 全角の本文にも当たる (NFKC): 語 ACME-1234 と正規表現 ACME-\\d{4} が「ＡＣＭＥ－１２３４」に当たる", () => {
  const text = "コードはＡＣＭＥ－１２３４です";
  assert.deepEqual(hits(exact("ACME-1234"), text), ["ACME-1234"]);
  assert.deepEqual(hits(partial("ACME-1234"), text), ["ACME-1234"]);
  assert.deepEqual(hits(regex("ACME-\\d{4}"), text), ["ACME-1234"]);
  // 語のほうを全角で書いても当たる (語も NFKC に直して組み立てる)
  assert.deepEqual(hits(exact("ＡＣＭＥ－１２３４"), "ID: ACME-1234"), ["ACME-1234"]);
  // 語に見えない文字 (ゼロ幅スペース) が紛れていても当たる。エンジンは本文のほうの見えない文字を落とす
  assert.deepEqual(hits(partial(`アルファ${ZWSP}計画`), "アルファ計画"), ["アルファ計画"]);
  // 見えない文字を落としたあとに端に残る空白は、語の一部にしない
  assert.deepEqual(hits(partial(`${ZWSP} ABC`), "x ABC y"), ["ABC"]);

  // 正規表現の元は、そのまま使う (語のようには直せない)。全角の英数字・半角のカナ・㈱・見えない文字のように、
  // 本文を NFKC に直すと形が変わる文字が入っていると、本文には決して当たらない。黙って効かないルールにせず、保存のときに断る
  for (const bad of ["ＡＣＭＥ-\\d{4}", "ACME－\\d{4}", "ｱﾙﾌｧ計画", "㈱山田商事", `ACME${ZWSP}-\\d{4}`, `山田${IDEOGRAPHIC_SPACE}商事`]) {
    assert.ok(errorsOf(regex(bad)).some((m) => m.includes("NFKC")), `NFKC で形が変わる文字: ${JSON.stringify(bad)}`);
  }
  // 本文の形 (半角) で書けば当たる。かなや漢字は NFKC で変わらないので、そのまま書ける
  assert.deepEqual(hits(regex("\\(株\\)山田商事"), "㈱山田商事"), ["(株)山田商事"]);
  assert.equal(validateRule(regex("山田商事(さん|様)")).ok, true);
  // 文字クラスの中は、直した形がそのクラスにも入っていれば通す ([:：] の ： は、本文では : になり、: が入っている)。
  // 全部が変わってしまうクラスや、クラスの外に書いた文字は、断る
  for (const fine of ["社員番号[:：]\\s*\\d{3}", "[0-9０-９]{3}-\\d{4}", "[ＡA]CME-\\d{4}"]) assert.equal(validateRule(regex(fine)).ok, true, `通る形: ${fine}`);
  for (const bad of ["[Ａ-Ｚ]+-\\d{4}", "社員番号[：]\\d{3}", "社員番号：\\d{3}", "[ｱ-ﾝ]+", "(ＡＣＭＥ)-\\d{4}"]) {
    assert.ok(errorsOf(regex(bad)).some((m) => m.includes("NFKC")), `当たらない文字だけのクラス・クラスの外の文字: ${bad}`);
  }

  // 数字に挟まれたハイフン類 (ー ‐ ― − など) は、エンジンが - に直してから照合する。正規表現に書くと決して当たらないので断る。
  // ハイフン類の前後が「数字に当たりうる」とき (\d・[0-9A-Z]・\w・. など) に断る。必ず数字のときだけではない。
  // パターンの先頭と末尾は、前後に何が来るか分からないので、数字でありうる。先読み・後読みで隣が数字でないと言えても、通さない。
  // グループの境目や繰り返しの継ぎ目をまたいで、前後に来うる項目を見る
  for (const d of DASHES) {
    for (const bad of [
      `\\d{3}${d}\\d{4}`, `[0-9]+${d}[0-9]+`, `(\\d{3})${d}(\\d{4})`, `090${d}1234`, `\\d{3}(?:${d})\\d{4}`, `\\d{3}[${d}${DASHES[1]}]\\d{4}`,
      `x(?:\\d{3}${d}\\d{4})`, `(?:[A-Z]\\d)${d}\\d{3}`, `\\d{3}${d}(?:\\d[A-Z])`,
      // グループの端や繰り返しの継ぎ目にある
      `\\d{3}(${d}\\d{4})`, `\\d{2,4}(${d}\\d{2,4}){2}`, `(\\d{3}${d})\\d{4}`, `(?:\\d{3}${d}){2}\\d{4}`, `0\\d{1,4}(?:${d}\\d{1,4}){2}`,
      // 数字が、繰り返しの継ぎ目の向こう側にしか無い
      `A(?:\\d{3}${d}){2}B`, `A(?:${d}\\d{3}){2}B`,
      // 間の省ける項目・空の選択肢をまたぐ。先読み・後読みの中。後方参照 (何にでも当たりうる)
      `\\d{3}x?${d}\\d{4}`, `\\d{3}(?:x|)${d}\\d{4}`, `(?<=\\d${d})\\d{3}`, `x(?=\\d${d}\\d)`, `(\\d)${d}\\1`,
      // 選択肢のどれかが数字になりうる
      `(?:x|\\d{3})${d}\\d{4}`, `\\d{3}${d}(?:x|\\d{4})`,
      // 前後が数字に当たりうる (必ず数字とは限らない・省ける・- 以外も当たる)
      `[0-9A-Z]${d}[0-9A-Z]`, `\\d*${d}\\d+`, `\\w+${d}\\d+`, `\\d{3}${d}?\\d{4}`, `\\d{3}[${d}a]\\d{4}`, `.${d}.`,
      // パターンの先頭・末尾
      `${d}\\d{4}`, `\\d{4}${d}`, d, `${d}+`, `(?:${d})`, `[${d}${DASHES[1]}]`,
      // 先読み・後読みで隣が数字でないと言えても、通さない
      `\\d{3}(?<!x)${d}\\d{4}`, `\\d{3}${d}(?=\\d)\\d{4}`, `(?<=\\d)${d}`, `${d}(?=\\d)`,
    ]) {
      assert.ok(errorsOf(regex(bad)).some((m) => m.includes("数字の間")), `数字の間のハイフン類: ${bad}`);
    }
    // 前後が数字になりえない形と、- にも当たる項目 (- に直されても当たる) は通す。ハイフン類が 2 つ続くものは、エンジンも - に直さない
    for (const fine of [`\\d{3}-\\d{4}`, `\\d{3}[-${d}]\\d{4}`, `\\d{3}[${d}-]\\d{4}`, `あ${d}\\d{4}`, `\\d{3}${d}あ`, `\\d{3}${d}[A-Z]{2}`, `A${d}B`, `\\d+${d}${d}\\d+`]) {
      assert.equal(validateRule(regex(fine)).ok, true, `通る形: ${fine}`);
    }
  }
  // 断るときは、- と [ー-] の書き方を案内する
  assert.ok(errorsOf(regex(`\\d{3}${DASHES[0]}\\d{4}`)).some((m) => m.includes("数字の間は - と書") && m.includes("[ー-]")));
  // ハイフン類の前後が数字になりえない形は、今までどおり通す
  for (const fine of ["データ\\d{4}", "サーバー\\d{3}", "ー同じ", "[ァ-ヶ][ァ-ヶー]*", "カタカナ[ァ-ヶー]+"]) {
    assert.equal(validateRule(regex(fine)).ok, true, `通る形: ${fine}`);
  }

  // 分解された形 (「テ」+ 濁点、「e」+ アクセント) は、本文では NFKC で 1 文字 (「デ」「é」) にまとめられるので、決して当たらない。
  // 続いた普通の文字をまとめて、NFKC と比べる。結合文字が、グループやクラスの直後などで、まとめる相手が無いときも断る
  for (const bad of [
    `テ${DAKUTEN}ータ\\d{4}`, `cafe${ACUTE}-\\d{2}`, `[あ-ん]${DAKUTEN}`, `(?:cafe)${ACUTE}-\\d{2}`, `[a-z]${ACUTE}`, `${DAKUTEN}\\d`, `\\d+(?:x)?${ACUTE}`,
    `e${ACUTE}?-\\d{2}`,
    // エスケープで書いても、同じ
    `cafe${BACKSLASH}u0301-\\d{2}`, `${BACKSLASH}uFF21CME-\\d{4}`, `テ${BACKSLASH}u3099ー`, `${BACKSLASH}u{FF21}CME-\\d{4}`, `A${BACKSLASH}xa0B`,
  ]) {
    assert.ok(errorsOf(regex(bad)).some((m) => m.includes("NFKC")), `分解された形・まとまらない結合文字: ${JSON.stringify(bad)}`);
  }
  // まとめた形 (デ・é) と、どの文字ともまとまらない結合文字 (x のアクセント、タイ文字の母音) は通す
  for (const fine of [`${fromCodes(0x30c7)}ータ\\d{4}`, `caf${fromCodes(0x00e9)}-\\d{2}`, `x${ACUTE}\\d`, `[ก-ฮ]${fromCodes(0x0e34)}`, `caf${BACKSLASH}u00e9-\\d{2}`]) {
    assert.equal(validateRule(regex(fine)).ok, true, `通る形: ${JSON.stringify(fine)}`);
  }
});

test("T-CR-08 ignoreCase: true なら acme-1234 にも当たり、false なら当たらない", () => {
  const text = "id acme-1234 と Acme-5678";
  assert.deepEqual(hits(regex("ACME-\\d{4}", { ignoreCase: true }), text), ["acme-1234", "Acme-5678"]);
  assert.deepEqual(hits(regex("ACME-\\d{4}", { ignoreCase: false }), text), []);
  assert.deepEqual(hits(regex("ACME-\\d{4}"), text), [], "指定が無ければ区別する");
  assert.deepEqual(hits(regex("ACME-\\d{4}"), "ACME-1234"), ["ACME-1234"]);
});

test("T-CR-09 compileRules は enabled が false のものと正しくないものを除き、51 個目以降を捨てる", () => {
  const mk = (i, extra) => ({ id: `r${i}`, label: "PROJECT", kind: "regex", pattern: `X${i}-\\d+`, enabled: true, ignoreCase: false, ...extra });
  const input = [mk(0), mk(1, { enabled: false }), mk(2, { pattern: "(a+)+" }), ...Array.from({ length: 55 }, (_, i) => mk(i + 3))];
  const out = compileRules(input);
  assert.equal(out.length, 50);
  // r0 のあとは、除いた r1・r2 を飛ばして r3 から r51 まで
  assert.deepEqual(out.map((c) => c.ruleId), ["r0", ...Array.from({ length: 49 }, (_, i) => `r${i + 3}`)]);

  // 組み立てた 1 件の形: 名前が検出の種類と分類になる。pattern は g と u のフラグ付きの RegExp (エンジンが g で回す)
  assert.deepEqual(Object.keys(out[0]).sort(), ["category", "entity_type", "pattern", "ruleId"]);
  assert.equal(out[0].entity_type, "PROJECT");
  assert.equal(out[0].category, "PROJECT");
  assert.ok(out[0].pattern instanceof RegExp);
  assert.equal(out[0].pattern.source, "X0-\\d+");
  assert.equal(out[0].pattern.flags, "gu");
  assert.equal(compileRules([mk(0, { ignoreCase: true })])[0].pattern.flags, "giu");

  // compileRule は 1 件ずつ。正しくないものは null。enabled は見ない (設定画面が、保存の前に試すため)
  assert.equal(compileRule(mk(2, { pattern: "(a+)+" })), null);
  assert.equal(compileRule(null), null);
  assert.equal(compileRule(mk(1, { enabled: false })).ruleId, "r1");
  // 保存の中身が壊れていても例外にしない
  assert.deepEqual(compileRules(undefined), []);
  assert.deepEqual(compileRules([null, 5, "x", {}, []]), []);

  // ほかの部品と交わす約束の値 (エンジンの時間の上限、添付の時間の上限、保存のキー)
  assert.deepEqual({ ...LIMITS }, { maxRules: 50, maxPatternLength: 200, maxWords: 500, maxWordLength: 100, stressMs: 50, sendBudgetMs: 100, fileBudgetMs: 500 });
  assert.equal(STORAGE_KEY, "proCustomRules");
  assert.equal(DEFAULT_LABEL, "CUSTOM");
});

test("T-CR-10 stressTest: 危ない形を通り抜けた遅い正規表現は ok:false。偽の時計で 50 ミリ秒を超えさせて確かめる", () => {
  const re = compileRule(regex("ACME-\\d{4}")).pattern;
  // 1 回目の呼び出しは 0、そのあとは呼ぶたびに 60 進む時計 → 1 本目の試しで 60 ミリ秒
  let now = -60;
  const slow = () => (now += 60);
  assert.deepEqual(stressTest(re, undefined, slow), { ok: false, ms: 60 });
  // ずっと 0 を返す時計なら、いくら試しても 0 ミリ秒
  assert.deepEqual(stressTest(re, undefined, () => 0), { ok: true, ms: 0 });
  // 50 ミリ秒は、ルール 1 本ぶん (試し全部の合計)。1 回ごとは 10 ミリ秒でも、6 回で 60 になれば通らない
  const stepper = (step) => { let t = -step; return () => (t += step); };
  assert.deepEqual(stressTest(re, undefined, stepper(10)), { ok: false, ms: 60 });
  // 1 回目だけが重く、あとは 0 の時計: 合計がちょうど 50 なら通り、51 なら通らない。上限は引数で変えられる
  const firstOnly = (ms) => { let n = 0; return () => (n++ < 1 ? 0 : ms); };
  assert.deepEqual(stressTest(re, undefined, firstOnly(50)), { ok: true, ms: 50 }, "ms は、試し全部の合計");
  assert.equal(stressTest(re, undefined, firstOnly(51)).ok, false);
  assert.equal(stressTest(re, 100, firstOnly(60)).ok, true);
  assert.equal(stressTest(re, 10, firstOnly(40)).ok, false);
  // 渡した正規表現の状態 (lastIndex) を変えない
  re.lastIndex = 7;
  stressTest(re, undefined, () => 0);
  assert.equal(re.lastIndex, 7);
  // 空の文字に当たる正規表現を渡しても、止まらずに終わる (長さ 0 の当たりで 1 つ進める)
  assert.equal(stressTest(/x*/gu, undefined, () => 0).ok, true);
  // 試す回数 (時計を呼んだ回数の半分)。合計で上限を見るので、同じ動きをする文字は 1 つだけ試し、広い文字の種類に当たる文字を
  // 何本も足し合わせない。普通に書いた文字は 4 つまで。区切りの記号は試さず、パターンの文字に当たらない決まった文字は 1 つ試す。
  // \b があるときは、単語を作る文字かどうかも分ける。1 つの動きにつき、改行の有無 2 通り × 長さの段 5 つ = 10 回
  const probesOf = (source) => {
    let calls = 0;
    stressTest(compileRule(regex(source)).pattern, undefined, () => { calls += 1; return 0; });
    return calls / 2;
  };
  const sNoBoundary = probesOf("\\S+@\\S+"); // \S に当たる文字と当たらない文字 (空白) の 2 通り
  assert.ok(sNoBoundary >= 15 && sNoBoundary <= 40, `\\S+@\\S+: ${sNoBoundary}`);
  const literals = probesOf("[a-z]+abcdefghij"); // 書かれた文字は a b c d の 4 つまで
  assert.ok(literals >= 40 && literals <= 70, `[a-z]+abcdefghij: ${literals}`);
  assert.ok(probesOf("@+@+@+x") >= 15, "書かれた文字に当たらない決まった文字も試す");
  assert.ok(probesOf("\\b\\S+\\b") > probesOf("\\S+"), "\\b があると、単語を作る文字とそうでない文字を分ける");
  // 本物の時計で、速い形は通り、時間は数で返る
  const real = stressTest(re, 5000);
  assert.equal(real.ok, true);
  assert.equal(typeof real.ms, "number");
  // 本物の遅い形: 入れ子も重なる選択肢も無い (isRiskyPattern は通す) が、同じ文字の長い列で 3 乗の時間がかかる。
  // \w+\s*\w+@ は a の列で、x*x*x*y はパターンに書かれた x の列で、\p{Script=Hangul} はハングルの列で遅くなる
  // (試す文字に、パターンの中の文字と、\p{...} などの文字の種類に当たる文字を足してある)
  for (const cubic of ["\\w+\\s*\\w+@", "x*x*x*y", "\\p{Script=Hangul}+\\p{Script=Hangul}+\\p{Script=Hangul}+x"]) {
    assert.equal(validateRule(regex(cubic)).ok, true, cubic);
    const slowReal = stressTest(compileRule(regex(cubic)).pattern);
    assert.equal(slowReal.ok, false, cubic);
    assert.ok(slowReal.ms > 50, `${cubic} ms: ${slowReal.ms}`);
  }
  // 2 乗で済む形は通る。合計で見るので、広い文字の種類 (\S ・ . ・ \p{L}) を使う、ふつうの形が断られないことも確かめる
  // (同じ動きをする文字は 1 つだけ試す。パターンに書かれた記号 @ や . だけの長い列は試さない)
  for (const common of ["[A-Z]+-\\d+", "\\S+@\\S+", ".*ERROR.*", "\\p{L}+\\s\\p{L}+", "[^\\s]+@[^\\s]+\\.[a-z]+", "[a-z0-9-]+\\.internal\\.example\\.test", "[\\w.+-]+@example\\.test", "\\S+\\s*=\\s*\\S+"]) {
    const result = stressTest(compileRule(regex(common)).pattern);
    assert.equal(result.ok, true, `${common} ms: ${result.ms}`);
  }
});

test("T-CR-11 書き出しと読み込みの往復で同じルールに戻る。形と版は format/version", () => {
  const rules = [
    ruleOf({ id: "r1", label: "PROJECT", kind: "words", words: ["アルファ計画", "山田商事"], match: "exact" }),
    ruleOf({ id: "r2", label: "ACME_ID", kind: "regex", pattern: "ACME-\\d{4}", ignoreCase: true, enabled: false }),
  ];
  const text = exportRules(rules);
  assert.equal(typeof text, "string");
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, "pii-guard-custom-rules");
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.rules, rules);

  const back = importRules(text, [], noStress);
  assert.deepEqual(back.rules, rules);
  assert.equal(back.added, 2);
  assert.equal(back.duplicates, 0);
  assert.deepEqual(back.rejected, []);
  assert.equal(exportRules(back.rules), text, "読み込んだものをもう一度書き出しても同じ");

  // 書き出すのは決まった項目だけ (内部の項目をファイルに混ぜない)
  const withJunk = JSON.parse(exportRules([{ ...rules[0], ui: { open: true }, secret: "x" }]));
  assert.deepEqual(withJunk.rules, [rules[0]]);
  // ルールが 0 個でも、形は同じ
  assert.deepEqual(JSON.parse(exportRules([])), { format: "pii-guard-custom-rules", version: 1, rules: [] });
});

test("T-CR-12 読み込み: 壊れた JSON・format が違う・version が 2 は、今のルールを変えずに理由を返す", () => {
  const existing = [ruleOf({ id: "r1", kind: "regex", pattern: "ACME-\\d{4}" })];
  const snapshot = structuredClone(existing);
  const broken = [
    ["壊れた JSON", "{ not json"],
    ["空の文字", ""],
    ["JSON の null", "null"],
    ["配列だけ", "[]"],
    ["format が違う", JSON.stringify({ format: "other-tool", version: 1, rules: [] })],
    ["format が無い", JSON.stringify({ version: 1, rules: [] })],
    ["version が 2", JSON.stringify({ format: "pii-guard-custom-rules", version: 2, rules: [] })],
    ["version が文字列", JSON.stringify({ format: "pii-guard-custom-rules", version: "1", rules: [] })],
    ["version が無い", JSON.stringify({ format: "pii-guard-custom-rules", rules: [] })],
    ["rules が配列でない", JSON.stringify({ format: "pii-guard-custom-rules", version: 1, rules: "x" })],
    ["rules が無い", JSON.stringify({ format: "pii-guard-custom-rules", version: 1 })],
  ];
  for (const [name, text] of broken) {
    const r = importRules(text, existing);
    assert.deepEqual(r.rules, snapshot, `${name}: 今のルールは変わらない`);
    assert.equal(r.added, 0, name);
    assert.equal(r.duplicates, 0, name);
    // ファイル全体の理由は、index が -1 の 1 件として返す
    assert.equal(r.rejected.length, 1, name);
    assert.equal(r.rejected[0].index, -1, name);
    assert.ok(r.rejected[0].errors.length >= 1 && r.rejected[0].errors.every((m) => typeof m === "string" && m.length > 0), name);
  }
  assert.deepEqual(existing, snapshot, "渡した配列は書き換えない");
  // 版の理由には、見つけた版の数字が出る
  const v2 = importRules(JSON.stringify({ format: "pii-guard-custom-rules", version: 2, rules: [] }), existing);
  assert.ok(v2.rejected[0].errors.join("").includes("2"));
  // 文字列でないもの・今のルールが配列でないときも、例外にしない
  assert.equal(importRules(undefined, existing).rejected[0].index, -1);
  assert.deepEqual(importRules(fileOf([]), undefined).rules, []);
});

test("T-CR-13 読み込み: 正しいもの・正しくないもの・同じものが混ざると、added / duplicates / rejected がそれぞれ数え分けられる。合わせて 50 個を超える分は rejected", () => {
  const existing = [{ id: "r1", label: "PROJECT", kind: "words", enabled: true, words: ["アルファ計画", "山田商事"], match: "exact" }];
  const r = importRules(fileOf([
    { id: "x1", label: "ACME_ID", kind: "regex", pattern: "ACME-\\d{4}" }, // 0 足す
    { id: "x2", label: "bad", kind: "regex", pattern: "ACME" }, // 1 名前が小文字 → 断る
    { id: "other", label: "PROJECT", kind: "words", words: [" 山田商事 ", "アルファ計画"], match: "exact" }, // 2 r1 と中身が同じ (id・語の順番・前後の空白だけ違う)
    { kind: "regex", pattern: "(a+)+" }, // 3 危ない形 → 断る
    { id: "x1", label: "CUSTOM", kind: "regex", pattern: "ZED-\\d{3}" }, // 4 id は 0 と同じで中身は別 → 足す (id は作り直す)
    { id: "x6", label: "ACME_ID", kind: "regex", pattern: "ACME-\\d{4}", enabled: false }, // 5 0 と中身が同じ (オン/オフだけ違う)
    "ルールではない文字列", // 6 断る
    { label: "OTHER", kind: "regex", pattern: "ACME-\\d{4}" }, // 7 パターンは 0 と同じで、名前が違う → 足す
    { label: "PROJECT", kind: "words", words: ["山田商事"], match: "exact" }, // 8 r1 より語が少ない → 足す
    { label: "PROJECT", kind: "words", words: ["アルファ計画", "山田商事"], match: "partial" }, // 9 r1 と語は同じで、一致の仕方が違う → 足す
  ]), existing, noStress);
  assert.equal(r.added, 5);
  assert.equal(r.duplicates, 2);
  assert.deepEqual(r.rejected.map((x) => x.index), [1, 3, 6]);
  assert.ok(r.rejected[0].errors.some((m) => m.includes("英大文字")));
  assert.ok(r.rejected[1].errors.some((m) => m.includes("繰り返し")));
  assert.equal(r.rules.length, 6);
  assert.deepEqual(r.rules[0], existing[0], "今のルールは先頭にそのまま");
  assert.deepEqual(r.rules.slice(1).map((x) => x.label), ["ACME_ID", "CUSTOM", "OTHER", "PROJECT", "PROJECT"], "足したものは、ファイルの順");
  assert.equal(r.rules[1].id, "x1");
  assert.equal(typeof r.rules[2].id, "string");
  assert.equal(new Set(r.rules.map((x) => x.id)).size, 6, "id は重ならない");
  assert.equal(existing.length, 1, "渡した配列は書き換えない");

  // 合わせて 50 個まで。同じものは数えるだけで場所を取らない
  const full = (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, label: "CUSTOM", kind: "regex", enabled: true, pattern: `E${i}-\\d+`, ignoreCase: false }));
  const fresh = (i) => ({ label: "CUSTOM", kind: "regex", pattern: `N${i}-\\d+` });
  const cap = importRules(fileOf([fresh(0), { ...full(1)[0] }, fresh(1), fresh(2)]), full(49), noStress);
  assert.equal(cap.added, 1);
  assert.equal(cap.duplicates, 1);
  assert.deepEqual(cap.rejected.map((x) => x.index), [2, 3]);
  assert.ok(cap.rejected[0].errors.some((m) => m.includes("50")));
  assert.equal(cap.rules.length, 50);
  assert.deepEqual(cap.rules.slice(0, 49), full(49));
  const none = importRules(fileOf([fresh(0), { ...full(1)[0] }]), full(50), noStress);
  assert.equal(none.added, 0);
  assert.equal(none.duplicates, 1);
  assert.deepEqual(none.rejected.map((x) => x.index), [0]);
  assert.equal(none.rules.length, 50);

  // 保存のときと同じ試し: 50 ミリ秒を超えるルールは足さない
  let now = -60;
  const slow = importRules(fileOf([fresh(0)]), [], { clock: () => (now += 60) });
  assert.equal(slow.added, 0);
  assert.deepEqual(slow.rules, []);
  assert.equal(slow.rejected.length, 1);
  assert.equal(slow.rejected[0].index, 0);
});

test("T-CR-54 名前が USER_DEFINED_ で始まるルールは断る (「常に伏せる語」の行の名前の形で、開いたサイドバーの組み直しがその名前の行を捨てるため)。読み込みも同じ理由で断る", () => {
  for (const label of ["USER_DEFINED_", "USER_DEFINED_OTHER", "USER_DEFINED_PERSON", "USER_DEFINED_X1"]) {
    const errors = errorsOf(regex("a1", { label }));
    assert.ok(errors.some((m) => m.includes("USER_DEFINED_")), `名前 ${label} は断る (${errors.join(" / ")})`);
    assert.ok(errorsOf({ ...exact("アルファ計画"), label }).some((m) => m.includes("USER_DEFINED_")), `単語リストも同じ (${label})`);
    assert.equal(compileRule({ ...exact("アルファ計画"), label }), null, `エンジンも組み立てない: 保存済みのルールでも効かない (${label})`);
  }
  // 似ているだけの名前は、これまでどおり通る
  for (const label of ["USER_DEFINED", "USER_DEFINEDX", "USERDEFINED_OTHER", "MY_USER_DEFINED_OTHER"]) assert.equal(ruleOf(regex("a1", { label })).label, label);

  const imported = importRules(fileOf([{ id: "u1", label: "USER_DEFINED_OTHER", kind: "words", words: ["アルファ計画"], match: "exact" }]), [], noStress);
  assert.equal(imported.added, 0);
  assert.deepEqual(imported.rejected.map((r) => r.index), [0]);
  assert.ok(imported.rejected[0].errors.some((m) => m.includes("USER_DEFINED_")), "読み込みでも、理由つきで断る");
});
