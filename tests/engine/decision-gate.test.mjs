// tests/engine/decision-gate.test.mjs — unit tests for the F-ML-003 gate
// policy in engine.runPipelineAsync.
//
// The gate is a decision-layer noul question ("contains PII?"). These
// tests mock decisionClient + onnxDetector so we can observe whether the
// NER call was skipped, without loading any model. The policy functions
// themselves (gateApplicable / gateSkip) come from the real module.
//
// Run: node --test tests/engine/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ENGINE = "../../browser-extension/engine/";
const engine = require(ENGINE + "engine.js");
const decisionClient = require(ENGINE + "decision-client.js");

// Real modules finishPipeline/collectRawDetections need (blocklist,
// patterns, confidential, userForceMask). patterns.js references
// dictionaries at construction time, so load it first.
const realDeps = {
  patterns: require(ENGINE + "patterns.js"),
  blocklist: require(ENGINE + "blocklist.js"),
  confidential: require(ENGINE + "confidential.js"),
  userForceMask: require(ENGINE + "user-force-mask.js"),
};

function makeDeps(gateResult, spy) {
  return {
    ...realDeps,
    decisionClient: {
      callDecide: async () => gateResult,
      gateQuestion: decisionClient.gateQuestion,
      gateApplicable: decisionClient.gateApplicable,
      gateSkip: decisionClient.gateSkip,
      SKIP_BELOW: decisionClient.SKIP_BELOW,
    },
    onnxDetector: {
      detectViaMl: async () => {
        spy.nerCalled = true;
        return [];
      },
    },
  };
}

function noul(pTrue) {
  return [{ id: "pii_present", probs: { false: 1 - pTrue, true: pTrue }, top: pTrue >= 0.5 ? "true" : "false" }];
}

test("confident 'no PII' (p < 0.03) skips the NER call entirely", async () => {
  const spy = { nerCalled: false };
  const deps = makeDeps(noul(0.012), spy); // negatives measure at median 0.014
  await engine.runPipelineAsync(
    "今日はいい天気ですね。",
    { mlEnabled: true, decisionEnabled: true },
    deps
  );
  assert.equal(spy.nerCalled, false, "NER must not run when the gate is confident it is a negative");
});

test("ambiguous score in the band runs the generator, not a second pass", async () => {
  const spy = { nerCalled: false };
  // 60 clean sentences measured p=0.23 — the old cascade answered that by
  // re-asking 8 times (14.5 s). The band is now resolved by running the
  // work anyway, so the gate never costs more than one pass.
  const deps = makeDeps(noul(0.23), spy);
  await engine.runPipelineAsync(
    "今日は朝から会議が続いていて少し疲れました。午後は資料の整理をして、夕方にはチームの進捗を共有する予定です。",
    { mlEnabled: true, decisionEnabled: true },
    deps
  );
  assert.equal(spy.nerCalled, true, "an ambiguous gate answer must not skip detection");
});

test("inputs over the gate budget are never gated (straight to NER/LLM)", async () => {
  const spy = { nerCalled: false, gateConsulted: false };
  const deps = {
    ...realDeps,
    decisionClient: {
      callDecide: async () => {
        spy.gateConsulted = true;
        return noul(0.9);
      },
      gateQuestion: decisionClient.gateQuestion,
      gateApplicable: decisionClient.gateApplicable,
      gateSkip: decisionClient.gateSkip,
    },
    onnxDetector: {
      detectViaMl: async () => {
        spy.nerCalled = true;
        return [];
      },
    },
  };
  const long = "今日は朝から会議が続いていて少し疲れました。".repeat(20); // 820 chars
  assert.ok(long.length > decisionClient.MAX_CHARS, "test text must exceed the gate budget");
  await engine.runPipelineAsync(long, { mlEnabled: true, decisionEnabled: true }, deps);
  assert.equal(spy.gateConsulted, false, "the gate must not run on text over the budget");
  assert.equal(spy.nerCalled, true);
});

test("gate failure (empty results) falls through to NER — never loses detections", async () => {
  const spy = { nerCalled: false };
  const deps = makeDeps([], spy); // callDecide surfaces [] on any error
  await engine.runPipelineAsync(
    "田中太郎は東京の株式会社アスタリスクに勤めています。",
    { mlEnabled: true, decisionEnabled: true },
    deps
  );
  assert.equal(spy.nerCalled, true, "a dead decision layer must not suppress NER");
});

test("decisionEnabled off -> gate is never consulted", async () => {
  const spy = { nerCalled: false, gateConsulted: false };
  const deps = {
    ...realDeps,
    decisionClient: {
      callDecide: async () => {
        spy.gateConsulted = true;
        return [];
      },
      gateQuestion: decisionClient.gateQuestion,
      gateApplicable: decisionClient.gateApplicable,
      gateSkip: decisionClient.gateSkip,
    },
    onnxDetector: {
      detectViaMl: async () => {
        spy.nerCalled = true;
        return [];
      },
    },
  };
  await engine.runPipelineAsync(
    "田中太郎は東京の株式会社アスタリスクに勤めています。",
    { mlEnabled: true, decisionEnabled: false },
    deps
  );
  assert.equal(spy.gateConsulted, false, "gate must not run when decisionEnabled is false");
  assert.equal(spy.nerCalled, true);
});

test("the real client caches one answer per text (engine + LLM path share it)", async () => {
  const sent = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        cb({ ok: true, results: noul(0.02) });
      },
    },
  };
  try {
    const q = decisionClient.gateQuestion();
    const text = "今日はいい天気ですね。";
    const first = await decisionClient.callDecide(text, q);
    const second = await decisionClient.callDecide(text, q);
    assert.equal(sent.length, 1, "the second caller must read the cache, not run a forward pass");
    assert.deepEqual(second, first);
    await decisionClient.callDecide("別の文です。", q);
    assert.equal(sent.length, 2, "a different text must run its own pass");
  } finally {
    delete globalThis.chrome;
  }
});

test("gate budget keeps one pass under the plan's Q4 target (< 1 s CPU WASM)", () => {
  // cost model: 600 ms fixed + 3 ms/token, measured. Japanese text is
  // ~1.9 chars per token at the lengths we gate, so MAX_CHARS must stay
  // under the 1 s target.
  const tokens = Math.ceil(decisionClient.MAX_CHARS / 1.9);
  assert.ok(600 + 3 * tokens < 1000, `budget ${decisionClient.MAX_CHARS} chars -> ${600 + 3 * tokens} ms`);
});
