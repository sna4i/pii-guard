// engine/decision-client.js — content-script-side messenger for the
// System One decision layer. Same shape as onnx-detector.js: it only
// knows how to send a state + typed questions to the offscreen document
// (via the service worker relay) and surface an empty array on any
// error so the engine degrades to regex-only without a hard fault.
//
// The actual forward pass + logits readout lives in engine/decision.js
// (offscreen context). This file is MV3-safe (no ES6 import) so it can
// be injected as a content script leaf module.
//
// Gate flag: settings.decisionEnabled (mirrored into NS.settings by
// content.js). Until it flips true the engine never invokes this path.
"use strict";

(function attach(root) {
  function hasChromeRuntime() {
    return (
      typeof chrome !== "undefined" &&
      chrome &&
      chrome.runtime &&
      typeof chrome.runtime.sendMessage === "function"
    );
  }

  // Gate cost model, measured in the dev extension (Chromium, CPU WASM
  // with crossOriginIsolated on — 4 threads; WebGPU has no adapter on
  // this WSL2 box):
  //   gate = ~600 ms fixed (one 0.8B forward pass, state empty included)
  //          + ~3 ms per token
  //          26 chars 747 ms | 88 chars 923 ms | 482 chars 2649 ms | 1442 chars 5379 ms
  //   NER  = 14 / 30 / 279 / 208 ms for the same inputs (distilbert q8,
  //          capped at 512 tokens) — an order of magnitude cheaper at
  //          every length, so the gate can never pay by skipping NER.
  //   LLM  = 215 ms when it has nothing to return, 1.2–1.9 s when it
  //          extracts entities (qwen3:1.7b warm, format json + think false,
  //          i.e. exactly the request content.js builds).
  //
  // So the gate is currently more expensive than the call it skips. It
  // only pays when the LLM path is slower than ~1 s (a thinking model, a
  // bigger model, or a remote LLM) and only on inputs short enough to
  // keep one pass inside the plan's Q4 target (gate < 1 s on CPU WASM).
  // 600 + 3 * 125 tokens ≈ 975 ms, so the budget is the ~250 chars that
  // fit under it. Longer text goes straight to the LLM.
  const MAX_CHARS = 250;
  // Skip only below this. Measured on 28 pos / 28 neg: negatives sit at
  // p <= 0.032 (median 0.014), positives at p10 = 0.056, so the only miss
  // is 1/28 (an IP address alone at 0.025). Anything at or above it runs
  // the generator — ambiguous is always the safe side.
  const SKIP_BELOW = 0.03;

  /** True when the input is short enough that one pass is worth running. */
  function gateApplicable(text) {
    return typeof text === "string" && text.length <= MAX_CHARS;
  }

  /** True when a gate answer is a confident "no PII" and can skip work. */
  function gateSkip(result) {
    return !!(
      result &&
      result.probs &&
      typeof result.probs.true === "number" &&
      result.probs.true < SKIP_BELOW
    );
  }

  // One text + one fixed question gives one answer, and the engine (NER
  // skip) and the LLM path (generate skip) both ask for it on the same
  // send. Without this, the second caller pays a second 600 ms pass.
  // Readout is deterministic, so the cache cannot change an answer; it
  // only bounds memory.
  const CACHE_MAX = 16;
  const cache = new Map();

  /**
   * Send a state + questions to the offscreen decision layer.
   *
   * @param {string} state
   * @param {Array<{id:string, qtype:'noul'|'choice', question:string, options:Array<{code:string, label:string}>}>} questions
   * @param {string} [family] — readout temperature family (default "other")
   * @returns {Promise<Array<{id:string, probs:Object<string,number>, top:string}>>}
   *   Calibrated probabilities; empty on disabled / error.
   */
  function callDecide(state, questions, family) {
    if (
      !hasChromeRuntime() ||
      typeof state !== "string" ||
      !state ||
      !Array.isArray(questions) ||
      questions.length === 0
    ) {
      return Promise.resolve([]);
    }
    const key = state + "\u0000" + JSON.stringify(questions) + "\u0000" + (family || "other");
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "ML_DECIDE", state, questions, family: family || "other" },
          (resp) => {
            if (chrome.runtime.lastError) {
              resolve([]);
              return;
            }
            if (!resp || resp.ok !== true || !Array.isArray(resp.results)) {
              resolve([]);
              return;
            }
            if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
            cache.set(key, resp.results);
            resolve(resp.results);
          }
        );
      } catch (_) {
        resolve([]);
      }
    });
  }

  // F-ML-003 gate question: single noul. The option codes are the ones
  // the macjev-render-v1 template uses for a yes/no question ("false" /
  // "true"); the answer is top === "true".
  //
  // Wording matters more than it looks. "…personally identifiable
  // information?" is the natural English label but the model reads it as
  // a compliance term and answers "false" even for 田中太郎は東京の… .
  // Listing the concrete carriers instead scores it correctly on short
  // inputs (measured: name 0.67, address 0.75, email 0.73, phone 0.43
  // with the global temperature).
  function gateQuestion() {
    return [
      {
        id: "pii_present",
        qtype: "noul",
        question:
          "Does this text contain personal information such as names, addresses or company names?",
        options: [{ code: "false" }, { code: "true" }],
      },
    ];
  }

  const api = { callDecide, gateQuestion, gateApplicable, gateSkip, MAX_CHARS, SKIP_BELOW };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { decisionClient: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
