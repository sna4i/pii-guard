// engine/custom-rules.js — Pro 版のカスタムルール (Pro Phase 2 の設計 (P1)、T-CR-01〜13)
//
// 利用者が足す「正規表現」と「単語リスト」のルールを、確かめ、エンジンが当てられる形に組み立てる。
// 純粋な関数だけの部品 (node のテストからも、設定画面からも、エンジンからも読む)。
//   validateRule    1 件のルールを確かめる。保存と読み込みで同じ決まりを使う。理由は日本語
//   isRiskyPattern  時間を食いやすい形か (繰り返しの中の繰り返し、重なる選択肢の繰り返し)
//   stressTest      長い意地悪な文に当てて、1 回の照合が上限を超えないか測る
//   compileRule(s)  pro-rules.js と同じ { entity_type, pattern } に、止める単位 category を足した形に組み立てる
//   exportRules / importRules  JSON の書き出しと読み込み
//
// 正規表現の 1 回の照合は、途中で止められない。だから、送る前の時間の上限 (エンジンが見る) だけでは
// 固まるのを防げない。保存と読み込みのときの 2 つの確かめ (isRiskyPattern と stressTest) で、
// 遅い形をそもそもルールに入れない。
//
// 照合は NFKC に直した文に対して行う (engine/engine.js の matchPatterns)。語も同じ形に直して組み立てる。
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
  // 本文は NFKC (全角の英数字・半角のカタカナなど) に直され、見えない文字 (ソフトハイフン・ゼロ幅スペースなど・
  // 単語結合子・BOM。Web や PDF からの貼り付けで紛れ込む) は落とされてから照合される。
  // 語は、この形に直して組み立てる。正規表現の元は、記号の意味が変わるので直せない (保存のときに断る)
  const INVISIBLE_RE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;
  const toEngineForm = (s) => s.normalize("NFKC").replace(INVISIBLE_RE, "");
  const normalizeWord = (word) => toEngineForm(word).trim();

  // ---- 検査 ---------------------------------------------------------------------------
  const LABEL_MESSAGE = "伏せ字の名前は英大文字で始め、英大文字・数字・_ だけで 32 文字までにしてください";
  const NFKC_MESSAGE = "本文は NFKC (全角の英数字を半角に直すなど) で整えてから照合するため、全角の英数字・記号、半角のカナ、㈱、見えない文字は、正規表現に入れても当たりません。整えたあとの形で書いてください (ＡＣＭＥ は ACME、㈱ は \\(株\\))";
  // 空の文字に当たるかを調べる短い文。幅 0 で当たるもの (\b ・ ^ ・ 先読み) も、どれかで長さ 0 の当たりになる
  const EMPTY_SAMPLES = ["", "a", "A", "0", " ", "-", "_", "\n", "あ", "ア", "漢", "aA0 -_\nあア漢"];

  function matchesEmpty(re) {
    for (const sample of EMPTY_SAMPLES) {
      for (const m of sample.matchAll(re)) if (m[0] === "") return true;
    }
    return false;
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
      // 本文の形に直すと変わる文字があると、その部分は本文に決して当たらない。黙って効かないルールにしない
      if (toEngineForm(pattern) !== pattern) errors.push(NFKC_MESSAGE);
      let re = null;
      try { re = new RegExp(pattern, ignoreCase === true ? "giu" : "gu"); } catch (_) {
        errors.push("正規表現として正しくありません。括弧や [ ] の閉じ忘れ、不要な \\ (バックスラッシュ) がないか確かめてください");
      }
      if (re) {
        if (matchesEmpty(re)) errors.push("空の文字にも当たる形は使えません (x* ・ \\b ・ ^ など)。何かの文字に必ず当たる形にしてください");
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

  // ---- isRiskyPattern: 時間を食いやすい形 -----------------------------------------------
  // 正規表現の元の文字列を小さな構文木にして調べる。文字列の見た目だけで数えると、エスケープした括弧
  // (\(…\)) や、文字クラスの中の + * を、グループや繰り返しと取り違えるため。
  //   項目     { node, min, max }   max が Infinity なら上限なしの繰り返し
  //   node     { t: "char", src }   1 文字に当たるもの (文字・\d・[A-Z]・. など)。src はその 1 文字だけの正規表現
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
      return { t: "char", src: escapeLiteral(cp) };
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

  // 2 つの「1 文字用の正規表現」が、同じ文字に当たりうるか。見本の文字で確かめる (大文字小文字は区別しない側に倒す)
  const SAMPLE_BASE = [..."\t\n\r", ...Array.from({ length: 95 }, (_, k) => String.fromCharCode(32 + k)),
    "あ", "い", "ん", "ぁ", "ア", "イ", "ン", "ー", "漢", "字", "一", "龥", "々", "é", "ü", "α", "я", "한", "。", "、", "\u3000"];
  function makeSharer(source) {
    const samples = [...new Set([...SAMPLE_BASE, ...source])];
    const compiled = new Map();
    const matcher = (src) => {
      if (!compiled.has(src)) {
        try { compiled.set(src, new RegExp(`^(?:${src})$`, "iu")); } catch (_) { compiled.set(src, null); }
      }
      return compiled.get(src);
    };
    return (a, b) => {
      if (a === b) return true;
      const ra = matcher(a);
      const rb = matcher(b);
      if (!ra || !rb) return true; // 読めないものは、重なるとみなす
      return samples.some((c) => ra.test(c) && rb.test(c));
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

  // ---- stressTest -------------------------------------------------------------------
  // 同じ文字の長い列のあとに当たらない文字を 1 つ置いた文に当て、1 本ごとの所要時間を測る。
  // 短い列から順に試し、上限を超えたらそこで止める。入れ子や重なりをすり抜けた遅い形 (3 乗の形は、同じ文字
  // 2000 字で 1 秒弱から数十秒以上かかり、5000 字ではさらに伸びる) でも、長い列で固まる前に止まるように、
  // 段は 2.5 倍ほどの刻みにする。前の段を上限ぎりぎりで通った 3 乗の形でも、次の段で固まるのは 1 秒ほどに収まる。
  const STRESS_LENGTHS = [24, 60, 150, 380, 950, 2000];
  const STRESS_CHARS = ["a", "A", "1", " ", "あ", "ア", "漢", "-"];
  const STRESS_TAILS = ["!", "\n"]; // \w 系を止める ! と、. 系を止める改行

  function nowMs() {
    return typeof performance !== "undefined" && performance && typeof performance.now === "function" ? performance.now() : Date.now();
  }
  // パターンの中に書かれた文字 (エスケープ・\p{…} は除く)。数種だけ、試す文字に足す
  function literalChars(source) {
    const bare = source.replace(/\\(?:[pP]\{[^}]*\}|u\{[^}]*\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|c[A-Za-z]|k<[^>]*>|[^])/gu, "");
    return [...new Set(bare.match(/[\p{L}\p{N}]/gu) || [])].slice(0, 4);
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
   * @param {number} [budgetMs] 1 本の試しに許す時間。既定は LIMITS.stressMs
   * @param {() => number} [clock] ミリ秒の時計。既定は performance.now
   * @returns {{ ok: boolean, ms: number }} ms は、いちばん遅かった 1 本の時間
   */
  function stressTest(re, budgetMs = LIMITS.stressMs, clock = nowMs) {
    const probe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const chars = [...new Set([...STRESS_CHARS, ...literalChars(re.source)])];
    let worst = 0;
    for (const length of STRESS_LENGTHS) {
      for (const ch of chars) {
        for (const tail of STRESS_TAILS) {
          const ms = timeScan(probe, ch.repeat(length) + tail, clock);
          if (ms > worst) worst = ms;
          if (worst > budgetMs) return { ok: false, ms: worst };
        }
      }
    }
    return { ok: true, ms: worst };
  }

  // ---- 組み立て -----------------------------------------------------------------------
  // 完全一致の文字の種類 (英数字・ひらがな・カタカナ (ー を含む)・漢字 (々 を含む))。
  // 語の端の文字と同じ種類の文字が隣にあれば、続きとみなして当てない。それ以外 (種類の切り替わり・記号・空白・文の端) は当てる
  const CHAR_KINDS = ["[A-Za-z0-9]", "\\p{Script=Hiragana}", "[\\p{Script=Katakana}ー]", "[\\p{Script=Han}々]"]
    .map((src) => ({ src, re: new RegExp(`^${src}$`, "u") }));
  const kindOf = (ch) => (CHAR_KINDS.find((k) => k.re.test(ch)) || {}).src || null;

  function wordAlternative(word, exact) {
    const body = escapeLiteral(word);
    if (!exact) return body;
    const chars = Array.from(word);
    const before = kindOf(chars[0]);
    const after = kindOf(chars[chars.length - 1]);
    return (before ? `(?<!${before})` : "") + body + (after ? `(?!${after})` : "");
  }

  // 長い語から先に並べる (選択肢は先に書いたものが取られるので、短い語が長い語を食わないように)
  function wordsPattern(rule) {
    const unique = new Set();
    for (const w of rule.words) {
      const n = normalizeWord(w);
      if (n !== "") unique.add(n);
    }
    const sorted = [...unique].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    return new RegExp(sorted.map((w) => wordAlternative(w, rule.match === "exact")).join("|"), "gu");
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
