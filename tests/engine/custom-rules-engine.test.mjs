// tests/engine/custom-rules-engine.test.mjs — エンジンが、Pro のときだけカスタムルールを当てる (Pro Phase 2 の設計 (P1)、T-CR-21〜30・52)
//
// カスタムルールは setCustomRules で 1 回だけ組み立てて持ち (engine/custom-rules.js の compileRules)、送るたびには組み立てない。
// Pro でないか、ルールが 0 個なら、足した処理を通らず、結果は今と同じ (custom.status は off)。
// 当てるときは、今の検出に足してから重なりを解くので、伏せ字の番号と重なりの決まりは今の検出と同じ。
// 時間はルールとルールのあいだで見て、上限に届いたら残りを当てずに custom.status を partial にする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = "../../browser-extension/engine/";
for (const m of ["dictionaries", "patterns", "classification", "severity", "categories", "aggregate", "force-mask", "blocklist", "user-force-mask", "confidential"]) require(E + m + ".js");
const engine = require(E + "engine.js");

const RULES = [{ id: "r1", label: "PROJECT", kind: "words", words: ["アルファ計画"], match: "exact", enabled: true },
               { id: "r2", label: "ACME_ID", kind: "regex", pattern: "ACME-\\d{4}", enabled: true }];
const TEXT = "アルファ計画は ACME-1234 で管理しています。連絡先は 090-1234-5678";
const MASKED = "<PROJECT_1>は <ACME_ID_1> で管理しています。連絡先は <PHONE_NUMBER_1>";

// テストの中だけルールを持たせる。終わったら外して、Pro をオフに戻す (await してから片付ける)
async function withRules(rules, fn) {
  engine.setCustomRules(rules);
  try { return await fn(); } finally {
    engine.setCustomRules([]);
    engine.setProEnabled(false);
  }
}
// 偽の時計。1 回目の呼び出しは 0、そのあとは呼ぶたびに step 進む
function stepClock(step) {
  let now = -step;
  return () => (now += step);
}
const sanitize = async (text, opts) => (await engine.maskSanitize(text, opts || {})).sanitized_text;

test("T-CR-21 Pro でないとき: ルールを持っていても当てず、custom.status は off。伏せた文は今と同じ", async () => {
  const before = await engine.maskSanitize(TEXT, {});
  const beforeAgg = await engine.maskAggregated(TEXT, {});
  await withRules(RULES, async () => {
    assert.equal(engine.getCustomRuleCount(), 2, "Pro でなくても、ルールは持っている");
    const off = await engine.maskSanitize(TEXT, {});
    assert.equal(off.sanitized_text, before.sanitized_text);
    assert.deepEqual(off.detections, before.detections);
    assert.deepEqual(off.custom, { status: "off" });
    const offAgg = await engine.maskAggregated(TEXT, {});
    assert.deepEqual(offAgg.aggregated, beforeAgg.aggregated);
    assert.deepEqual(offAgg.custom, { status: "off" });

    // Pro が切れる (お試しの終わり・購入の取り消し): オンのあいだは効き、オフに戻ると、ルールが残っていても効かない
    engine.setProEnabled(true);
    assert.equal(await sanitize(TEXT), MASKED);
    engine.setProEnabled(false);
    const expired = await engine.maskSanitize(TEXT, {});
    assert.equal(expired.sanitized_text, before.sanitized_text);
    assert.deepEqual(expired.custom, { status: "off" });
  });
});

test("T-CR-22 Pro のとき: <PROJECT_1> と <ACME_ID_1> で伏せ、custom.status は ok。電話番号は今どおり伏せる", async () => {
  await withRules(RULES, async () => {
    engine.setProEnabled(true);
    const res = await engine.maskSanitize(TEXT, {});
    assert.equal(res.sanitized_text, MASKED);
    assert.deepEqual(res.custom, { status: "ok" });
    // ML を使う経路 (runPipelineWithMl) でも同じ。node には Service Worker が無いので、ML は unavailable で抜ける
    const viaMl = await engine.maskSanitize(TEXT, { mlEnabled: true });
    assert.equal(viaMl.sanitized_text, MASKED);
    assert.deepEqual(viaMl.custom, { status: "ok" });
    assert.equal(viaMl.ml.status, "unavailable");

    // 送るときは、setCustomRules で温めた正規表現を作り直さずに使う。温めに使う文字 (a) に当たるルールでも、
    // 送るたびに文の頭から当たる (前の照合の位置が残っていると、頭の「a1」を取りこぼす)
    assert.equal(engine.setCustomRules([{ id: "r7", label: "GRADE", kind: "regex", pattern: "a\\d?", enabled: true }]), 1);
    for (let i = 0; i < 2; i++) assert.equal(await sanitize("a1 と a2"), "<GRADE_1> と <GRADE_2>");
  });
});

test("T-CR-23 全角の本文 (ＡＣＭＥ－１２３４) でも伏せる。元の文の位置で置き換わる", async () => {
  // 半角のカナ「ﾃﾞｰﾀ」は、エンジンが整えた本文では「データ」(1 文字短い) になる。整えた本文の位置のまま置き換えると、
  // 1 文字ずれて「４」などが残る
  const order = { id: "r4", label: "ORDER", kind: "regex", pattern: "ORD\\d{3}-\\d{4}", enabled: true };
  await withRules([...RULES, order], async () => {
    engine.setProEnabled(true);
    const wide = await engine.maskSanitize("ﾃﾞｰﾀの ＡＣＭＥ－１２３４ は全角です", {});
    assert.equal(wide.sanitized_text, "ﾃﾞｰﾀの <ACME_ID_1> は全角です");
    const hit = wide.detections.find((d) => d.entity_type === "ACME_ID");
    assert.deepEqual([hit.start, hit.end, hit.text], [6, 15, "ＡＣＭＥ－１２３４"]);

    // 数字の間の「ー」は、エンジンが整えた本文では - になる。カスタムの正規表現も、その本文に当てる
    // (NFKC に直しただけの文では「ー」のままで当たらない)。今の検出 (郵便番号の形) は「123ー4567」だけを拾うので、
    // カスタムが当たらないと「ORD」が残る
    const dash = await sanitize("ﾃﾞｰﾀの注文 ORD123ー4567 の件");
    assert.equal(dash, "ﾃﾞｰﾀの注文 <ORDER_1> の件");
    const rest = dash.replace(/<[A-Z][A-Z0-9_]*_\d+>/g, ""); // 伏せ字の外に残った文
    for (const piece of ["ORD", "ー4567", "4567", "123"]) assert.ok(!rest.includes(piece), `「${piece}」が残っている: ${dash}`);

    // 本文を整えるのは、カスタムの検出 1 回につき 1 回だけ (ルールごとに整え直さない)。どこにも当たらないルールを 1 本
    // 足しても (検出は同じ)、normalize を呼ぶ数は変わらない
    const normalizeCalls = async (rules) => {
      engine.setCustomRules(rules);
      const original = String.prototype.normalize;
      let calls = 0;
      String.prototype.normalize = function (...args) { calls += 1; return original.apply(this, args); };
      try { await engine.maskSanitize(TEXT, {}); } finally { String.prototype.normalize = original; }
      return calls;
    };
    const never = { id: "r9", label: "NEVER", kind: "words", words: ["どこにも無い語"], match: "partial", enabled: true };
    const base = await normalizeCalls(RULES);
    assert.ok(base > 0);
    assert.equal(await normalizeCalls([...RULES, never]), base);
  });
});

test("T-CR-24 今の検出と重なる: 語「山田商事」と本文「山田商事株式会社の山田太郎」。伏せ字のあとの文に「山田」「商事」のかけらが残らない", async () => {
  const client = { id: "r3", label: "CLIENT", kind: "words", words: ["山田商事"], match: "partial", enabled: true };
  await withRules([client], async () => {
    engine.setProEnabled(true);
    const res = await engine.maskSanitize("山田商事株式会社の山田太郎", {});
    assert.deepEqual(res.custom, { status: "ok" });
    for (const piece of ["山田", "商事", "株式会社"]) assert.ok(!res.sanitized_text.includes(piece), `「${piece}」が残っている: ${res.sanitized_text}`);
    // 重なった所 (山田商事株式会社) は、伏せ字 1 つになる。1 つ (会社名) がほかを全部包む組なので、まとめずに、
    // 今の重なりの解消に任せる (包む会社名が残る)
    assert.match(res.sanitized_text, /^<COMPANY_1>の/);

    // 重ならない所に出てきた語は、カスタムの伏せ字になる (今の検出だけだと「<JP_SURNAME_1>商事」で「商事」が残る)
    const more = await sanitize("山田商事株式会社の山田太郎。山田商事の担当です");
    assert.ok(more.endsWith("。<CLIENT_1>の担当です"), more);
    for (const piece of ["山田", "商事"]) assert.ok(!more.includes(piece), `「${piece}」が残っている: ${more}`);
  });

  // またがる重なり: 重なりでつながった組を、全体を合わせた 1 つの伏せ字にまとめる (名前は、いちばん左から始まるカスタムの名前)。
  // 重なりの解消は、左端から取って負けた範囲を丸ごと捨てるので、まとめないと、カスタムが今の検出の頭に食い込むと今の検出の
  // 尻尾が残り (「<ORDER_1>-4567」)、尻尾からはみ出すとカスタムが捨てられる。Pro でないときは今と同じ
  const straddles = [
    // 頭に食い込む (今の検出は郵便番号の形の「123-4567」)
    ["注文 ORD123-4567 の件", { kind: "regex", pattern: "ORD\\d+" }, "ORDER", "注文 <ORDER_1> の件", ["4567", "ORD", "123"]],
    ["注文 ORD123-4567 の件", { kind: "words", words: ["ORD123"], match: "exact" }, "ORDER", "注文 <ORDER_1> の件", ["4567", "ORD", "123"]],
    ["注文 ORD123ー4567 の件", { kind: "regex", pattern: "ORD\\d+" }, "ORDER", "注文 <ORDER_1> の件", ["4567", "ORD", "123"]],
    // 尻尾からはみ出す (今の検出は電話番号)
    ["電話 090-1234-5678ACME", { kind: "regex", pattern: "5678ACME" }, "ACME_CODE", "電話 <ACME_CODE_1>", ["5678", "ACME"]],
    // 3 つがつながる (電話番号 2 つと、そのあいだをまたぐカスタム)。まとめないと、カスタムのまん中の「XYZ」が残る
    ["回線 090-1234-5678XYZ03-1234-5678 まで", { kind: "regex", pattern: "5678XYZ03" }, "LINE", "回線 <LINE_1> まで", ["XYZ", "5678", "090", "03-"]],
    // 接するだけ (重ならない) なら、まとめない
    ["連絡先 090-1234-5678ACME-1234", { kind: "regex", pattern: "ACME-\\d{4}" }, "ACME_ID", "連絡先 <PHONE_NUMBER_1><ACME_ID_1>", ["5678", "ACME", "1234"]],
  ];
  try {
    for (const [text, body, label, expected, pieces] of straddles) {
      engine.setCustomRules([]);
      engine.setProEnabled(false);
      const free = await sanitize(text);
      engine.setCustomRules([{ id: "s1", label, enabled: true, ...body }]);
      assert.equal(await sanitize(text), free, `Pro でないときは今と同じ: ${text}`);
      engine.setProEnabled(true);
      const res = await engine.maskSanitize(text, {});
      assert.equal(res.sanitized_text, expected, `${text} / ${JSON.stringify(body)}`);
      assert.deepEqual(res.custom, { status: "ok" });
      const rest = res.sanitized_text.replace(/<[A-Z][A-Z0-9_]*_\d+>/g, ""); // 伏せ字の外に残った文
      for (const piece of pieces) assert.ok(!rest.includes(piece), `「${piece}」が残っている: ${res.sanitized_text}`);
      // まとめた検出の文字も、元の文のその範囲 (サイドバーに出る字・ブロックリストを引く字)
      for (const d of res.detections) assert.equal(d.text, text.slice(d.start, d.end), `${text} の ${d.entity_type}`);
    }

    // カスタムを含まない組 (今の検出どうし。ここではサイドバーの「常に伏せる語」と郵便番号の形) は、カスタムの検出が
    // ほかの所にあっても、今のまま (まとめるのはカスタムを含む組だけ。今の検出どうしのまたがりは、ここでは変えない)
    engine.setCustomRules(RULES);
    const ufm = { userForceMaskEntries: [{ value: "ORD123", category: "OTHER" }] };
    const mixed = "アルファ計画の注文 ORD123-4567 の件";
    engine.setProEnabled(false);
    assert.equal(await sanitize(mixed, ufm), "アルファ計画の注文 <USER_DEFINED_OTHER_1>-4567 の件");
    engine.setProEnabled(true);
    assert.equal(await sanitize(mixed, ufm), "<PROJECT_1>の注文 <USER_DEFINED_OTHER_1>-4567 の件");
  } finally {
    engine.setCustomRules([]);
    engine.setProEnabled(false);
  }
});

test("T-CR-25 ルールが 0 個、または Pro でないとき、時計を 1 回も呼ばない (足した処理を通らない)", async () => {
  let calls = 0;
  const clock = () => { calls += 1; return 0; };
  const statuses = async () => {
    const out = [];
    for (const mlEnabled of [false, true]) {
      out.push((await engine.maskSanitize(TEXT, { clock, mlEnabled })).custom.status);
      out.push((await engine.maskAggregated(TEXT, { clock, mlEnabled })).custom.status);
    }
    return out;
  };
  try {
    engine.setProEnabled(true);
    assert.equal(engine.setCustomRules([]), 0);
    assert.deepEqual(await statuses(), ["off", "off", "off", "off"], "Pro でもルールが 0 個");
    engine.setProEnabled(false);
    assert.equal(engine.setCustomRules(RULES), 2);
    assert.deepEqual(await statuses(), ["off", "off", "off", "off"], "ルールがあっても Pro でない");
    assert.equal(calls, 0);

    // 偽の時計が効いていることの確かめ: Pro でルールがあれば呼ぶ
    engine.setProEnabled(true);
    await engine.maskSanitize(TEXT, { clock });
    assert.ok(calls > 0);
  } finally {
    engine.setCustomRules([]);
    engine.setProEnabled(false);
  }
});

test("T-CR-26 時間の上限: 時計が 1 回ごとに 60 進む偽物で、2 本目の前に上限を超え、custom.status は partial。1 本目の検出は残る", async () => {
  await withRules(RULES, async () => {
    engine.setProEnabled(true);
    // 既定の上限は 100 ミリ秒。始めが 0、1 本目の前が 60 (当てる)、2 本目の前が 120 (止める)
    const res = await engine.maskSanitize(TEXT, { clock: stepClock(60) });
    assert.deepEqual(res.custom, { status: "partial" });
    assert.equal(res.sanitized_text, "<PROJECT_1>は ACME-1234 で管理しています。連絡先は <PHONE_NUMBER_1>");
    const viaMl = await engine.maskSanitize(TEXT, { clock: stepClock(60), mlEnabled: true });
    assert.deepEqual(viaMl.custom, { status: "partial" });
    assert.equal(viaMl.sanitized_text, res.sanitized_text);

    // ちょうど上限に届いたときも止める (2 本目の前の 120 が、上限 120 と同じ)
    assert.deepEqual((await engine.maskSanitize(TEXT, { clock: stepClock(60), customBudgetMs: 120 })).custom, { status: "partial" });
    // 1 本目の前にも見る: 上限 0 なら、本物の時計でも 1 本も当てない
    const none = await engine.maskSanitize(TEXT, { customBudgetMs: 0 });
    assert.deepEqual(none.custom, { status: "partial" });
    assert.equal(none.sanitized_text, "アルファ計画は ACME-1234 で管理しています。連絡先は <PHONE_NUMBER_1>");
    // 時計が進まなければ、全部当てて ok
    assert.deepEqual((await engine.maskSanitize(TEXT, { clock: () => 0 })).custom, { status: "ok" });
  });
});

test("T-CR-27 止めた分類 (disabledCategories) にルールの名前があれば、そのルールを当てない", async () => {
  await withRules(RULES, async () => {
    engine.setProEnabled(true);
    const noProject = await engine.maskSanitize(TEXT, { disabledCategories: ["PROJECT"] });
    assert.equal(noProject.sanitized_text, "アルファ計画は <ACME_ID_1> で管理しています。連絡先は <PHONE_NUMBER_1>");
    assert.deepEqual(noProject.custom, { status: "ok" });
    assert.equal(await sanitize(TEXT, { disabledCategories: ["ACME_ID"] }), "<PROJECT_1>は ACME-1234 で管理しています。連絡先は <PHONE_NUMBER_1>");
    assert.equal(await sanitize(TEXT, { disabledCategories: ["PROJECT", "ACME_ID"] }), "アルファ計画は ACME-1234 で管理しています。連絡先は <PHONE_NUMBER_1>");
    // 今の分類 (電話番号の分類は PHONE_NUMBER_JP) と一緒に止めても、それぞれに効く
    assert.equal(
      await sanitize(TEXT, { disabledCategories: ["ACME_ID", "PHONE_NUMBER_JP"] }),
      "<PROJECT_1>は ACME-1234 で管理しています。連絡先は 090-1234-5678",
    );
  });
});

test("T-CR-28 maskAggregated の結果にも custom.status が付き、集めた行にカスタムの名前が出る", async () => {
  await withRules(RULES, async () => {
    engine.setProEnabled(true);
    for (const mlEnabled of [false, true]) {
      const agg = await engine.maskAggregated(TEXT, { mlEnabled });
      assert.deepEqual(agg.custom, { status: "ok" });
      const rows = agg.aggregated.map((r) => [r.label, r.value, r.placeholder]);
      assert.deepEqual(rows.filter(([label]) => label !== "PHONE_NUMBER"), [
        ["PROJECT", "アルファ計画", "<PROJECT_1>"],
        ["ACME_ID", "ACME-1234", "<ACME_ID_1>"],
      ]);
      assert.ok(rows.some(([label]) => label === "PHONE_NUMBER"), "今の検出の行が消えた");
    }
    const partial = await engine.maskAggregated(TEXT, { clock: stepClock(60) });
    assert.deepEqual(partial.custom, { status: "partial" });
    assert.deepEqual(partial.aggregated.filter((r) => r.label !== "PHONE_NUMBER").map((r) => r.label), ["PROJECT"]);
  });
});

test("T-CR-29 名前が今の種類と同じ (label: PERSON、語「ジョン・ドウ」): 今の人名の検出と番号を共有し、<PERSON_1> と <PERSON_2> になる (設計書 3.1)", async () => {
  const person = { id: "r5", label: "PERSON", kind: "words", words: ["ジョン・ドウ"], match: "exact", enabled: true };
  const text = "カード名義 Taro Yamada の件で、ジョン・ドウさんに連絡";
  await withRules([person], async () => {
    engine.setProEnabled(true);
    assert.equal(await sanitize(text), "カード名義 <PERSON_1> の件で、<PERSON_2>さんに連絡");
    const agg = await engine.maskAggregated(text, {});
    const rows = agg.aggregated.map((r) => [r.label, r.value, r.placeholder, r.category]);
    const category = rows.find(([, value]) => value === "Taro Yamada")[3];
    assert.deepEqual(rows, [
      ["PERSON", "Taro Yamada", "<PERSON_1>", category],
      ["PERSON", "ジョン・ドウ", "<PERSON_2>", category],
    ]);
  });
});

test("T-CR-30 既定のブロックリストにある語 (サーバー) も、語のルールに入れれば Pro のときは伏せる。Pro でないときは今と同じ (伏せない)", async () => {
  // ブロックリストは自動の検出の誤検出を抑えるためのもの。利用者が書いたルールは、それで黙って無効にしない
  const text = "このサーバーは来月止める";
  const before = await engine.maskSanitize(text, {});
  assert.ok(before.sanitized_text.includes("サーバー"), "今のエンジンは、普通名詞のサーバーを伏せない");
  const host = { id: "r6", label: "HOST", kind: "words", words: ["サーバー"], match: "exact", enabled: true };
  await withRules([host], async () => {
    const off = await engine.maskSanitize(text, {});
    assert.equal(off.sanitized_text, before.sanitized_text);
    assert.deepEqual(off.detections, before.detections);
    assert.deepEqual(off.custom, { status: "off" });

    engine.setProEnabled(true);
    for (const mlEnabled of [false, true]) {
      const on = await engine.maskSanitize(text, { mlEnabled });
      assert.equal(on.sanitized_text, "この<HOST_1>は来月止める");
      assert.deepEqual(on.custom, { status: "ok" });
    }
    const agg = await engine.maskAggregated(text, {});
    assert.deepEqual(agg.aggregated.map((r) => [r.label, r.value, r.placeholder]), [["HOST", "サーバー", "<HOST_1>"]]);
    // 外すのはブロックリストだけ。ほかの絞り込み (ここでは分類の絞り込み。HOST の分類は other) は、これまでどおり効く
    assert.equal(await sanitize(text, { enabledPiiClasses: ["contact"] }), text);

    // サイドバーから足す「常に伏せる語」は、Pro でカスタムルールがあっても、これまでどおりブロックリストに負ける
    const entries = [{ value: "データ", category: "OTHER" }, { value: "社外秘資料", category: "OTHER" }];
    assert.equal(await sanitize("データと社外秘資料を送る", { userForceMaskEntries: entries }), "データと<USER_DEFINED_OTHER_1>を送る");
  });
});

test("T-CR-52 名前が PERSON のルールの行は、人名の絞り込み (「こと」「ため」などを含む 7 文字以上の人名を捨てる) で落とさない。今の検出にまたがってまとめた検出も同じ。無料版の行は今と同じ", async () => {
  // 確認のサイドバーは集めた形 (maskAggregated) の行で開き、行が 0 件なら確認なしで原文のまま送る。カスタムの行が
  // この絞り込みで消えると、ルールの語が黙って送られる。カスタムの検出には custom: true の印が付き、絞り込みはそれを見る
  const words = (id, list, match) => ({ id, label: "PERSON", kind: "words", words: list, match, enabled: true });
  // [ルール, 本文, Pro の行, 無料版の行]
  const cases = [
    [words("p1", ["佐々木 ことみ"], "exact"), "佐々木 ことみ様に連絡します", [["PERSON", "佐々木 ことみ", "<PERSON_1>"]], [["JP_SURNAME", "佐々木", "<JP_SURNAME_1>"]]],
    [words("p2", ["勅使河原ことみ"], "exact"), "勅使河原ことみ様に連絡します", [["PERSON", "勅使河原ことみ", "<PERSON_1>"]], []],
    // 今の検出 (名字の 佐々木) にまたがる語: 1 つにまとめた検出 (佐々木 ことみ) にも印が付く
    [words("p3", ["木 ことみ"], "partial"), "佐々木 ことみ様に連絡します", [["PERSON", "佐々木 ことみ", "<PERSON_1>"]], [["JP_SURNAME", "佐々木", "<JP_SURNAME_1>"]]],
  ];
  const rowsOf = (agg) => agg.aggregated.map((r) => [r.label, r.value, r.placeholder]);
  for (const [rule, text, proRows, freeRows] of cases) {
    const before = await engine.maskAggregated(text, {});
    assert.deepEqual(rowsOf(before), freeRows, `無料版の行 (${text})`);
    await withRules([rule], async () => {
      assert.deepEqual((await engine.maskAggregated(text, {})).aggregated, before.aggregated, `Pro でなければ今と同じ (${text})`);
      engine.setProEnabled(true);
      for (const mlEnabled of [false, true]) {
        assert.deepEqual(rowsOf(await engine.maskAggregated(text, { mlEnabled })), proRows, `Pro の行 (${text}、mlEnabled: ${mlEnabled})`);
      }
      assert.equal(await sanitize(text), text.replace(proRows[0][1], "<PERSON_1>"), `伏せた文 (${text})`);
    });
  }

  // 絞り込みそのもの: 印の無い人名の検出は今どおり捨て、印のある検出 (Pro でルールが当たったときだけ) は残す
  const aggregate = require(E + "aggregate.js");
  const det = { entity_type: "PERSON", start: 0, end: 7, text: "佐々木 ことみ", score: 1.0, action: "masked" };
  assert.deepEqual(aggregate.aggregateDetections([det]), [], "印の無い検出は、今どおり捨てる");
  assert.deepEqual(aggregate.aggregateDetections([{ ...det, custom: true }]).map((r) => [r.label, r.value]), [["PERSON", "佐々木 ことみ"]], "印のある検出は残す");
});
