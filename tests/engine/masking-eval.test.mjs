// tests/engine/masking-eval.test.mjs — 観点ベース eval のゲート (tests/eval/masking-eval.mjs)。
//
// 既知の限界 (数字を 1 桁ずつ空白で分断する難読化) を除いて recall 100%、過検出 0 を要求する。
// 新しい観点を足して落ちたら、エンジンを直すか、限界なら eval 側で gap として記録する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEval } from "../eval/masking-eval.mjs";

test("観点ベース eval: 既知の限界を除き recall 100% / 過検出 0", async () => {
  const r = await runEval();
  assert.ok(r.cases >= 300, `ケース数が足りない: ${r.cases}`);
  assert.deepEqual(r.leaks, [], `漏れ: ${JSON.stringify(r.leaks.slice(0, 5))}`);
  assert.deepEqual(r.falsePositives, [], `過検出: ${JSON.stringify(r.falsePositives.slice(0, 5))}`);
  assert.equal(r.gateRecall, 1);
});
