// engine/onnx-detector.js — content-script-side wrapper that asks the
// service worker to run the bundled NER pipeline on a piece of text and
// converts the result into the existing detection shape.
//
// The actual ONNX inference happens in the offscreen document behind
// background.js (ML_DETECT handler). This file only knows how to:
//   1. Send a text via chrome.runtime.sendMessage, waiting at most
//      DETECT_TIMEOUT_MS for the answer (docs/release-1.7.1.md, D-SC-09).
//   2. Map aggregated NER entity_groups (PER/LOC/ORG/MISC) onto the
//      project's entity_types so downstream classification / severity
//      / category maps already cover them.
//   3. Surface an empty result plus a status ("timeout" / "error" /
//      "unavailable") on any failure so the engine can fall back to
//      regex-only without a hard fault, and callers can tell the user.
//
// The ML detector is OFF by default. The settings flag mlEnabled
// (mirrored into NS.settings by content.js) gates whether the engine
// invokes this path at all. Until that flag flips true, the service
// worker never loads transformers.js, so unused users pay zero cost.
"use strict";

(function attach(root) {
  // NER label → existing entity_type used elsewhere in the engine.
  // PROPER_NOUN_* are the labels Sudachi already produces, so reusing
  // them means severity / category / classification maps need no edit.
  const NER_LABEL_MAP = {
    PER: "PROPER_NOUN_PERSON",
    PERSON: "PROPER_NOUN_PERSON",
    LOC: "PROPER_NOUN_LOCATION",
    LOCATION: "PROPER_NOUN_LOCATION",
    ORG: "PROPER_NOUN_ORG",
    ORGANIZATION: "PROPER_NOUN_ORG",
    // MISC is intentionally unmapped — too noisy for PII purposes
    // (matches dates, products, events, etc.) and would dilute the
    // sidebar with false positives. Drop on read.
  };

  // chrome.runtime is only present in extension contexts; the detector
  // module also lives in the engine bundle which is imported by the
  // standalone Node tests, so we guard every cross-context call.
  function hasChromeRuntime() {
    return (
      typeof chrome !== "undefined" &&
      chrome &&
      chrome.runtime &&
      typeof chrome.runtime.sendMessage === "function"
    );
  }

  // 返事を待つ上限 (docs/release-1.7.1.md の D-SC-09)。判定そのものは 20,000 字でも 1.5 秒以内 (計測) なので、
  // 遅い端末でも収まる。モデルの読み込み中 (キャッシュからでも、温まるまでは 13〜22 秒) や取得が止まったときはここで諦め、
  // 正規表現と辞書の検出だけで続ける。上限が無いと、保護入力欄の送信がいつまでも待っていた (P-SC-07)
  const DETECT_TIMEOUT_MS = 8000;

  /**
   * Send a text to the SW for NER inference.
   *
   * @param {string} text — input to analyse
   * @param {{ timeoutMs?: number }} [opts] — how long to wait for the SW (default DETECT_TIMEOUT_MS)
   * @returns {Promise<{ entities: Array<{entity_group:string, score:number, word:string, start:number, end:number}>,
   *   status: "ok"|"timeout"|"error"|"unavailable" }>}
   *   Aggregated entities (empty unless status is "ok"). Never rejects.
   */
  function callMlDetect(text, opts) {
    if (!hasChromeRuntime()) return Promise.resolve({ entities: [], status: "unavailable" });
    if (typeof text !== "string" || !text) return Promise.resolve({ entities: [], status: "ok" });
    const timeoutMs = opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DETECT_TIMEOUT_MS;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (entities, status) => {
        if (settled) return; // 上限のあとに届いた返事は捨てる
        settled = true;
        clearTimeout(timer);
        resolve({ entities, status });
      };
      const timer = setTimeout(() => finish([], "timeout"), timeoutMs);
      try {
        chrome.runtime.sendMessage({ type: "ML_DETECT", text }, (resp) => {
          if (chrome.runtime.lastError) {
            // SW asleep / disconnected — engine retries next request.
            finish([], "error");
            return;
          }
          if (!resp || resp.ok !== true || !Array.isArray(resp.entities)) {
            finish([], "error");
            return;
          }
          finish(resp.entities, "ok");
        });
      } catch (_) {
        finish([], "error");
      }
    });
  }

  /**
   * Run NER and return Detection objects ready to merge with regex /
   * dictionary detections in engine.js.
   *
   * @param {string} text
   * @param {{ timeoutMs?: number }} [opts] — passed to callMlDetect
   * @returns {Promise<{ detections: Array<Detection>, status: string }>} where Detection = {
   *   entity_type, start, end, text, score, action
   * } and status is callMlDetect's.
   */
  async function detectViaMl(text, opts) {
    const { entities, status } = await callMlDetect(text, opts);
    const out = [];
    for (const e of entities) {
      const grp = String(e.entity_group || "").toUpperCase();
      const entity_type = NER_LABEL_MAP[grp];
      if (!entity_type) continue;
      const start = Number(e.start);
      const end = Number(e.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      out.push({
        entity_type,
        start,
        end,
        text: text.slice(start, end),
        score: typeof e.score === "number" ? e.score : 1.0,
        action: "masked",
      });
    }
    return { detections: out, status };
  }

  const api = { detectViaMl, callMlDetect, NER_LABEL_MAP, DETECT_TIMEOUT_MS };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { onnxDetector: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
