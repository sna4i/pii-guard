// tests/engine/custom-rules-engine.test.mjs — エンジンが、Pro のときだけカスタムルールを当てる (Pro Phase 2 の設計 (P1)、T-CR-21〜29)
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
    // 重なった所 (山田商事株式会社) は、伏せ字 1 つになる
    assert.match(res.sanitized_text, /^<[A-Z_]+_1>の/);

    // 重ならない所に出てきた語は、カスタムの伏せ字になる (今の検出だけだと「<JP_SURNAME_1>商事」で「商事」が残る)
    const more = await sanitize("山田商事株式会社の山田太郎。山田商事の担当です");
    assert.ok(more.endsWith("。<CLIENT_1>の担当です"), more);
    for (const piece of ["山田", "商事"]) assert.ok(!more.includes(piece), `「${piece}」が残っている: ${more}`);
  });
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
