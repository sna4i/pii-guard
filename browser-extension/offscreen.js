// offscreen.js — ML inference host for transformers.js.
//
// Why this file exists
// --------------------
// The MV3 service worker cannot run transformers.js because the WASM
// backend in onnxruntime-web uses dynamic `import()`, which the HTML
// spec forbids on `ServiceWorkerGlobalScope`. The fix is to host the
// pipeline in an offscreen document, which is a hidden DOM-bearing
// extension context where dynamic imports are allowed.
//
// Message protocol
// ----------------
// All messages from the service worker to this offscreen document are
// tagged with `target: "offscreen"` so the SW's own onMessage listener
// can ignore them and we don't accidentally answer messages from the
// page world. Two types are handled:
//   * ML_DETECT  — run NER over `message.text`, respond with aggregated
//                  entity spans.
//   * ML_PREWARM — build the pipeline (forces model download / load)
//                  without running inference.
//
// Both responses use the same shape as the original SW handler so the
// content-script-side onnx-detector.js doesn't need to change.

import {
  pipeline as transformersPipeline,
  env as transformersEnv,
} from "./vendor/transformers/transformers.min.js";

transformersEnv.backends.onnx.wasm.wasmPaths =
  chrome.runtime.getURL("vendor/transformers/");
transformersEnv.allowRemoteModels = true;
transformersEnv.allowLocalModels = false;

const ML_MODEL_ID = "Xenova/distilbert-base-multilingual-cased-ner-hrl";

/**
 * Reconstruct per-token character offsets from a WordPiece tokenizer
 * output. Returns ``offsets[i] === [start, end]`` such that
 * ``offsets[r.index]`` matches the character span of the token whose
 * BIO label is ``r``. Index 0 is the ``[CLS]`` token (placeholder
 * span [0, 0]), index 1 is the first content piece, and so on; the
 * final entry is ``[SEP]``.
 *
 * The function tolerates whitespace between pieces (skipped silently)
 * and ``##`` WordPiece continuations (the prefix is stripped before
 * length accounting). It is NOT a tokenizer reimplementation — the
 * piece list comes from transformers.js itself.
 */
function buildOffsetsFromPieces(text, pieces) {
  const offsets = [[0, 0]]; // [CLS]
  let pos = 0;
  for (const piece of pieces) {
    const body = piece.startsWith("##") ? piece.slice(2) : piece;
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    const len = body.length;
    offsets.push([pos, pos + len]);
    pos += len;
  }
  offsets.push([pos, pos]); // [SEP]
  return offsets;
}

/**
 * Walk a per-token BIO output and merge consecutive ``B-X`` / ``I-X``
 * (same X) into a single span object that quotes character offsets
 * in the original text.
 *
 * Input shape (from transformers.js token-classification pipeline):
 *   [
 *     { entity: "B-PER", index: 1, score, word: "田" },
 *     { entity: "I-PER", index: 2, score, word: "中" },
 *     ...
 *   ]
 *
 * ``offsets`` is the tokenizer's offset_mapping for the same text;
 * ``offsets[token_index] === [charStart, charEnd]``. The
 * ``token_index`` here matches ``r.index`` directly because the
 * pipeline skips O-labelled tokens but uses absolute token positions.
 *
 * Output shape (matches what transformers.py's aggregation_strategy
 * "simple" would produce, so the rest of onnx-detector.js keeps
 * working unchanged):
 *   [
 *     { entity_group: "PER", start, end, word, score },
 *     ...
 *   ]
 */
function aggregateBioSpans(text, raw, offsets) {
  const groups = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    groups.push({
      entity_group: cur.type,
      start: cur.start,
      end: cur.end,
      word: text.slice(cur.start, cur.end),
      score:
        cur.scores.length > 0
          ? cur.scores.reduce((a, b) => a + b, 0) / cur.scores.length
          : 0,
    });
    cur = null;
  };
  for (const r of raw) {
    const m = String(r.entity || "").match(/^([BIE])-(.+)$/);
    if (!m) { flush(); continue; }
    const prefix = m[1];
    const type = m[2];
    const tokIdx = Number(r.index);
    const off = Array.isArray(offsets[tokIdx]) ? offsets[tokIdx] : null;
    if (!off || off.length < 2) continue;
    const [s, e] = [Number(off[0]), Number(off[1])];
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    // Open a new span on B- or when the BIO type changes mid-word.
    if (prefix === "B" || !cur || cur.type !== type) {
      flush();
      cur = { type, start: s, end: e, scores: [Number(r.score) || 0] };
    } else {
      cur.end = e;
      cur.scores.push(Number(r.score) || 0);
    }
  }
  flush();
  return groups;
}

let mlPipelinePromise = null;

function getMlPipeline() {
  if (!mlPipelinePromise) {
    mlPipelinePromise = transformersPipeline(
      "token-classification",
      ML_MODEL_ID,
      { dtype: "q8" }
    ).catch((err) => {
      // Drop the cached promise so the next call retries (e.g., the
      // user grants HF Hub permission after an initial denial).
      mlPipelinePromise = null;
      throw err;
    });
  }
  return mlPipelinePromise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen" || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "ML_DETECT") {
    (async () => {
      const text = typeof message.text === "string" ? message.text : "";
      if (!text) {
        sendResponse({ ok: true, entities: [] });
        return;
      }
      try {
        const ner = await getMlPipeline();
        // transformers.js v3 does not honour aggregation_strategy and
        // its tokenizer call doesn't return offset_mapping, so we
        // run inference per-token and reconstruct character offsets
        // ourselves by walking the original text alongside the
        // tokenizer's piece list. Pieces beginning with "##" are
        // WordPiece continuations and consume their stripped length
        // (typical for English / Latin-script tokens); plain pieces
        // map 1:N to their characters in the source text.
        const raw = await ner(text);
        const pieces = ner.tokenizer.tokenize(text);
        const offsets = buildOffsetsFromPieces(text, pieces);
        const entities = aggregateBioSpans(text, Array.isArray(raw) ? raw : [], offsets);
        sendResponse({ ok: true, entities, modelId: ML_MODEL_ID });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "ML_PREWARM") {
    (async () => {
      try {
        await getMlPipeline();
        sendResponse({ ok: true, modelId: ML_MODEL_ID });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});
