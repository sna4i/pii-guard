// options-rules-worker.js — 設定画面のカスタムルールの確かめを、画面とは別のスレッドで走らせる (Pro Phase 2 の設計 (P1)、T-CR-47)
//
// 正規表現の 1 回の照合は、途中で止められない。時間を食う形が確かめをすり抜けると、画面のスレッドで試した
// とたんに設定画面ごと固まる。ここで試せば、画面の側が、答えが 1 秒たっても来ないときに、この Worker を
// 止めて (terminate) 作り直し、そのルールだけを断れる。確かめそのものは engine/custom-rules.js の関数で、
// 保存と読み込みで同じ決まりを使う (importRules が 1 本ごとにする確かめと同じ)。
//
// 頼み (id は頼んだ側が付け、答えにそのまま付けて返す)。答えは { id, ok: true, … } か { id, ok: false, errors }
//   { id, op: "validate", rule }          validateRule だけ。一覧で、保存済みのルールが使われているかを見る
//   { id, op: "check", rule }             validateRule → compileRule → stressTest。保存と、読み込みの 1 本ごとの確かめ。ok なら rule (整えた形)
//   { id, op: "read", text }              読み込むファイル全体の確かめ (JSON・format・version・rules)。ok なら rules (中のルールの配列)
//   { id, op: "merge", rules, existing }  確かめを通ったルールだけで importRules。足し方 (同じルール・id・上限) の決まり。ok なら result
"use strict";

importScripts("engine/custom-rules.js");
const cr = self.__localMaskMCP.engine.customRules;

function validate({ rule }) {
  const checked = cr.validateRule(rule);
  return checked.ok ? { ok: true } : { ok: false, errors: checked.errors };
}

function check({ rule }) {
  const checked = cr.validateRule(rule);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const compiled = cr.compileRule(checked.rule);
  if (!compiled) return { ok: false, errors: ["正規表現を組み立てられません。語や正規表現を短くしてください"] };
  if (!cr.stressTest(compiled.pattern).ok) {
    return { ok: false, errors: [`照合に時間がかかりすぎます (上限 ${cr.LIMITS.stressMs} ミリ秒を超えました)。パターンを単純にしてください`] };
  }
  return { ok: true, rule: checked.rule };
}

function read({ text }) {
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = null; }
  const rules = data !== null && typeof data === "object" && Array.isArray(data.rules) ? data.rules : null;
  // ファイル全体の確かめと理由の文は、importRules に任せる。ルールを抜いたファイルで呼べば、ルールは 1 本も動かない。
  // rules が配列でなければ、そのままのファイルで呼ぶ (「rules が配列ではありません」などの理由が返る)
  const head = cr.importRules(rules ? JSON.stringify({ ...data, rules: [] }) : text, []);
  const failure = head.rejected.find((r) => r.index === -1);
  return failure ? { ok: false, errors: failure.errors } : { ok: true, rules };
}

function merge({ rules, existing }) {
  const text = JSON.stringify({ format: cr.EXPORT_FORMAT, version: cr.EXPORT_VERSION, rules });
  return { ok: true, result: cr.importRules(text, existing) };
}

self.onmessage = (event) => {
  const request = event.data || {};
  let answer;
  try {
    if (request.op === "validate") answer = validate(request);
    else if (request.op === "check") answer = check(request);
    else if (request.op === "read") answer = read(request);
    else if (request.op === "merge") answer = merge(request);
    else answer = { ok: false, errors: ["不明な頼みです"] };
  } catch (_) {
    answer = { ok: false, errors: ["確かめの途中で失敗しました"] };
  }
  self.postMessage({ id: request.id, ...answer });
};
