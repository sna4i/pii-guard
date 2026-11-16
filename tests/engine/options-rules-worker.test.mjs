// tests/engine/options-rules-worker.test.mjs — 設定画面の確かめの Worker (options-rules-worker.js) は、保存と読み込みの試し
// (stressTest) の前に、組み立てた正規表現を短い文 (a・あ・a) に当てて温める (Pro Phase 2 の設計 (P1)、T-CR-55)
//
// V8 は正規表現の初めの照合で、バイトコードや機械語を組み立てる (1 バイトの文字列と 2 バイトの文字列で別々に)。冷えたまま
// 測ると、その時間が 50 ミリ秒の試しに入り、上限いっぱいの語のリストなどで、送るときには間に合うルールを断りうる。エンジンは
// setCustomRules で同じ温めをしてから送る。ここでは時間を測らず、温めが試しの前に走ることを、呼ばれた順で確かめる。
// Worker のファイルは、node の vm に Worker と同じ口 (self・importScripts・postMessage・onmessage) を用意して読み込む
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const EXT = new URL("../../browser-extension/", import.meta.url);

function loadWorker() {
  const posted = [];
  const sandbox = { performance, postMessage: (message) => posted.push(message) };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...paths) => {
    for (const p of paths) vm.runInContext(fs.readFileSync(new URL(p, EXT), "utf8"), ctx, { filename: p });
  };
  vm.runInContext(fs.readFileSync(new URL("options-rules-worker.js", EXT), "utf8"), ctx, { filename: "options-rules-worker.js" });
  return { sandbox, posted, cr: sandbox.__localMaskMCP.engine.customRules };
}

// 組み立てた正規表現に当てた文と、試し (stressTest・importRules) を、呼ばれた順に events に残す
function watch(cr) {
  const events = [];
  const compileRule = cr.compileRule;
  const stressTest = cr.stressTest;
  const importRules = cr.importRules;
  const warmed = new Set();
  cr.compileRule = (rule) => {
    const compiled = compileRule(rule);
    if (!compiled) return compiled;
    const original = compiled.pattern.test;
    compiled.pattern.test = function (subject) {
      events.push(`test:${subject}`);
      warmed.add(this);
      return original.call(this, subject);
    };
    return compiled;
  };
  cr.stressTest = (re, ...rest) => {
    events.push(warmed.has(re) ? "stressTest:warmed" : "stressTest:cold");
    return stressTest(re, ...rest);
  };
  cr.importRules = (...args) => {
    events.push("importRules");
    return importRules(...args);
  };
  return events;
}

const WORDS = { id: "r1", label: "PROJECT", kind: "words", words: ["アルファ計画", "山田商事"], match: "exact", enabled: true };
const REGEX = { id: "r2", label: "ACME_ID", kind: "regex", pattern: "ACME-\\d{4}", enabled: true };
const GRADE = { id: "r3", label: "GRADE", kind: "regex", pattern: "a\\d?", enabled: true }; // 温めの文字 a に当たる形
const WARM = ["test:a", "test:あ", "test:a"];

test("T-CR-55 保存の確かめ (check) と読み込みの足し方 (merge): 組み立てた正規表現を a・あ・a に当てて温めてから、試しで測る", () => {
  const { sandbox, posted, cr } = loadWorker();
  const events = watch(cr);

  for (const rule of [WORDS, REGEX, GRADE]) {
    events.length = 0;
    posted.length = 0;
    sandbox.onmessage({ data: { id: 7, op: "check", rule } });
    assert.deepEqual(events, [...WARM, "stressTest:warmed"], `保存の確かめ: 温めた同じ正規表現を測る (${rule.id})`);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].id, 7);
    assert.equal(posted[0].ok, true, `確かめは通る (${rule.id})`);
  }

  // 読み込みの足し方は importRules の中で試す (Worker が作り直されたあとは、前の Worker で確かめたルールが冷えている)
  events.length = 0;
  posted.length = 0;
  sandbox.onmessage({ data: { id: 8, op: "merge", rules: [WORDS, REGEX], existing: [] } });
  assert.deepEqual(events, [...WARM, ...WARM, "importRules"], "読み込み: 足すルールを全部温めてから、importRules で試す");
  assert.equal(posted[0].ok, true);
  assert.equal(posted[0].result.added, 2);

  // 確かめを通らないルールは、今どおり、組み立ても試しもせずに理由を返す
  events.length = 0;
  posted.length = 0;
  sandbox.onmessage({ data: { id: 9, op: "check", rule: { kind: "regex", pattern: "(a+)+", label: "BAD" } } });
  assert.deepEqual(events, []);
  assert.equal(posted[0].ok, false);
});
