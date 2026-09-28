// tests/engine/business-numbers-holdout.test.mjs — 業務上の数値 (率・金額・比)
// の検出性能の床。
//
// このセットは patterns.js の文脈語を調整し終えた後に、それを参照せずに
// 書いたもの。**緑にするために文脈語を足してはいけない** — 足せば
// このセットの数字は上がるが、次の未知のセットでは同じところに戻るだけで、
// 測定器としての価値が失われる。
//
// 測定値 (2026-09-27):
//   調整前  precision 0.92 / recall 0.80   <- 報告値
//   調整後  precision 1.00 / recall 0.87   (下記 2 点を直した後の参考値)
// 測定後に直したのは 2 点だけ: 事前に予測していた「資料」の誤検出の除外と、
// 依頼範囲 (割合) に含まれる「倍」の実装。以下の見逃しは意図的に残している:
//   - 「3%安い」    — 安い/高い を後置の文脈語にすると「10%高い確率」も拾う
//   - 「粗利ベース」 — カタカナが続くため複合名詞ガードで文脈語から外れる
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("../../browser-extension/engine/engine.js");
const NUMERIC = new Set(["PERCENTAGE", "MONETARY_AMOUNT", "RATIO"]);

// [入力, マスクされるべき数値表記 (空 = 何もマスクされるべきでない)]
const CASES = [
  ["来月から配送料を一律8%引き上げる", ["8%"]],
  ["競合より3%安い価格設定にしたい", ["3%"]],
  ["新卒の初任給は25万円に引き上げ", ["25万円"]],
  ["クライアントへの請求は時給8千円で計算", ["8千円"]],
  ["今回の案件は利益率が低く、せいぜい7%程度", ["7%"]],
  ["社員の賞与を業績連動で最大1.5倍に", ["1.5倍"]],
  ["A社の持分を25%から40%に引き上げる交渉中", ["25%","40%"]],
  ["外注費が予算を800万オーバーしている", ["800万"]],
  ["粗利ベースで月1,200万は確保したい", ["1,200万"]],
  ["当社の市場シェアは約18パーセント", ["18パーセント"]],
  ["その会社の買収額は推定で2.4兆円", ["2.4兆円"]],
  ["価格交渉の結果、単価を1割下げることになった", ["1割"]],
  ["契約更新時に保守料を20%上げたい", ["20%"]],
  ["この取引の手数料率はたしか0.3%", ["0.3%"]],
  ["スマホの充電が15%しかない", []],
  ["インフレ率は2%が目標とされている", []],
  ["エラー率が0.1%を超えたらアラート", []],
  ["ディスクの空き容量が10%を切った", []],
  ["JavaScriptで50%の確率で分岐する", []],
  ["日本の人口のおよそ3割が65歳以上", []],
  ["このレシピは砂糖と塩を2:1で混ぜる", []],
  ["サッカーの試合は2対0で終わった", []],
  ["動画の再生数は300万を突破", []],
  ["テストの合格ラインは60%以上", []],
  ["画面の縦横比は16:9", []],
  ["資料の20%まで読み進めた", []],
  ["金曜日に10%の確率で雨", []],
  ["無料プランでは容量の50%まで使える", []],
];

async function score() {
  let tp = 0, fn = 0, fp = 0;
  const falsePositives = [];
  for (const [t, want] of CASES) {
    const s = await engine.maskSanitize(t, {});
    const got = s.detections.filter((d) => NUMERIC.has(d.entity_type)).map((d) => d.text);
    if (want.length) for (const w of want) got.includes(w) ? tp++ : fn++;
    else if (got.length) { fp++; falsePositives.push(`${t} -> ${got.join(",")}`); }
  }
  return { precision: tp / (tp + fp) || 0, recall: tp / (tp + fn) || 0, falsePositives };
}

test("precision on untuned input does not regress below 0.9", async () => {
  const { precision, falsePositives } = await score();
  assert.ok(precision >= 0.9,
    `precision ${precision.toFixed(2)} < 0.90 — masking numbers users need: ${falsePositives.join(" | ")}`);
});

test("recall on untuned input does not regress below 0.8", async () => {
  const { recall } = await score();
  assert.ok(recall >= 0.8, `recall ${recall.toFixed(2)} < 0.80 — business numbers are leaking`);
});
