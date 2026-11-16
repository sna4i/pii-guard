// engine/custom-rules.js — Pro 版のカスタムルール (Pro Phase 2 の設計 (P1)、T-CR-01〜14)
//
// 利用者が足す「正規表現」と「単語リスト」のルールを、確かめ、エンジンが当てられる形に組み立てる。
// 純粋な関数だけの部品 (node のテストからも、設定画面からも、エンジンからも読む)。
//   validateRule    1 件のルールを確かめる。保存と読み込みで同じ決まりを使う。理由は日本語
//   isRiskyPattern  時間を食いやすい形か (繰り返しの中の繰り返し、重なる選択肢の繰り返し)
//   stressTest      長い意地悪な文に当てて、そのルールの試し全部で上限を超えないか測る
//   compileRule(s)  pro-rules.js と同じ { entity_type, pattern } に、止める単位 category を足した形に組み立てる
//   exportRules / importRules  JSON の書き出しと読み込み
//
// 正規表現の 1 回の照合は、途中で止められない。だから、送る前の時間の上限 (エンジンが見る) だけでは
// 固まるのを防げない。保存と読み込みのときの 2 つの確かめ (isRiskyPattern と stressTest) で、
// 遅い形をそもそもルールに入れない。
//
// 照合は、エンジンが整えた本文 (engine/engine.js の nfkcWithMap) に対して行う。語も同じ形に直して組み立てる。
// 完全一致の境界 (語の前後の文字の種類) は、エンジンの validate には隣の文字が渡らないので、
// 組み立てる正規表現の中に先読み・後読みで書く。
"use strict";

(function attach(root) {
  const LIMITS = Object.freeze({
    maxRules: 50, maxPatternLength: 200, maxWords: 500, maxWordLength: 100,
    stressMs: 50, sendBudgetMs: 100, fileBudgetMs: 500,
  });
  const LABEL_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
  const DEFAULT_LABEL = "CUSTOM";
  const STORAGE_KEY = "proCustomRules";
  const EXPORT_FORMAT = "pii-guard-custom-rules";
  const EXPORT_VERSION = 1;

  const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  // ルールを見分ける印。randomUUID が無い文脈 (安全でないページ) でも、例外で検出を止めない
  function newId() {
    if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // ---- エンジンが当てる本文の形にそろえる -------------------------------------------------
  // engine/engine.js の nfkcWithMap と同じ決まりで、語を直す。ずれると、語が本文に黙って当たらなくなる
  // (ずれは tests/engine/custom-rules-normalization.test.mjs が、本物のエンジンを通して見つける)。
  //   - NFKC に直す (全角の英数字・半角のカナなど)
  //   - 見えない文字 (ソフトハイフン・ゼロ幅スペースなど・単語結合子・BOM。Web や PDF からの貼り付けで紛れ込む) を落とす
  //   - 数字に挟まれたハイフン類を - に直す
  //   - 1 桁ずつ空白で区切った数字 (OCR や PDF の貼り付け) の空白を落とす
  // 正規表現の元は、記号の意味が変わるので直せない。この形と違う文字を書いていたら、保存のときに断る。
  // 見えない文字・全角の空白・ハイフン類は、文字そのものをファイルに書かず、コード番号から作る
  const fromCodes = (...codes) => String.fromCharCode(...codes);
  const INVISIBLE_RE = new RegExp(`[${fromCodes(0x00ad, 0x200b)}-${fromCodes(0x200d)}${fromCodes(0x2060, 0xfeff)}]`, "g");
  // 数字に挟まれたとき、エンジンが - に直すハイフン類: ー (30FC)、‐ ‑ ‒ – — ― (2010〜2015)、− (2212)、﹣ (FE63)
  const DASHES = fromCodes(0x30fc, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe63);
  const FULLWIDTH_HYPHEN = fromCodes(0xff0d);
  const IDEOGRAPHIC_SPACE = fromCodes(0x3000);
  const FULLWIDTH_DIGITS = `${fromCodes(0xff10)}-${fromCodes(0xff19)}`;
  const DIGIT_DASH_RE = new RegExp(`(?<=[0-9])[${DASHES}](?=[0-9])`, "g");
  const SPACED_DIGITS_RE = new RegExp(`(?<![0-9${FULLWIDTH_DIGITS}])[0-9${FULLWIDTH_DIGITS}](?:[ ${IDEOGRAPHIC_SPACE}][0-9${FULLWIDTH_DIGITS}])+(?![0-9${FULLWIDTH_DIGITS}])`, "g");
  const DIGIT_SPACE_DIGIT_RE = new RegExp(`[0-9${FULLWIDTH_DIGITS}][ ${IDEOGRAPHIC_SPACE}][0-9${FULLWIDTH_DIGITS}]`);
  const DASH_AFTER_RE = new RegExp(`^[-${FULLWIDTH_HYPHEN}${DASHES}]\\s?[0-9${FULLWIDTH_DIGITS}]`);
  const DASH_BEFORE_RE = new RegExp(`[0-9${FULLWIDTH_DIGITS}]\\s?[-${FULLWIDTH_HYPHEN}${DASHES}]$`);

  // 1 桁の数字が 1 つの空白で並ぶ並びは、3 桁以上か、ハイフン類で次の数字のかたまりにつながるときだけ、空白を落とす
  // (エンジンの spacedDigitGaps と同じ。「1 2」のような 2 桁までの並びは、そのまま)
  function dropDigitSpaces(text) {
    if (!DIGIT_SPACE_DIGIT_RE.test(text)) return text;
    const drop = new Set();
    for (const m of text.matchAll(SPACED_DIGITS_RE)) {
      const end = m.index + m[0].length;
      const joined = DASH_AFTER_RE.test(text.slice(end, end + 3)) || DASH_BEFORE_RE.test(text.slice(Math.max(0, m.index - 3), m.index));
      if ((m[0].length + 1) / 2 < 3 && !joined) continue;
      for (let k = 1; k < m[0].length; k += 2) drop.add(m.index + k); // 数字と数字の間の空白
    }
    if (drop.size === 0) return text;
    let out = "";
    for (let i = 0; i < text.length; i++) if (!drop.has(i)) out += text[i];
    return out;
  }
  const toEngineForm = (s) => s.normalize("NFKC").replace(INVISIBLE_RE, "");
  const normalizeWord = (word) => toEngineForm(dropDigitSpaces(word)).replace(DIGIT_DASH_RE, "-").trim();

  // ---- 検査 ---------------------------------------------------------------------------
  const LABEL_MESSAGE = "伏せ字の名前は英大文字で始め、英大文字・数字・_ だけで 32 文字までにしてください";
  // USER_DEFINED_ で始まる名前は、「常に伏せる語」(サイドバーから足す語) の行の名前の形。開いたサイドバーは、語が変わると
  // その形の行を捨てて組み直すので、カスタムの行も黙って消える
  const RESERVED_LABEL_PREFIX = "USER_DEFINED_";
  const RESERVED_LABEL_MESSAGE = `伏せ字の名前は ${RESERVED_LABEL_PREFIX} で始められません (「常に伏せる語」の伏せ字が使う名前です)。別の名前にしてください`;
  const NFKC_MESSAGE = "本文は NFKC (全角の英数字を半角に直す、「テ」と濁点を「デ」にまとめる、など) で整えてから照合するため、全角の英数字・記号、半角のカナ、㈱、見えない文字、分解された形 (「e」とアクセントなど) は、正規表現に入れても当たりません。整えたあとの形で書いてください (ＡＣＭＥ は ACME、㈱ は \\(株\\)、「e」とアクセントは é)。結合文字は、直前の文字とまとめた形にしてください";
  const DASH_MESSAGE = "ハイフン類 (ー ‐ ― − など) が、数字に当たりうる文字の間にあります (パターンの先頭と末尾の前後も、数字でありうるとみなします)。本文では、数字に挟まれたハイフン類は - に直されてから照合するため、当たりません。数字の間は - と書くか、[ー-] のように - も入れたクラスで書いてください";
  const EMPTY_MESSAGE = "空の文字にも当たる形は使えません (x* ・ \\b ・ ^ ・ (?=ID) など)。何かの文字に必ず当たる形にしてください";
  // 空の文字に当たるかを調べる短い文。幅 0 で当たるもの (\b ・ ^ ・ 先読み) も、どれかで長さ 0 の当たりになる
  const EMPTY_SAMPLES = ["", "a", "A", "0", " ", "-", "_", "\n", "あ", "ア", "漢", "aA0 -_\nあア漢"];

  function matchesEmpty(re) {
    for (const sample of EMPTY_SAMPLES) {
      for (const m of sample.matchAll(re)) if (m[0] === "") return true;
    }
    return false;
  }
  function parseOrNull(source) {
    try { return parseSource(source); } catch (_) { return null; }
  }

  function checkRegex(input, errors) {
    const { pattern } = input;
    let ignoreCase = input.ignoreCase;
    if (ignoreCase === undefined) ignoreCase = false;
    else if (typeof ignoreCase !== "boolean") errors.push("ignoreCase は true か false で書いてください");

    if (typeof pattern !== "string" || pattern === "") {
      errors.push("正規表現 (pattern) を文字列で入れてください");
    } else if (pattern.length > LIMITS.maxPatternLength) {
      errors.push(`正規表現は ${LIMITS.maxPatternLength} 文字までにしてください (今は ${pattern.length} 文字です)`);
    } else {
      const alts = parseOrNull(pattern);
      // 本文の形に直すと変わる文字があると、その部分は本文に決して当たらない。黙って効かないルールにしない
      if (alts === null ? toEngineForm(pattern) !== pattern : hasDeadChars(alts)) errors.push(NFKC_MESSAGE);
      let re = null;
      try { re = new RegExp(pattern, ignoreCase === true ? "giu" : "gu"); } catch (_) {
        errors.push("正規表現として正しくありません。括弧や [ ] の閉じ忘れ、不要な \\ (バックスラッシュ) がないか確かめてください");
      }
      if (re) {
        // 見本の文での試しに加えて、構文の上でも見る: 先読み・後読みだけ、後ろが省けるものは、文脈があるときだけ空に当たる
        if (matchesEmpty(re) || (alts !== null && alts.some(seqNullable))) errors.push(EMPTY_MESSAGE);
        if (alts !== null && hasDeadDash(alts)) errors.push(DASH_MESSAGE);
        if (isRiskyPattern(pattern)) errors.push("時間がかかりやすい形です。繰り返しの中の繰り返し ((a+)+ など) や、重なる選択肢の繰り返し ((a|aa)* など) は使えません");
      }
    }
    return { pattern, ignoreCase };
  }

  function checkWords(input, errors) {
    let match = input.match;
    if (match === undefined) match = "exact";
    else if (match !== "exact" && match !== "partial") errors.push("match は \"exact\" (完全一致) か \"partial\" (部分一致) にしてください");

    const words = [];
    if (!Array.isArray(input.words)) {
      errors.push("語の一覧 (words) を配列で入れてください");
    } else if (input.words.some((w) => typeof w !== "string")) {
      errors.push("語は文字列で書いてください");
    } else {
      // 前後の空白を取り、空の行と重複を除く。順番は最初に出てきた順。見えない文字だけの行も空として数える
      const seen = new Set();
      for (const raw of input.words) {
        const word = raw.trim();
        if (word === "" || normalizeWord(word) === "" || seen.has(word)) continue;
        seen.add(word);
        words.push(word);
      }
      if (words.length === 0) {
        errors.push("語を 1 つ以上入れてください");
      } else {
        if (words.length > LIMITS.maxWords) errors.push(`語は ${LIMITS.maxWords} 個までにしてください (今は ${words.length} 個です)`);
        // 長さは、入れたとおりと、NFKC に直したあと (「ﷺ」は 18 文字になる) の両方で見る
        const tooLong = words.find((w) => w.length > LIMITS.maxWordLength || normalizeWord(w).length > LIMITS.maxWordLength);
        if (tooLong !== undefined) errors.push(`1 語は ${LIMITS.maxWordLength} 文字までにしてください (長すぎる語があります: 「${tooLong.slice(0, 20)}…」)`);
      }
    }
    return { words, match };
  }

  /**
   * 1 件のルールを確かめ、整えた形で返す。入力は書き換えない。理由は全部集めて返す。
   * @returns {{ ok: true, rule: object } | { ok: false, errors: string[] }}
   */
  function validateRule(input) {
    if (!isPlainObject(input)) return { ok: false, errors: ["ルールはオブジェクト ({ \"kind\": …, … }) で書いてください"] };
    const errors = [];

    let id = input.id;
    if (id === undefined || id === null || id === "") id = newId();
    else if (typeof id !== "string") errors.push("id は文字列で書いてください");

    let label = input.label;
    if (label === undefined || label === null || label === "") label = DEFAULT_LABEL;
    else if (typeof label !== "string" || !LABEL_RE.test(label)) errors.push(LABEL_MESSAGE);
    else if (label.startsWith(RESERVED_LABEL_PREFIX)) errors.push(RESERVED_LABEL_MESSAGE);

    let enabled = input.enabled;
    if (enabled === undefined) enabled = true;
    else if (typeof enabled !== "boolean") errors.push("enabled は true か false で書いてください");

    const kind = input.kind;
    let body = {};
    if (kind === "regex") body = checkRegex(input, errors);
    else if (kind === "words") body = checkWords(input, errors);
    else errors.push("ルールの種類 (kind) は \"regex\" (正規表現) か \"words\" (単語リスト) にしてください");

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, rule: { id, label, kind, enabled, ...body } };
  }

  // ---- 見本の文字 ---------------------------------------------------------------------
  // 1 文字用の正規表現同士が、同じ文字に当たりうるかを見る (重なる選択肢、数字・ハイフン類の見分け) のと、
  // stressTest で試す文字を、文字の種類 (\p{Script=…} や [ก-๛] など) から選ぶのに使う。文字の種類ごとに 1 字ずつ
  const SAMPLES = [
    ...Array.from({ length: 95 }, (_, k) => String.fromCharCode(32 + k)), // 半角の英数字・記号
    "\t", "\n", "\r", fromCodes(0x00a0), fromCodes(0x2003), IDEOGRAPHIC_SPACE, // 空白の仲間
    "あ", "い", "ん", "ぁ", "ア", "イ", "ン", "ー", "漢", "字", "一", "龥", "々", "。", "、", "・", "（",
    "Ａ", "ａ", "０", "ｱ", "㈱", // 全角・半角のかな・英数字 (NFKC で形が変わる)
    "é", "ü", "ß", "α", "я", // ラテン拡張・ギリシャ・キリル
    "ա", "א", "ا", "ܐ", "ހ", // アルメニア・ヘブライ・アラビア・シリア・ターナ
    "क", "ক", "ਕ", "ક", "କ", "க", "క", "ಕ", "ക", "ක", // デーヴァナーガリー・ベンガル・グルムキー・グジャラーティー・オリヤー・タミル・テルグ・カンナダ・マラヤーラム・シンハラ
    "ก", "ກ", "ཀ", "က", "ა", "한", "አ", "ក", "ᠠ", "Ꭰ", "ㄅ", // タイ・ラオ・チベット・ミャンマー・ジョージア・ハングル・エチオピア・クメール・モンゴル・チェロキー・注音
    "٣", "३", "３", // アラビア・デーヴァナーガリー・全角の数字
    "—", "…", "“", "€", "©", "°", "→", "∑", "＋",
    "😀", "𠮷",
  ];

  // ---- isRiskyPattern: 時間を食いやすい形 -----------------------------------------------
  // 正規表現の元の文字列を小さな構文木にして調べる。文字列の見た目だけで数えると、エスケープした括弧
  // (\(…\)) や、文字クラスの中の + * を、グループや繰り返しと取り違えるため。
  //   項目     { node, min, max }   max が Infinity なら上限なしの繰り返し
  //   node     { t: "char", src, lit? }   1 文字に当たるもの (文字・\d・[A-Z]・. など)。src はその 1 文字だけの正規表現。
  //                                       lit は、普通に書いた 1 文字のとき、その文字
  //            { t: "zero" }        幅 0 のもの (^ $ \b \B)
  //            { t: "ref" }         後方参照 (中身は分からない)
  //            { t: "group", look, alts }   丸括弧。look は先読み・後読み。alts は選択肢ごとの項目の並び
  const ESCAPE_RE = /\\(?:[pP]\{[^}]*\}|u\{[^}]*\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|c[A-Za-z]|k<[^>]*>|[1-9][0-9]*|[^])/uy;
  const GROUP_HEAD_RE = /\?(?:(<?[=!])|<[^>]*>|[a-z]*(?:-[a-z]+)?:)/y;
  const QUANT_RE = /(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})\??/y;
  const escapeLiteral = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

  function parseSource(source) {
    let i = 0;
    const n = source.length;

    function parseAlts() {
      const alts = [[]];
      while (i < n && source[i] !== ")") {
        if (source[i] === "|") { i += 1; alts.push([]); continue; }
        const node = parseAtom();
        alts[alts.length - 1].push({ node, ...parseQuantifier() });
      }
      return alts;
    }
    function parseAtom() {
      const c = source[i];
      if (c === "(") return parseGroup();
      if (c === "[") return parseClass();
      if (c === "\\") return parseEscape();
      const cp = String.fromCodePoint(source.codePointAt(i));
      i += cp.length;
      if (c === "^" || c === "$") return { t: "zero" };
      if (c === ".") return { t: "char", src: "." };
      return { t: "char", src: escapeLiteral(cp), lit: cp };
    }
    function parseClass() {
      let j = i + 1;
      if (source[j] === "^") j += 1;
      while (j < n && source[j] !== "]") j += source[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, n);
      const src = source.slice(i, end);
      i = end;
      return { t: "char", src };
    }
    function parseEscape() {
      ESCAPE_RE.lastIndex = i;
      const m = ESCAPE_RE.exec(source);
      const text = m ? m[0] : "\\";
      i += text.length;
      const c = text[1];
      if (c === undefined) return { t: "char", src: "\\\\" };
      if (c === "b" || c === "B") return { t: "zero" };
      if ((c === "k" && text.length > 2) || (c >= "1" && c <= "9")) return { t: "ref" };
      // u か x と 16 進数で書いた 1 文字は、その文字として見る (本文の形に直すと変わる文字の検査のため)
      if (c === "u" || c === "x") {
        const codePoint = parseInt(text.slice(2).replace(/[{}]/g, ""), 16);
        if (codePoint <= 0x10ffff) return { t: "char", src: text, lit: String.fromCodePoint(codePoint) };
      }
      return { t: "char", src: text };
    }
    function parseGroup() {
      i += 1; // "("
      let look = false;
      if (source[i] === "?") {
        GROUP_HEAD_RE.lastIndex = i;
        const m = GROUP_HEAD_RE.exec(source);
        if (m) { i += m[0].length; look = m[1] !== undefined; } else i += 1;
      }
      const alts = parseAlts();
      if (source[i] === ")") i += 1;
      return { t: "group", look, alts };
    }
    function parseQuantifier() {
      QUANT_RE.lastIndex = i;
      const m = QUANT_RE.exec(source);
      if (!m) return { min: 1, max: 1 };
      i += m[0].length;
      if (m[1] === "*") return { min: 0, max: Infinity };
      if (m[1] === "+") return { min: 1, max: Infinity };
      if (m[1] === "?") return { min: 0, max: 1 };
      const min = Number(m[2]);
      return { min, max: m[3] === undefined ? min : m[4] === "" ? Infinity : Number(m[4]) };
    }

    // 閉じる括弧が余っている (正しくない) 元でも、止まらず最後まで読む
    let top = parseAlts();
    while (i < n) { i += 1; top = top.concat(parseAlts()); }
    return top;
  }

  // 回数が決まっていない繰り返し (* + {n,} {n,m})。? と {n} は数えない
  const isVariable = (item) => item.max > 1 && item.max > item.min;
  const isUnbounded = (item) => item.max === Infinity;
  // 選択肢の並びの中に (入れ子のグループの中も含めて) 条件に合う項目があるか
  const anyItem = (alts, pred) => alts.some((seq) => seq.some((it) => pred(it) || (it.node.t === "group" && anyItem(it.node.alts, pred))));

  // 空の文字に当たりうるか
  const seqNullable = (seq) => seq.every((it) => it.min === 0 || nodeNullable(it.node));
  function nodeNullable(node) {
    if (node.t === "char") return false;
    if (node.t === "group" && !node.look) return node.alts.some(seqNullable);
    return true; // 幅 0 のもの・後方参照・先読み
  }

  // 選択肢の「最初の 1 文字」になりうるもの (1 文字用の正規表現の元の一覧)。open は、分からない (何でもありうる)
  function firstOfSeq(seq) {
    const first = { srcs: [], open: false, nullable: true };
    for (const it of seq) {
      const f = firstOfNode(it.node);
      first.srcs.push(...f.srcs);
      first.open = first.open || f.open;
      if (!(it.min === 0 || f.nullable)) { first.nullable = false; break; }
    }
    return first;
  }
  function firstOfNode(node) {
    if (node.t === "char") return { srcs: [node.src], open: false, nullable: false };
    if (node.t === "ref") return { srcs: [], open: true, nullable: true };
    if (node.t === "group" && !node.look) {
      const parts = node.alts.map(firstOfSeq);
      return { srcs: parts.flatMap((p) => p.srcs), open: parts.some((p) => p.open), nullable: parts.some((p) => p.nullable) };
    }
    return { srcs: [], open: false, nullable: true };
  }

  // 2 つの「1 文字用の正規表現」が、同じ文字に当たりうるか。見本の文字で確かめる (大文字小文字は区別しない側に倒す)。
  // 見本は、決まった一覧と、パターンに書かれた文字 (範囲の端など)
  function makeSharer(source) {
    const samples = [...new Set([...SAMPLES, ...source])];
    const cache = new Map();
    const hitsOf = (src) => {
      if (!cache.has(src)) {
        let hits = null;
        try {
          const re = new RegExp(`^(?:${src})$`, "iu");
          hits = new Set();
          samples.forEach((c, k) => { if (re.test(c)) hits.add(k); });
        } catch (_) { hits = null; }
        cache.set(src, hits);
      }
      return cache.get(src);
    };
    return (a, b) => {
      if (a === b) return true;
      const ha = hitsOf(a);
      const hb = hitsOf(b);
      if (!ha || !hb) return true; // 読めないものは、重なるとみなす
      for (const k of ha) if (hb.has(k)) return true;
      return false;
    };
  }
  function altsOverlap(alts, shares) {
    if (alts.length < 2) return false;
    const firsts = alts.map(firstOfSeq);
    for (let a = 0; a < firsts.length; a++) {
      for (let b = a + 1; b < firsts.length; b++) {
        const A = firsts[a];
        const B = firsts[b];
        if (A.open || B.open) return true;
        if (A.srcs.some((x) => B.srcs.some((y) => shares(x, y)))) return true;
      }
    }
    return false;
  }
  const overlapDeep = (alts, shares) => altsOverlap(alts, shares)
    || alts.some((seq) => seq.some((it) => it.node.t === "group" && overlapDeep(it.node.alts, shares)));

  function hasRiskyGroup(alts, shares) {
    return alts.some((seq) => seq.some((it) => {
      if (it.node.t !== "group") return false;
      const body = it.node.alts;
      // 上限のない繰り返しの中に、回数の決まらない繰り返し・空の文字に当たる並び・重なる選択肢がある
      if (it.max === Infinity && (anyItem(body, isVariable) || body.some(seqNullable) || overlapDeep(body, shares))) return true;
      // 2 回以上の決まった回数の繰り返しの中に、上限のない繰り返しがある ((.*a){20} など)
      if (it.max >= 2 && it.max !== Infinity && anyItem(body, isUnbounded)) return true;
      return hasRiskyGroup(body, shares);
    }));
  }

  /**
   * 時間を食いやすい形 (正規表現の入れ子の繰り返し、重なる選択肢の繰り返し) か。
   * 見分けは安全側に倒してある: 区切りの文字で分かれていて実際は速い形 (\d+(\.\d+)* や (\d+\.){3}\d+ など) も
   * true になる。回数が決まった繰り返しは、中に上限のない繰り返しがあるときだけ ((.*a){20} など) true にする。
   * 同じ文字の長い列で 3 乗の時間がかかるような、入れ子の無い形は、ここでは見分けず stressTest で測る。
   */
  function isRiskyPattern(source) {
    if (typeof source !== "string") return false;
    try {
      return hasRiskyGroup(parseSource(source), makeSharer(source));
    } catch (_) {
      return true; // 読み解けないものは、安全とは言えない
    }
  }

  // ---- 本文の形に直すと変わる文字 ---------------------------------------------------------
  // 全角の英数字・半角のカナ・㈱・見えない文字などは、本文では別の文字に直されているので、正規表現に書いても当たらない。
  // 分解された形 (「テ」+ 濁点、「e」+ アクセント) も、本文では 1 文字 (「デ」「é」) にまとめられるので、当たらない。
  // 1 文字ずつ見ると、単独では変わらない結合文字が通ってしまうので、続いた普通の文字をまとめて、NFKC と比べる。
  // 結合文字が、グループやクラスの直後など、まとめる相手が無い所にあるときも見つける (どの文字ともまとまらない結合文字は、差し支えない)。
  // 文字クラスの中は、変わる文字の直した形 (: など) がそのクラスにも入っていれば、差し支えない
  // ([:：] の ： は、本文では : になり、: が入っている)。[Ａ-Ｚ] のように、直した形が入らないクラスは見つける
  function classHasDeadMember(src) {
    const re = matcherOf(src);
    for (const c of src) {
      const n = toEngineForm(c);
      if (n !== c && !(re !== null && re.test(n))) return true;
    }
    return false;
  }
  const isMark = (c) => /^\p{M}$/u.test(c);
  // 結合文字が、直前のどれかの文字とまとまって別の 1 文字になるか (濁点・アクセントなどは true、タイ文字の母音記号などは false)
  const composeCache = new Map();
  function composesWithBase(mark) {
    if (!composeCache.has(mark)) {
      let found = false;
      for (let cp = 0x20; cp <= 0x30ff && !found; cp++) {
        const base = String.fromCodePoint(cp);
        found = (base + mark).normalize("NFC") !== base.normalize("NFC") + mark;
      }
      composeCache.set(mark, found);
    }
    return composeCache.get(mark);
  }
  // 回数の指定が無い、普通に書いた 1 文字
  const isPlainLiteral = (it) => it.node.t === "char" && it.node.lit !== undefined && it.min === 1 && it.max === 1;
  function seqHasDeadChars(seq) {
    let run = ""; // 続いた普通の文字
    const runIsDead = () => run !== "" && toEngineForm(run) !== run;
    for (const it of seq) {
      const n = it.node;
      if (isPlainLiteral(it)) {
        if (run === "" && isMark(n.lit) && composesWithBase(n.lit)) return true; // まとめる相手が無い結合文字
        run += n.lit;
        continue;
      }
      if (runIsDead()) return true;
      run = "";
      if (n.t === "group") {
        if (n.alts.some(seqHasDeadChars)) return true;
      } else if (n.t === "char") {
        if (n.lit !== undefined) {
          if (toEngineForm(n.lit) !== n.lit || (isMark(n.lit) && composesWithBase(n.lit))) return true;
        } else if (n.src[0] === "[" ? classHasDeadMember(n.src) : toEngineForm(n.src) !== n.src) {
          return true;
        }
      }
    }
    return runIsDead();
  }
  const hasDeadChars = (alts) => alts.some(seqHasDeadChars);

  // ---- 数字に挟まれたハイフン類 ---------------------------------------------------------
  // 数字と数字に挟まれたハイフン類 (ー ‐ ― − など) は、本文では - に直されている。正規表現に書くと、その形には決して当たらない。
  // 「ハイフン類の項目」は、ハイフン類のどれかに当たり、- には当たらない 1 文字の項目 (そのままの ー や [ーa])。
  // - にも当たる項目 ([ー-] など) は、- に直された本文にも当たるので、通す。
  // 前に来うる項目と後ろに来うる項目の、どちらにも、数字に当たりうるもの (\d ・ [0-9A-Z] ・ \w ・ . など) があれば、断る。
  // 必ず数字のときだけではない。パターンの先頭と末尾 (先読み・後読みの中の先頭と末尾も) は、前後に何が来るか分からないので、
  // 数字でありうるとする。先読み・後読みで隣が数字でないと言えても、通さない。後方参照は、何にでも当たりうる。
  // 前後に来うる項目は、正規表現の Glushkov 構成と同じ考え方で、最初・最後・次に来る項目の集まりを求めて、
  // 省ける項目・グループの境目・繰り返しの継ぎ目 (最後の項目のあとに、最初の項目が来る) をまたいで見る
  const matcherOf = (src) => {
    try { return new RegExp(`^(?:${src})$`, "u"); } catch (_) { return null; }
  };
  const ASCII_DIGITS = [..."0123456789"];

  function neighbourGraph(alts) {
    const atoms = []; // 文字の項目と後方参照 (出てきた順)。{ src } か { any: true }
    const follow = []; // follow[p] = p の直後に来うる項目の番号の集まり
    const starts = new Set(); // 前に何が来るか分からない項目 (パターンと、先読み・後読みの中の、最初になりうる項目)
    const ends = new Set(); // 後ろに何が来るか分からない項目
    const link = (froms, tos) => froms.forEach((p) => tos.forEach((q) => follow[p].add(q)));
    const union = (...sets) => new Set(sets.flatMap((s) => [...s]));

    function item(it) {
      const node = it.node;
      let r;
      if (node.t === "char" || node.t === "ref") {
        atoms.push(node.t === "ref" ? { any: true } : { src: node.src });
        follow.push(new Set());
        const p = atoms.length - 1;
        r = { first: new Set([p]), last: new Set([p]), nullable: false };
      } else if (node.t === "group" && !node.look) {
        r = alternatives(node.alts);
      } else {
        if (node.t === "group") standalone(node.alts); // 先読み・後読みの中は、前後が分からない別のパターンとして見る
        r = { first: new Set(), last: new Set(), nullable: true }; // 幅 0 のもの・先読み・後読みは、素通しにする
      }
      if (it.max >= 2) link(r.last, r.first); // 繰り返しの継ぎ目
      if (it.min === 0) r.nullable = true;
      return r;
    }
    function sequence(items) {
      let first = new Set();
      let last = new Set();
      let nullable = true;
      for (const it of items) {
        const x = item(it);
        link(last, x.first);
        if (nullable) first = union(first, x.first);
        last = x.nullable ? union(last, x.last) : x.last;
        nullable = nullable && x.nullable;
      }
      return { first, last, nullable };
    }
    function alternatives(list) {
      const parts = list.map(sequence);
      return { first: union(...parts.map((p) => p.first)), last: union(...parts.map((p) => p.last)), nullable: parts.some((p) => p.nullable) };
    }
    function standalone(list) {
      const r = alternatives(list);
      r.first.forEach((p) => starts.add(p));
      r.last.forEach((p) => ends.add(p));
    }
    standalone(alts);
    return { atoms, follow, starts, ends };
  }

  function hasDeadDash(alts) {
    const { atoms, follow, starts, ends } = neighbourGraph(alts);
    const kinds = new Map();
    const kindOf = (atom) => {
      if (atom.any) return { digit: true, dash: false };
      if (!kinds.has(atom.src)) {
        const re = matcherOf(atom.src);
        kinds.set(atom.src, re === null
          ? { digit: false, dash: false }
          : { digit: ASCII_DIGITS.some((c) => re.test(c)), dash: [...DASHES].some((c) => re.test(c)) && !re.test("-") });
      }
      return kinds.get(atom.src);
    };
    const before = atoms.map(() => []); // before[p] = p の直前に来うる項目の番号
    follow.forEach((set, p) => set.forEach((q) => before[q].push(p)));
    return atoms.some((atom, p) => {
      if (!kindOf(atom).dash) return false;
      const left = starts.has(p) || before[p].some((q) => kindOf(atoms[q]).digit);
      const right = ends.has(p) || [...follow[p]].some((q) => kindOf(atoms[q]).digit);
      return left && right;
    });
  }

  // ---- stressTest -------------------------------------------------------------------
  // 同じ文字の長い列のあとに当たらない文字を 1 つ置いた文に当て、所要時間を測って、1 本のルールぶんを合計する。
  // 短い列から順に試し、合計が上限を超えたらそこで止める。入れ子や重なりをすり抜けた遅い形 (3 乗の形は、同じ文字
  // 950 字で 0.5 秒から 20 秒かかり、2000 字ではさらに伸びる) でも、長い列で固まる前に止まるように、段は 2.5 倍ほどの
  // 刻みにする。前の段を上限ぎりぎりで通った 3 乗の形でも、次の段で固まるのは 1 秒ほどに収まる。
  // 最後の段を 950 字にとどめるのは、ふつうの 2 乗の形 (\S+@\S+ など) を、合計の上限に余裕を持って通すため
  const STRESS_LENGTHS = [24, 60, 150, 380, 950];
  const STRESS_CHARS = ["a", "A", "1", " ", "あ", "ア", "漢", "-"];
  const STRESS_TAILS = ["!", "\n"]; // \w 系を止める ! と、. 系を止める改行
  const MAX_PROBE_ATOMS = 200; // 試す文字を選ぶのに見る、パターンの文字の項目の数
  const MAX_PROBE_LITERALS = 4; // 試す文字に足す、普通に書いた文字の数

  function nowMs() {
    return typeof performance !== "undefined" && performance && typeof performance.now === "function" ? performance.now() : Date.now();
  }
  // 試す文字を選ぶ。パターンが使う文字を、数種だけ足す: 普通に書いた文字 (文字・数字・かな・漢字。区切りの記号は除く) は
  // そのまま、文字の種類 (\d ・ [A-Z] ・ \p{Script=Hangul} など) は、見本から当たる文字を 1 つ選ぶ。
  // そのうえで、パターンの文字の項目のどれに当たるかが同じ文字は、同じ動きをするので、1 つだけ試す。
  // (広い文字の種類に当たる文字を何本も別々に試して足すと、ふつうの 2 乗の形が、合計で上限を超えてしまう)
  function probeChars(source, ignoreCase) {
    const nodes = [];
    const collect = (alts) => alts.forEach((seq) => seq.forEach((it) => {
      if (it.node.t === "group") collect(it.node.alts);
      else if (it.node.t === "char" && nodes.length < MAX_PROBE_ATOMS) nodes.push(it.node);
    }));
    try {
      collect(parseSource(source.slice(0, 3000))); // 語の一覧から作った長いものは、先頭だけで足りる
    } catch (_) { /* 読めない形は、決まった文字だけで試す */ }

    const flags = ignoreCase ? "iu" : "u";
    const srcs = [...new Set(nodes.map((n) => n.src))];
    const matchers = srcs.map((src) => { try { return new RegExp(`^(?:${src})$`, flags); } catch (_) { return null; } });
    const pick = (src) => {
      const re = matcherOf(src);
      return re === null ? undefined : SAMPLES.find((c) => re.test(c));
    };
    // 普通に書いた文字は、文字・数字・かな・漢字だけ、最初の数種。同じ広い文字の種類に当たる文字を、いくつも別々に試さない
    const literals = new Set();
    const derived = nodes.map((n) => {
      if (n.lit === undefined) return pick(n.src);
      if (literals.size < MAX_PROBE_LITERALS && /^[\p{L}\p{N}]$/u.test(n.lit)) literals.add(n.lit);
      return literals.has(n.lit) ? n.lit : undefined;
    });
    const usesBoundary = /\\[bB]/.test(source);

    const found = [];
    const seenKinds = new Set();
    for (const c of [...derived, ...STRESS_CHARS]) {
      if (c === undefined) continue;
      const kind = matchers.map((re, k) => (re !== null && re.test(c) ? k : -1)).filter((k) => k >= 0).join(",")
        + (usesBoundary ? (/^\w$/.test(c) ? "|w" : "|n") : ""); // \b は、単語を作る文字かどうかで動きが変わる
      if (!seenKinds.has(kind)) { seenKinds.add(kind); found.push(c); }
    }
    return found;
  }
  function timeScan(re, text, clock) {
    re.lastIndex = 0;
    const start = clock();
    try {
      let m;
      while ((m = re.exec(text)) !== null) if (m.index === re.lastIndex) re.lastIndex += 1; // エンジンと同じ回し方
    } catch (_) {
      return Infinity; // 照合の途中で失敗する形 (スタックの不足など) は通さない
    }
    return clock() - start;
  }

  /**
   * @param {RegExp} re 渡した正規表現は書き換えない
   * @param {number} [budgetMs] 1 本のルールの試し全部の合計に許す時間。既定は LIMITS.stressMs
   * @param {() => number} [clock] ミリ秒の時計。既定は performance.now
   * @returns {{ ok: boolean, ms: number }} ms は、試しの時間の合計 (上限を超えて止めたときは、そこまでの合計)
   */
  function stressTest(re, budgetMs = LIMITS.stressMs, clock = nowMs) {
    const probe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const chars = probeChars(re.source, re.flags.includes("i"));
    let total = 0;
    for (const length of STRESS_LENGTHS) {
      for (const ch of chars) {
        for (const tail of STRESS_TAILS) {
          total += timeScan(probe, ch.repeat(length) + tail, clock);
          if (total > budgetMs) return { ok: false, ms: total };
        }
      }
    }
    return { ok: true, ms: total };
  }

  // ---- 組み立て -----------------------------------------------------------------------
  // 完全一致の文字の種類 (英数字・ひらがな・カタカナ (ー を含む)・漢字 (々 を含む))。
  // 語の端の文字と同じ種類の文字が隣にあれば、続きとみなして当てない。それ以外 (種類の切り替わり・記号・空白・文の端) は当てる
  const CHAR_KINDS = ["[A-Za-z0-9]", "\\p{Script=Hiragana}", "[\\p{Script=Katakana}ー]", "[\\p{Script=Han}々]"]
    .map((src) => ({ src, re: new RegExp(`^${src}$`, "u") }));
  const kindOf = (ch) => (CHAR_KINDS.find((k) => k.re.test(ch)) || {}).src || null;

  // 語を、長い順に並べて 1 本の正規表現にする (選択肢は先に書いたものが取られるので、短い語が長い語を食わないように)。
  // 完全一致は、先頭の文字の種類ごとにまとめて (?<!X)(?:語 1(?!Y1)|語 2(?!Y2)|…) の形にする。
  // 同じ位置で当たりうる語は、先頭の文字が同じ = 種類も同じなので、同じ組に入る。語ごとに後読みを置くのと当たる所は
  // 変わらないが、500 語 × 100 字のリストで、後読みを語の数だけ試さずに済む (長い本文で 10 倍ほど速い)。
  // 先頭が記号など、どの種類でもない語は、後読みの無い組にまとめる
  function wordsPattern(rule) {
    const unique = new Set();
    for (const w of rule.words) {
      const n = normalizeWord(w);
      if (n !== "") unique.add(n);
    }
    const sorted = [...unique].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    if (rule.match !== "exact") return new RegExp(sorted.map(escapeLiteral).join("|"), "gu");
    const groups = new Map(); // 先頭の文字の種類 (後読みの中身。どれでもなければ "") → その種類で始まる語の選択肢
    for (const w of sorted) {
      const chars = Array.from(w);
      const before = kindOf(chars[0]) || "";
      const after = kindOf(chars[chars.length - 1]);
      if (!groups.has(before)) groups.set(before, []);
      groups.get(before).push(escapeLiteral(w) + (after ? `(?!${after})` : ""));
    }
    const source = [...groups].map(([before, alts]) => (before ? `(?<!${before})` : "") + `(?:${alts.join("|")})`).join("|");
    return new RegExp(source, "gu");
  }

  // 確かめ済みのルールから、エンジンが当てる正規表現を作る。g と u は必須 (エンジンは g で回す)
  function buildPattern(rule) {
    try {
      return rule.kind === "regex" ? new RegExp(rule.pattern, rule.ignoreCase ? "giu" : "gu") : wordsPattern(rule);
    } catch (_) {
      return null;
    }
  }

  /**
   * 1 件を組み立てる。正しくないときは null。enabled は見ない (設定画面が、保存の前に試すため)。
   * @returns {{ entity_type: string, category: string, pattern: RegExp, ruleId: string } | null}
   */
  function compileRule(rule) {
    const checked = validateRule(rule);
    if (!checked.ok) return null;
    const pattern = buildPattern(checked.rule);
    if (!pattern) return null;
    // 名前が、検出の種類と分類になる (止めた分類・サイト別の外す種類で、ルールごとに外せる)
    return { entity_type: checked.rule.label, category: checked.rule.label, pattern, ruleId: checked.rule.id };
  }

  /** 有効で正しいものだけを、先頭から LIMITS.maxRules 個まで組み立てる。 */
  function compileRules(rules) {
    const out = [];
    if (!Array.isArray(rules)) return out;
    for (const rule of rules) {
      if (out.length >= LIMITS.maxRules) break;
      if (!isPlainObject(rule) || rule.enabled === false) continue;
      const compiled = compileRule(rule);
      if (compiled) out.push(compiled);
    }
    return out;
  }

  // ---- 書き出しと読み込み -----------------------------------------------------------------
  // 書き出すのは決まった項目だけ。確かめずにそのまま書く (保存の中身を、1 つも落とさずに控えにするため)
  function projectRule(r) {
    const base = { id: r.id, label: r.label, kind: r.kind, enabled: r.enabled };
    return r.kind === "words" ? { ...base, words: r.words, match: r.match } : { ...base, pattern: r.pattern, ignoreCase: r.ignoreCase };
  }

  /** @returns {string} { "format": "pii-guard-custom-rules", "version": 1, "rules": [ … ] } の JSON */
  function exportRules(rules) {
    const list = Array.isArray(rules) ? rules.filter(isPlainObject).map(projectRule) : [];
    return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, rules: list }, null, 2);
  }

  // 「中身がまったく同じ」の見分け方。id と enabled (オン/オフ) は中身に数えない。
  // 書き出したファイルをもう一度読んでも、切り替えただけのルールが 2 つに増えないように
  function contentKey(r) {
    return JSON.stringify(r.kind === "words"
      ? ["words", r.label, r.match, Array.isArray(r.words) ? [...r.words].sort() : []]
      : ["regex", r.label, r.pattern, r.ignoreCase === true]);
  }

  /**
   * 足すだけの読み込み。今のルールは 1 つも変えない。1 件ずつ、保存のときと同じ確かめ
   * (validateRule と stressTest) をする。通らないものは理由を付けて rejected に入れる。
   * ファイル全体が読めないときは、index が -1 の 1 件で理由を返す。
   * @param {string} jsonText
   * @param {object[]} existing 今のルール
   * @param {{ clock?: () => number }} [options] stressTest に渡す時計 (テスト用。既定は performance.now)
   * @returns {{ rules: object[], added: number, duplicates: number, rejected: Array<{ index: number, errors: string[] }> }}
   */
  function importRules(jsonText, existing, options) {
    const opts = isPlainObject(options) ? options : {};
    const current = Array.isArray(existing) ? existing : [];
    const result = { rules: current.slice(), added: 0, duplicates: 0, rejected: [] };
    const failFile = (message) => { result.rejected.push({ index: -1, errors: [message] }); return result; };

    let data;
    try { data = JSON.parse(jsonText); } catch (_) {
      return failFile("JSON として読めません。書き出したファイルを、そのまま選んでください");
    }
    if (!isPlainObject(data) || data.format !== EXPORT_FORMAT) {
      return failFile(`PII Guard のカスタムルールのファイルではありません (format が "${EXPORT_FORMAT}" ではありません)`);
    }
    if (data.version !== EXPORT_VERSION) {
      const found = data.version === undefined ? "なし" : String(JSON.stringify(data.version)).slice(0, 20);
      return failFile(`このファイルの版 (version) は ${found} ですが、読めるのは version ${EXPORT_VERSION} だけです`);
    }
    if (!Array.isArray(data.rules)) return failFile("rules (ルールの一覧) が配列ではありません");

    const plain = result.rules.filter(isPlainObject);
    const ids = new Set(plain.map((r) => r.id));
    const keys = new Set(plain.map(contentKey));
    data.rules.forEach((raw, index) => {
      const reject = (...errors) => { result.rejected.push({ index, errors }); };
      const checked = validateRule(raw);
      if (!checked.ok) return reject(...checked.errors);
      const rule = checked.rule;
      const key = contentKey(rule);
      // 同じものは、数を数えるだけ。上限の数にも入れない
      if (keys.has(key)) { result.duplicates += 1; return undefined; }
      if (result.rules.length >= LIMITS.maxRules) return reject(`ルールは ${LIMITS.maxRules} 個までです。これ以上は足せません`);
      const pattern = buildPattern(rule);
      if (!pattern) return reject("正規表現を組み立てられません。語や正規表現を短くしてください");
      if (!stressTest(pattern, LIMITS.stressMs, opts.clock).ok) return reject(`照合に時間がかかりすぎます (上限 ${LIMITS.stressMs} ミリ秒を超えました)。パターンを単純にしてください`);
      if (ids.has(rule.id)) rule.id = newId(); // id が同じで中身が違うものは、別のルールとして id を作り直す
      ids.add(rule.id);
      keys.add(key);
      result.rules.push(rule);
      result.added += 1;
      return undefined;
    });
    return result;
  }

  const api = {
    LIMITS, LABEL_RE, DEFAULT_LABEL, STORAGE_KEY, EXPORT_FORMAT, EXPORT_VERSION,
    validateRule, isRiskyPattern, stressTest, compileRule, compileRules, exportRules, importRules,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { customRules: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
