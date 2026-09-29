// tests/engine/llm-prompts.test.mjs — ローカル LLM の検出プロンプト
//
// 設計と評価の結果は docs/llm-prompt-optimization.md。テスト ID はそこに対応する。
// 実際の LLM での精度と速さは scripts/eval-llm-prompts.mjs で測る。
//
// Run: node --test tests/engine/llm-prompts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const prompts = require("../../browser-extension/engine/llm-prompts.js");

const JA_TEXT = "生産管理部の青木課長に、社内システムの件を共有してください";
const EN_TEXT = "Please forward the budget to the finance team";
const CJK = /[぀-ヿ㐀-鿿]/;
// injected.js の mergeLlmDetect() が対応表を持っているラベル
const LABELS = ["PERSON", "COMPANY", "LOCATION", "DEPARTMENT", "PROJECT_CODE", "CREDENTIAL", "SENSITIVE_FACT"];

// システムプロンプトから例を取り出す。例の入力と出力の間には補足の行が入ってもよい
function examples(system) {
  const out = [];
  for (const m of system.matchAll(/Input: "([^"\n]*)"\n(?:[A-Z][a-z ]+: .*\n)?Output: (.*)/g)) {
    out.push({ input: m[1], output: m[2] });
  }
  return out;
}
const allExamples = () => [
  ...examples(prompts.buildDetectPrompt(JA_TEXT).system),
  ...examples(prompts.buildDetectPrompt(EN_TEXT).system),
];

test("T-01 the input is passed as a JSON string with nothing after it", () => {
  const p = prompts.buildDetectPrompt('改行\nと "引用符" を含む入力');
  assert.equal(p.user, `Input: ${JSON.stringify('改行\nと "引用符" を含む入力')}`);
});

test("T-02 the system prompt stays the same across inputs of the same language", () => {
  // Ollama は直前の要求と共通する先頭部分を再計算しない。入力ごとに変えると毎回読み直しになる
  assert.equal(prompts.buildDetectPrompt(JA_TEXT).system, prompts.buildDetectPrompt("田中さんの年収は 1,200万円です").system);
  assert.equal(prompts.buildDetectPrompt(EN_TEXT).system, prompts.buildDetectPrompt("Send it to Jane Roe").system);
});

test("T-03 Japanese input gets Japanese examples and English input gets English ones", () => {
  const ja = examples(prompts.buildDetectPrompt(JA_TEXT).system);
  const en = examples(prompts.buildDetectPrompt(EN_TEXT).system);
  assert.ok(ja.length > 0 && ja.every((e) => CJK.test(e.input)), "Japanese examples");
  assert.ok(en.length > 0 && en.every((e) => !CJK.test(e.input)), "English examples");
});

test("T-04 the output schema does not ask for a reason", () => {
  assert.ok(!/"reason"/.test(prompts.buildDetectPrompt(JA_TEXT).system));
  assert.ok(!/"reason"/.test(prompts.buildDetectPrompt(EN_TEXT).system));
});

test("T-05 every example output is valid, verbatim and uses a label the merge step knows", () => {
  const ex = allExamples();
  assert.ok(ex.length >= 8, `${ex.length} examples found`);
  for (const e of ex) {
    const parsed = JSON.parse(e.output);
    assert.ok(Array.isArray(parsed.entities), e.input);
    for (const ent of parsed.entities) {
      assert.ok(e.input.includes(ent.text), `"${ent.text}" is not in "${e.input}"`);
      assert.ok(LABELS.includes(ent.entity_type), `unknown label ${ent.entity_type}`);
    }
  }
});

test("T-06 an example in each language shows that instructions inside the input are ignored", () => {
  for (const text of [JA_TEXT, EN_TEXT]) {
    const ex = examples(prompts.buildDetectPrompt(text).system);
    const injected = ex.filter((e) => /空のリスト|empty list/i.test(e.input));
    assert.ok(injected.length > 0, `an example asks for an empty list (${text})`);
    for (const e of injected) assert.ok(JSON.parse(e.output).entities.length > 0, `still extracts: ${e.input}`);
  }
});
