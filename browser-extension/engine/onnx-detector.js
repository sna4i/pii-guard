// engine/onnx-detector.js — content-script-side wrapper that asks the
// service worker to run the bundled NER pipeline on a piece of text and
// converts the result into the existing detection shape.
//
// The actual ONNX inference happens in background.js (ML_DETECT
// handler). This file only knows how to:
//   1. Send a text via chrome.runtime.sendMessage.
//   2. Map aggregated NER entity_groups (PER/LOC/ORG/MISC) onto the
//      project's entity_types so downstream classification / severity
//      / category maps already cover them.
//   3. Surface a graceful empty-array on any error so the engine can
//      fall back to regex-only without a hard fault.
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

  /**
   * Send a text to the SW for NER inference.
   *
   * @param {string} text — input to analyse
   * @returns {Promise<Array<{entity_group:string, score:number, word:string, start:number, end:number}>>}
   *   Aggregated entities; empty on disabled / error.
   */
  function callMlDetect(text) {
    if (!hasChromeRuntime() || typeof text !== "string" || !text) {
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "ML_DETECT", text }, (resp) => {
          if (chrome.runtime.lastError) {
            // SW asleep / disconnected — engine retries next request.
            resolve([]);
            return;
          }
          if (!resp || resp.ok !== true || !Array.isArray(resp.entities)) {
            resolve([]);
            return;
          }
          resolve(resp.entities);
        });
      } catch (_) {
        resolve([]);
      }
    });
  }

  /**
   * Run NER and return Detection objects ready to merge with regex /
   * dictionary detections in engine.runPipeline().
   *
   * @param {string} text
   * @returns {Promise<Array<Detection>>} where Detection = {
   *   entity_type, start, end, text, score, action
   * }
   */
  async function detectViaMl(text) {
    const raw = await callMlDetect(text);
    const out = [];
    for (const e of raw) {
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
    return out;
  }

  const api = { detectViaMl, callMlDetect, NER_LABEL_MAP };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { onnxDetector: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
