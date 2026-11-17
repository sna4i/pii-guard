// tests/engine/ml-deadline.test.mjs — ML の判定を待つ上限 (docs/release-1.7.1.md の D-SC-09、T-SC-20d)
//
// Service Worker が答えないと、保護入力欄の送信がいつまでも待っていた (P-SC-07)。
// detectViaMl() は上限で空の結果と status "timeout" を返し、遅れて届いた返事は捨てる。
// maskSanitize() と maskAggregated() は結果に ml.status を付ける。
//
// Run: node --test tests/engine/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ENGINE = "../../browser-extension/engine/";

// chrome.runtime の偽物。sendMessage の答え方をテストごとに差し替える
let answer = () => {};
globalThis.chrome = { runtime: { lastError: undefined, sendMessage(msg, cb) { answer(msg, cb); } } };
const onnx = require(ENGINE + "onnx-detector.js");
const engine = require(ENGINE + "engine.js");

const TEXT = "山田太郎の電話は 090-1234-5678 です";
const PHONE = "090-1234-5678";
const ENTITY = { entity_group: "PER", score: 0.9, word: "山田太郎", start: 0, end: 4 };

test("T-SC-20d Service Worker が答えないと、上限で timeout を返し、遅れた返事は捨てる", { timeout: 5000 }, async () => {
  let late = null;
  answer = (msg, cb) => { late = cb; };
  const t0 = Date.now();
  const r = await onnx.detectViaMl(TEXT, { timeoutMs: 60 });
  const ms = Date.now() - t0;
  assert.equal(r.status, "timeout");
  assert.deepEqual(r.detections, []);
  assert.ok(ms >= 50 && ms < 1000, `上限で返っていない: ${ms} ms`);
  late({ ok: true, entities: [ENTITY] }); // 遅れて届いた返事。何も起きない (例外も出ない)
});

test("T-SC-20d 答えがあれば ok と検出。lastError や失敗の返事は error、chrome.runtime が無ければ unavailable", { timeout: 5000 }, async () => {
  answer = (msg, cb) => { assert.equal(msg.type, "ML_DETECT"); cb({ ok: true, entities: [ENTITY] }); };
  const ok = await onnx.detectViaMl(TEXT, { timeoutMs: 60 });
  assert.equal(ok.status, "ok");
  assert.equal(ok.detections.length, 1);
  assert.equal(ok.detections[0].entity_type, "PROPER_NOUN_PERSON");
  assert.equal(ok.detections[0].text, "山田太郎");

  answer = (msg, cb) => {
    globalThis.chrome.runtime.lastError = { message: "The message port closed before a response was received." };
    try { cb(undefined); } finally { globalThis.chrome.runtime.lastError = undefined; }
  };
  const asleep = await onnx.detectViaMl(TEXT, { timeoutMs: 60 });
  assert.equal(asleep.status, "error");
  assert.deepEqual(asleep.detections, []);

  answer = (msg, cb) => { cb({ ok: false, error: "model failed" }); };
  assert.equal((await onnx.detectViaMl(TEXT, { timeoutMs: 60 })).status, "error");

  const saved = globalThis.chrome;
  delete globalThis.chrome;
  try { assert.equal((await onnx.detectViaMl(TEXT, { timeoutMs: 60 })).status, "unavailable"); }
  finally { globalThis.chrome = saved; }
});

test("T-SC-20d maskSanitize と maskAggregated は ml.status を付け、timeout でも正規表現の検出は残る", { timeout: 5000 }, async () => {
  answer = () => {}; // 答えない
  const res = await engine.maskSanitize(TEXT, { mlEnabled: true, mlTimeoutMs: 60 });
  assert.equal(res.ml.status, "timeout");
  assert.ok(res.detections.length > 0, "正規表現の検出が消えた");
  assert.ok(!res.sanitized_text.includes(PHONE), "電話番号が伏せ字になっていない");
  const agg = await engine.maskAggregated(TEXT, { mlEnabled: true, mlTimeoutMs: 60 });
  assert.equal(agg.ml.status, "timeout");
  assert.ok(agg.aggregated.some((row) => row.value === PHONE), "正規表現の検出が消えた (aggregated)");

  answer = (msg, cb) => cb({ ok: true, entities: [ENTITY] });
  const withMl = await engine.maskSanitize(TEXT, { mlEnabled: true, mlTimeoutMs: 60 });
  assert.equal(withMl.ml.status, "ok");
  assert.ok(withMl.detections.some((d) => d.entity_type === "PROPER_NOUN_PERSON"), "ML の検出が混ざっていない");

  assert.equal((await engine.maskSanitize(TEXT, { mlEnabled: false })).ml.status, "off");
  assert.equal((await engine.maskAggregated(TEXT, {})).ml.status, "off");
});
