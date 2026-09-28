// tests/store/listing.test.mjs — Chrome Web Store 掲載情報の審査基準チェック。
//
// 却下の履歴をそのまま検査にしている:
//   2026-09-22 キーワードスパム "Yellow Argon" — API キー対応ベンダー名 9 社を
//              「OpenAI / Anthropic / GitHub / …」と並べていた
//   2026-09-28 キーワードスパム "Yellow Argon" — 対応ホストを
//              「claude.ai / claude.com / chatgpt.com / …」と並べていた
// どちらも「スラッシュ区切りでブランド名・ドメインを列挙する」形。機能を
// 説明するつもりの列挙でも、審査では検索汚染とみなされる。
//
// また、説明欄はプレーンテキストで、Markdown は記号のまま公開ページに出る。
// 2026-09-28 時点の公開ページには ** が 216 個、## が 44 個、表の |---| が
// 表示され、ファイル先頭の作業メモ (「…欄にコピペ可能」) まで公開されていた。
//
// Run: node --test tests/store/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DESC_PATH = path.join(root, "browser-extension/STORE_DESCRIPTION.txt");
const desc = fs.existsSync(DESC_PATH) ? fs.readFileSync(DESC_PATH, "utf8") : "";
const manifest = JSON.parse(fs.readFileSync(path.join(root, "browser-extension/manifest.store.json"), "utf8"));

const count = (s, word) => s.split(word).length - 1;

test("the description exists and fits the 16,000-character limit", () => {
  assert.ok(desc.length > 0, "browser-extension/STORE_DESCRIPTION.txt is missing");
  assert.ok(desc.length <= 16000, `${desc.length} characters`);
});

test("no Markdown syntax — the store renders it literally", () => {
  const found = [];
  if (desc.includes("**")) found.push("** (bold)");
  if (/^#{1,6}\s/m.test(desc)) found.push("# heading");
  if (/^\s*\|.*\|\s*$/m.test(desc)) found.push("| table |");
  if (desc.includes("`")) found.push("` backtick");
  if (/^-{3,}\s*$/m.test(desc)) found.push("--- rule");
  if (/\[[^\]]+\]\([^)]+\)/.test(desc)) found.push("[link](url)");
  assert.deepEqual(found, []);
});

test("no internal notes leak into the public text", () => {
  for (const s of ["コピペ", "Detailed description", "欄に貼", "TODO", "FIXME"]) {
    assert.ok(!desc.includes(s), `found internal note marker: ${s}`);
  }
});

test("no slash-separated lists of three or more items", () => {
  // 「A / B / C」— 今回と前回の却下の形そのもの。「ON/OFF」のような
  // 2 項目の対は許す。
  // URL のパス区切りを列挙と誤判定しないよう、先に URL を取り除く。
  // (マッチが https:// の後ろから始まると、URL 判定をすり抜けていた)
  const withoutUrls = desc.replace(/https?:\/\/\S+/g, "");
  const m = withoutUrls.match(/[^\s/]+\s*\/\s*[^\s/]+\s*\/\s*[^\s/]+/g) || [];
  assert.deepEqual(m, [], "slash-separated list found");
});

test("no domain names except the support URL", () => {
  const withoutUrls = desc.replace(/https?:\/\/\S+/g, "");
  const domains = withoutUrls.match(/\b[a-z0-9-]+\.(?:ai|com|im|google\.com|co|io|net|org)\b/gi) || [];
  assert.deepEqual(domains, [], "domain names in the prose read as keyword stuffing");
});

test("each supported service is named at most once", () => {
  for (const name of ["ChatGPT", "Claude", "Gemini", "Manus"]) {
    assert.ok(count(desc, name) <= 1, `${name} appears ${count(desc, name)} times`);
  }
});

test("no vendor names that are not required for disclosure", () => {
  const vendors = ["OpenAI", "Anthropic", "AWS", "Slack", "Stripe", "Perplexity", "OpenRouter",
    "Notion", "Twilio", "SendGrid", "Groq", "Ollama", "LM Studio", "llama.cpp", "GitHub", "Google"];
  const hits = vendors.filter((v) => desc.includes(v));
  assert.deepEqual(hits, [], "only names needed to describe the product or disclose data flows may appear");
});

test("the model host is disclosed, but not repeated", () => {
  // ML 検出はモデルをここから取得するので、開示として必ず書く。
  const n = count(desc, "Hugging Face");
  assert.ok(n >= 1 && n <= 2, `Hugging Face appears ${n} times`);
});

test("the summary fits and names no brands", () => {
  const s = manifest.description;
  assert.ok(s.length <= 132, `${s.length} characters`);
  assert.ok(!/ChatGPT|Claude|Gemini|OpenAI|Google/.test(s), s);
});
