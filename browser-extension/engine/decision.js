// engine/decision.js — System One decision layer (Jev-Style-0.8B readout).
//
// Lives in the offscreen document (same context as offscreen.js, which
// imports the vendored transformers.js build). One forward pass, no
// generation: the answer is read from next-token logits at the verdict
// slot, exactly as readout_config.json specifies.
//
// Why AutoModelForCausalLM + a local model dir instead of `pipeline`:
// the vendored build's architecture map has `qwen3` but not
// `qwen3_5_text`. The model wrapper is a generic ONNX session runner
// (input_ids/attention_mask -> logits), so a local config.json with
// model_type rewritten to "qwen3" loads the exported graph fine.
//
// Model dir: browser-extension/model/jev-0.8b/. scripts/fetch-model.sh
// writes it (config.json with model_type=qwen3, tokenizer files, and the
// int8 ONNX pair). model.onnx_data is gitignored (1.0 GB).
//
// Render template (readout_config.json "macjev-render-v1", mirrored from
// the model's own jev_style_decision.py Renderer.render):
//
//   State:\n<state>\n\n
//   Question [<noul|choice|score>]: <question>\nOptions:\n
//   - false: no, the statement does not hold\n
//   - true: yes, the statement holds\n
//   Judge each option:\n
//   false: … ->\n
//   true: yes, the statement holds ->\n
//
// Every segment is tokenised on its own and the pieces are concatenated,
// with add_special_tokens=false (the model was trained without BOS/EOS).
// The ' ->' token ending option k's readout line is option k's verdict
// slot; its score is logit(' yes') - logit(' no') there.
//
// Readout spec (readout_config.json, format macjev-readout-v1):
//   score_k = logit[' yes'] - logit[' no'] at the k-th ' ->' slot
//   p_k     = softmax(scores / T), T = temperatures.groups[family|qtype|bucket]
//             else temperatures.global, clamped to temperatures.clamp
//
// F-ML-002/F-ML-003/F-ML-004/F-ML-005.
"use strict";

import {
  AutoModelForCausalLM,
  AutoTokenizer,
  Tensor,
} from "../vendor/transformers/transformers.min.js";

// No trailing slash: the loader only treats an id as local when it
// matches ^(\b[\w\-.]+\b/)?\b[\w\-.]{1,96}\b$, which a trailing slash
// breaks.
const DECISION_MODEL_DIR = "model/jev-0.8b";
const READOUT_CONFIG_URL = chrome.runtime.getURL("engine/decision-config.json");
const HARD_HEAD_MAX = 2048;
// Whole input (state + head). Nothing is ever truncated; over-budget
// inputs throw and the engine falls back to regex + NER only.
const CONTEXT_LIMIT = 25600;

const DEFAULT_CRITERIA = {
  false: "no, the statement does not hold",
  true: "yes, the statement holds",
};

let readoutConfigPromise = null;
let modelPromise = null;
let tokenizerPromise = null;

function getReadoutConfig() {
  if (!readoutConfigPromise) {
    readoutConfigPromise = fetch(READOUT_CONFIG_URL)
      .then((r) => r.json())
      .catch((err) => {
        readoutConfigPromise = null;
        throw err;
      });
  }
  return readoutConfigPromise;
}

function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = AutoTokenizer.from_pretrained(DECISION_MODEL_DIR)
      .then(async (tokenizer) => {
        // The reference Renderer refuses to start unless the three slot
        // strings are single tokens. Without this, a tokenizer that
        // differs from the one the config was fitted against silently
        // moves every verdict slot one token off.
        const cfg = await getReadoutConfig();
        for (const key of ["yes", "no", "verdict_slot"]) {
          const { text, id } = cfg.slot_tokens[key];
          const got = tokenizer.encode(text, { add_special_tokens: false });
          if (got.length !== 1 || got[0] !== id) {
            throw new Error(
              `tokenizer mismatch: ${JSON.stringify(text)} -> [${got}], config expects [${id}]`
            );
          }
        }
        return tokenizer;
      })
      .catch((err) => {
        tokenizerPromise = null;
        throw err;
      });
  }
  return tokenizerPromise;
}

function getModel() {
  if (!modelPromise) {
    // The loader appends the dtype suffix to the file name ("fp32" -> no
    // suffix), so the on-disk names stay model.onnx / model.onnx_data.
    // The graph is int8-quantised, but the label only picks the file name.
    // use_external_data_format makes the loader fetch `model.onnx_data`
    // alongside the graph instead of expecting the weights inline.
    modelPromise = AutoModelForCausalLM.from_pretrained(DECISION_MODEL_DIR, {
      // The loader defaults subfolder to "onnx"; our graph sits directly
      // in the model dir next to config.json.
      subfolder: "",
      dtype: "fp32",
      use_external_data_format: true,
    }).catch((err) => {
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

/** Tokenise one segment with no special tokens, as the template requires. */
function encode(tokenizer, text) {
  return tokenizer.encode(text, { add_special_tokens: false });
}

/**
 * One option line body, matching the reference render_options():
 *   choice — the name alone when it has no criterion, else "name: crit";
 *   score  — "level <i>: <description>";
 *   noul   — "false: <crit|default>" / "true: <crit|default>".
 */
function renderOption(q, code) {
  if (q.qtype === "score") {
    const crit = (q.criteria && q.criteria[code]) || "";
    return `level ${code}: ${crit}`;
  }
  const crit = q.criteria && q.criteria[code];
  if (q.qtype === "choice" && (crit === undefined || crit === null || crit === "")) {
    return String(code);
  }
  return `${code}: ${crit || DEFAULT_CRITERIA[code] || ""}`;
}

/**
 * Build the token-id array and the verdict-slot positions for one state
 * and its questions.
 *
 * @param {object} tokenizer
 * @param {string} state
 * @param {Array<{id:string, qtype:'noul'|'choice'|'score', question:string, options:Array<{code:string}>}>} questions
 * @returns {{ids:number[], slots:number[], headTokens:number}}
 */
function renderPrompt(tokenizer, state, questions) {
  const ids = encode(tokenizer, "State:\n")
    .concat(encode(tokenizer, String(state)))
    .concat(encode(tokenizer, "\n\n"));

  // The official renderer encodes every piece on its own and appends;
  // encoding a concatenation instead would let the tokenizer merge
  // across a piece boundary and shift the verdict slots off the
  // ` ->` tokens.
  const dash = encode(tokenizer, "- ");
  const newline = encode(tokenizer, "\n");
  const judge = encode(tokenizer, "Judge each option:\n");

  let head = 0;
  const slots = [];
  for (const q of questions) {
    const suffix = encode(tokenizer, `Question [${q.qtype}]: ${q.question}\nOptions:\n`);
    head += suffix.length;
    ids.push(...suffix);
    for (const o of q.options) {
      const opt = encode(tokenizer, renderOption(q, o.code));
      head += dash.length + opt.length + newline.length;
      ids.push(...dash, ...opt, ...newline);
    }
    head += judge.length;
    ids.push(...judge);

    for (const o of q.options) {
      const opt = encode(tokenizer, renderOption(q, o.code));
      const arrow = encode(tokenizer, " ->");
      head += opt.length + arrow.length + newline.length;
      ids.push(...opt, ...arrow);
      slots.push(ids.length - 1);
      ids.push(...newline);
    }
  }
  if (head > HARD_HEAD_MAX) {
    throw new Error(
      `question + options + readout need ${head} tokens; the head budget is ${HARD_HEAD_MAX}`
    );
  }
  return { ids, slots, headTokens: head };
}

function temperatureFor(cfg, family, qtype, optionCount) {
  const bucket =
    optionCount <= 2 ? "2" :
    optionCount <= 5 ? "3-5" :
    optionCount <= 10 ? "6-10" :
    optionCount <= 20 ? "11-20" : "21+";
  const key = `${family}|${qtype}|${bucket}`;
  const groups = cfg.temperatures.groups;
  let T = groups[key] ? groups[key].T : cfg.temperatures.global;
  const [lo, hi] = cfg.temperatures.clamp;
  return Math.min(Math.max(T, lo), hi);
}

/**
 * Run one forward pass and read calibrated probabilities per question.
 *
 * @param {string} state
 * @param {Array} questions — see renderPrompt
 * @param {string} family — readout_config.json families key (default
 *   "other" -> global temperature)
 * @returns {Promise<Array<{id:string, probs:Object<string,number>, top:string}>>}
 */
/** Render one state + questions and run a single forward pass. */
async function forward(cfg, tokenizer, model, state, questions) {
  const { ids, slots } = renderPrompt(tokenizer, state, questions);
  if (slots.length !== questions.reduce((n, q) => n + q.options.length, 0)) {
    throw new Error("verdict slot count != option count");
  }
  if (ids.length > CONTEXT_LIMIT) {
    throw new Error(
      `input needs ${ids.length} tokens (state + head); the limit is ${CONTEXT_LIMIT}`
    );
  }

  const seq = ids.length;
  const inputIds = new Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, seq]);
  const attentionMask = new Tensor("int64", BigInt64Array.from(ids.map(() => 1n)), [1, seq]);

  const outputs = await model({ input_ids: inputIds, attention_mask: attentionMask });

  // logits is [1, seq, vocab]; position i holds the next-token
  // distribution after token i.
  const logits = outputs.logits;
  return { data: logits?.data ?? logits, slots };
}

/** Turn one forward pass into calibrated per-question results. */
function readResults(cfg, data, slots, questions, family) {
  const vocab = cfg.vocab_size;
  if (!Number.isFinite(vocab)) throw new Error("decision-config.json missing vocab_size");
  const yesId = cfg.slot_tokens.yes.id;
  const noId = cfg.slot_tokens.no.id;

  const results = [];
  let slot = 0;
  for (const q of questions) {
    const T = temperatureFor(cfg, family, q.qtype, q.options.length);

    // v3 scores every option the same way (yes-vs-no at that option's own
    // slot); there is no per-letter logit any more.
    const raw = {};
    let max = -Infinity;
    for (const o of q.options) {
      const base = slots[slot] * vocab;
      raw[o.code] = data[base + yesId] - data[base + noId];
      if (raw[o.code] > max) max = raw[o.code];
      slot++;
    }

    const exps = {};
    let sum = 0;
    for (const code of Object.keys(raw)) {
      exps[code] = Math.exp((raw[code] - max) / T);
      sum += exps[code];
    }
    const probs = {};
    let top = null;
    for (const code of Object.keys(exps)) {
      probs[code] = exps[code] / sum;
      if (top === null || probs[code] > probs[top]) top = code;
    }
    results.push({ id: q.id, probs, top });
  }
  return results;
}

// Single pass, no cascade. The sentence-splitting cascade was measured
// and removed: one pass costs about 600 ms fixed + 3 ms/token in the
// browser (CPU WASM with crossOriginIsolated, 4 threads), so a band hit
// on a 60-sentence message ran 8 passes and took 14.5 s — the worst case
// of any path in the extension (LLM on the same message: 2.9 s).
// Ambiguous scores now go to the generator instead of to extra passes:
// the safe side of an ambiguous gate is the LLM, not a second reading of
// the same 0.8B model.
//
// What the removal gives up (28 pos / 28 neg, whole-text scores): the
// skip threshold below catches 3.6% of positives (1/28 — an IP address
// alone at p=0.025). Every score at or above it still calls the LLM, so
// the cascade's 3.6% -> 0% recall gain is bought with up to 8 passes.
const SKIP_BELOW = 0.03;

async function decide(state, questions, family = "other") {
  const cfg = await getReadoutConfig();
  const tokenizer = await getTokenizer();
  const model = await getModel();

  const whole = await forward(cfg, tokenizer, model, state, questions);
  return readResults(cfg, whole.data, whole.slots, questions, family);
}

/** Load config + tokenizer + graph without running a pass (options page). */
async function prewarm() {
  await getReadoutConfig();
  await getTokenizer();
  await getModel();
}

const api = { decide, prewarm, renderPrompt, temperatureFor };
export default api;
