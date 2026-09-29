#!/usr/bin/env node
// scripts/eval-llm-prompts.mjs — ローカル LLM の検出プロンプトを、実物の LLM で比べる。
//
//   node scripts/eval-llm-prompts.mjs --url http://127.0.0.1:11434 --models qwen3:4b,qwen3:1.7b
//
// オプション:
//   --variants baseline,optimized   比べるプロンプト (既定は両方)
//   --baseline-ref <git ref>        現行プロンプトを読む版 (既定 4df77f0)
//   --limit <n>                     先頭 n 件だけ解く (動作確認用)
//   --filter <prefix>               id がこの文字列で始まる件だけ解く (例: en-)
//   --cases <file>                  評価セット (既定 tests/llm-eval/cases.json、確認用は holdout.json)
//   --alt <name>=<file>             別のプロンプトのファイルを <name> として比べる (--variants にも書く)
//   --out <file>                    応答と採点の詳細を JSON で書き出す
//   --verbose                       取りこぼしと禁止語の誤検出を 1 件ずつ表示する
//
// 拡張機能 (content.js) と同じく、温度 0・JSON 形式・思考モードなし・
// 出力上限 2048 で /api/chat を呼ぶ。応答の解析も injected.js の
// llmAugment() と同じ手順で行う。評価セットは tests/llm-eval/cases.json。
//
// 採点は文字単位で行う (docs/llm-prompt-optimization.md)。
//   - 再現率: expect の語のうち、伏せられずに残った部分が無い語の割合 (法人格や敬称だけ残るのは可)
//   - 適合率: 伏せた文字のうち、expect か optional の語に含まれる文字の割合
//   - 禁止語: forbid の語 (expect・optional と重ならない出現) が半分以上伏せられた件数
// 伏せる文字は、正規表現の検出値と LLM の検出値の和で決まる (mergeLlmDetect と同じ)。
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_DIR = path.join(ROOT, "browser-extension", "engine");
const require = createRequire(import.meta.url);

function args(argv) {
  const a = { url: "http://127.0.0.1:11434", models: "qwen3:4b", variants: "baseline,optimized", baselineRef: "4df77f0", limit: 0, filter: "", out: "", verbose: false, cases: "tests/llm-eval/cases.json", alts: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--url") a.url = next();
    else if (k === "--models") a.models = next();
    else if (k === "--variants") a.variants = next();
    else if (k === "--baseline-ref") a.baselineRef = next();
    else if (k === "--limit") a.limit = Number(next());
    else if (k === "--filter") a.filter = next();
    else if (k === "--cases") a.cases = next();
    else if (k === "--alt") a.alts.push(next());
    else if (k === "--out") a.out = next();
    else if (k === "--verbose") a.verbose = true;
    else throw new Error(`unknown option: ${k}`);
  }
  return a;
}

// ---- エンジンとプロンプト ----------------------------------------------

function loadEngine() {
  const engine = require(path.join(ENGINE_DIR, "engine.js"));
  for (const f of ["patterns.js", "classification.js", "severity.js", "categories.js", "aggregate.js", "force-mask.js", "blocklist.js"]) {
    require(path.join(ENGINE_DIR, f));
  }
  return engine;
}

function loadBaselinePrompts(ref) {
  const src = execFileSync("git", ["show", `${ref}:browser-extension/engine/llm-prompts.js`], { cwd: ROOT, encoding: "utf8" });
  const tmp = path.join(os.tmpdir(), `llm-prompts-${ref}-${process.pid}.cjs`);
  fs.writeFileSync(tmp, src);
  try { return require(tmp); } finally { fs.rmSync(tmp, { force: true }); }
}

// どちらの版も buildDetectPrompt(text) で組み立てる。比べたいプロンプトは
// --baseline-ref で過去の版を指定する。
const VARIANTS = {
  baseline: (mod) => (text) => mod.buildDetectPrompt(text),
  optimized: (mod) => (text) => mod.buildDetectPrompt(text),
};

// ---- LLM の呼び出しと応答の解析 -----------------------------------------

async function callOllama(url, model, system, user) {
  const body = {
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    stream: false,
    think: false,
    format: "json",
    options: { temperature: 0, num_predict: 2048 },
  };
  const r = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`ollama ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return {
    raw: (j.message && j.message.content) || "",
    ms: ((j.total_duration || 0) - (j.load_duration || 0)) / 1e6,
    promptTokens: j.prompt_eval_count || 0,
    outputTokens: j.eval_count || 0,
  };
}

// injected.js の llmAugment() と同じ手順
function parseDetect(raw) {
  if (!raw || typeof raw !== "string") return null;
  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a > 0 && b > a) cleaned = cleaned.slice(a, b + 1);
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.entities)) return null;
  return parsed.entities.filter((e) => e && typeof e === "object" && typeof e.text === "string"
    && e.text.trim().length > 0 && e.text.length < 500 && typeof e.entity_type === "string");
}

// ---- 採点 ---------------------------------------------------------------

function occurrences(text, value) {
  const out = [];
  if (!value) return out;
  for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + value.length)) out.push([i, i + value.length]);
  return out;
}

function charSet(text, values) {
  const s = new Set();
  for (const v of values) for (const [a, b] of occurrences(text, v)) for (let k = a; k < b; k++) s.add(k);
  return s;
}

// 伏せるべき語のうち、伏せられずに残った部分があるか。2 文字以上残っていれば
// 漏れとみなす。名字だけ伏せて下の名前が残るような一部の漏れを取りこぼさないため。
// 法人格や敬称のように、それだけでは誰かを特定しない部分は残ってもよい。
const HARMLESS_REMAINDER = new Set(["株式会社", "有限会社", "合同会社", "様", "さん", "氏", "Inc.", "Inc", "LLC", "Ltd."]);
function leftover(text, g, M) {
  for (const [a, b] of occurrences(text, g)) {
    let run = "";
    const runs = [];
    for (let k = a; k <= b; k++) {
      if (k < b && !M.has(k)) run += text[k];
      else if (run) { runs.push(run.trim()); run = ""; }
    }
    if (runs.some((r) => r.length >= 2 && !HARMLESS_REMAINDER.has(r))) return true;
  }
  return false;
}

function score(c, values) {
  const M = charSet(c.text, values);
  const ok = new Set([...charSet(c.text, c.expect), ...charSet(c.text, c.optional)]);
  const missed = [];
  for (const g of c.expect) if (leftover(c.text, g, M)) missed.push(g);
  let maskedOk = 0;
  for (const k of M) if (ok.has(k)) maskedOk++;
  const forbidden = [];
  for (const f of c.forbid) {
    for (const [a, b] of occurrences(c.text, f)) {
      let overlapsOk = false;
      let hit = 0;
      for (let k = a; k < b; k++) { if (ok.has(k)) overlapsOk = true; if (M.has(k)) hit++; }
      if (!overlapsOk && hit / (b - a) >= 0.5) { forbidden.push(f); break; }
    }
  }
  return { gold: c.expect.length, covered: c.expect.length - missed.length, missed, masked: M.size, maskedOk, forbidden };
}

function checkCases(cases) {
  for (const c of cases) {
    for (const key of ["expect", "optional", "forbid"]) {
      for (const v of c[key]) if (!c.text.includes(v)) throw new Error(`${c.id}: ${key} "${v}" is not in the text`);
    }
  }
}

// 評価セットの正解がプロンプトの例に含まれていると、そのプロンプトに有利な
// 採点になる (2026-09-29 に実際に起きた)。比べるすべてのプロンプトについて確かめる。
function checkLeakage(cases, modules) {
  const systems = [];
  for (const [name, mod] of Object.entries(modules)) {
    for (const sample of ["日本語の文", "English text"]) {
      systems.push([name, mod.buildDetectPrompt(sample).system]);
    }
  }
  const leaks = [];
  for (const c of cases) {
    for (const v of [...c.expect, ...c.optional]) {
      if (v.length < 2) continue;
      for (const [name, s] of systems) if (s.includes(v)) leaks.push(`${c.id} "${v}" は ${name} のプロンプトにある`);
    }
  }
  if (leaks.length) throw new Error(`評価セットとプロンプトが重なっている:\n  ${[...new Set(leaks)].join("\n  ")}`);
}

// ---- 実行 ---------------------------------------------------------------

const median = (xs) => { const s = [...xs].sort((p, q) => p - q); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
const mean = (xs) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : 0);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function summarize(rows) {
  const gold = rows.reduce((s, r) => s + r.merged.gold, 0);
  const covered = rows.reduce((s, r) => s + r.merged.covered, 0);
  const masked = rows.reduce((s, r) => s + r.merged.masked, 0);
  const maskedOk = rows.reduce((s, r) => s + r.merged.maskedOk, 0);
  const recall = gold ? covered / gold : 1;
  const precision = masked ? maskedOk / masked : 1;
  return {
    recall, precision, f1: recall + precision ? (2 * recall * precision) / (recall + precision) : 0,
    forbidden: rows.reduce((s, r) => s + r.merged.forbidden.length, 0),
    llmForbidden: rows.reduce((s, r) => s + (r.llmOnly ? r.llmOnly.forbidden.length : 0), 0),
    redundant: rows.reduce((s, r) => s + (r.redundant || 0), 0),
    invalid: rows.filter((r) => r.invalid).length,
    ms: median(rows.filter((r) => r.ms != null).map((r) => r.ms)),
    promptTokens: mean(rows.filter((r) => r.promptTokens != null).map((r) => r.promptTokens)),
    outputTokens: mean(rows.filter((r) => r.outputTokens != null).map((r) => r.outputTokens)),
  };
}

async function main() {
  const opt = args(process.argv.slice(2));
  const engine = loadEngine();
  const modules = { baseline: loadBaselinePrompts(opt.baselineRef), optimized: require(path.join(ENGINE_DIR, "llm-prompts.js")) };
  for (const spec of opt.alts) {
    const [name, file] = spec.split("=");
    modules[name] = require(path.resolve(file));
    VARIANTS[name] = (mod) => (text) => mod.buildDetectPrompt(text);
  }
  let cases = JSON.parse(fs.readFileSync(path.resolve(ROOT, opt.cases), "utf8")).cases;
  checkCases(cases);
  checkLeakage(cases, modules);
  if (opt.filter) cases = cases.filter((c) => c.id.startsWith(opt.filter));
  if (opt.limit > 0) cases = cases.slice(0, opt.limit);

  const regex = {};
  for (const c of cases) {
    const res = await engine.maskAggregated(c.text, {});
    regex[c.id] = res.aggregated || [];
  }
  const regexRows = cases.map((c) => ({ merged: score(c, regex[c.id].map((a) => String(a.value))) }));
  const report = { regexOnly: summarize(regexRows), runs: [] };

  for (const model of opt.models.split(",")) {
    await callOllama(opt.url, model, "Reply with {}.", "{}"); // モデルを読み込ませる (計測しない)
    for (const variant of opt.variants.split(",")) {
      const build = VARIANTS[variant](modules[variant]);
      const rows = [];
      for (const c of cases) {
        const { system, user } = build(c.text);
        const res = await callOllama(opt.url, model, system, user);
        const ents = parseDetect(res.raw);
        const regexValues = regex[c.id].map((a) => String(a.value));
        const llmValues = [...new Set((ents || []).map((e) => e.text.trim()).filter((v) => c.text.includes(v)))];
        const row = {
          id: c.id, ms: res.ms, promptTokens: res.promptTokens, outputTokens: res.outputTokens,
          invalid: ents === null, raw: res.raw, llmValues,
          redundant: llmValues.filter((v) => regexValues.includes(v)).length,
          merged: score(c, [...regexValues, ...llmValues]),
          llmOnly: score(c, llmValues),
        };
        rows.push(row);
        process.stderr.write(".");
      }
      process.stderr.write("\n");
      report.runs.push({ model, variant, summary: summarize(rows), rows });
    }
  }

  const s = report.regexOnly;
  console.log(`評価セット: ${cases.length} 件 / 正規表現だけ: 再現率 ${pct(s.recall)} 適合率 ${pct(s.precision)} 禁止語 ${s.forbidden}`);
  console.log("| モデル | プロンプト | 再現率 | 適合率 | F1 | 禁止語 | うち LLM | 重複出力 | JSON 失敗 | 応答 中央値 | 入力トークン | 出力トークン |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of report.runs) {
    const m = r.summary;
    console.log(`| ${r.model} | ${r.variant} | ${pct(m.recall)} | ${pct(m.precision)} | ${pct(m.f1)} | ${m.forbidden} | ${m.llmForbidden} | ${m.redundant} | ${m.invalid} | ${(m.ms / 1000).toFixed(2)}s | ${m.promptTokens.toFixed(0)} | ${m.outputTokens.toFixed(0)} |`);
  }
  if (opt.verbose) {
    for (const r of report.runs) {
      console.log(`\n## ${r.model} / ${r.variant}`);
      for (const row of r.rows) {
        const notes = [];
        if (row.invalid) notes.push("JSON 失敗");
        if (row.merged.missed.length) notes.push(`取りこぼし ${row.merged.missed.join(", ")}`);
        if (row.llmOnly.forbidden.length) notes.push(`禁止語 ${row.llmOnly.forbidden.join(", ")}`);
        if (row.redundant) notes.push(`重複 ${row.redundant}`);
        if (notes.length) console.log(`- ${row.id}: ${notes.join(" / ")}  LLM=${JSON.stringify(row.llmValues)}`);
      }
    }
  }
  if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(report, null, 1));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
