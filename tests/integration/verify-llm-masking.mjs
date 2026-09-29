// tests/integration/verify-llm-masking.mjs — 個人情報を詰め込んだ文章を実際の送信経路に流し、
// 送信された本文を 1 語ずつ照合する。LLM なしと、指定した各モデルで同じ文章を送って比べる。
//
// 文章と期待値は tests/llm-eval/pii-rich.json:
//   format   形式の値 (電話番号、カード番号など)。LLM の有無にかかわらず伏せられるべき
//   context  文脈で判断する語 (人名、部署名、病名など)。LLM に期待する
//   keep     伏せてはいけない語 (製品名、あいさつなど)
//
// 使い方:
//   node tests/integration/verify-llm-masking.mjs <unpacked 拡張機能ディレクトリ> <LLM の URL> <モデル,…>
//   例) node tests/integration/verify-llm-masking.mjs browser-extension http://127.0.0.1:11434 qwen3:4b,qwen3:1.7b
//
// LLM サーバ (Ollama) は外で起動し、拡張機能の origin を OLLAMA_ORIGINS で許可しておく
// (e2e-llm-detect.mjs が origin を表示する)。モックサーバとブラウザはモードごとに
// このスクリプトが起動し、finally で必ず閉じる。
//
// 終了コード: 0 = LLM を使うすべてのモードで、形式の値が一部も漏れず、伏せ字が壊れず、LLM が応答した
//             1 = それ以外
import { chromium } from "playwright";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [EXT_ARG, LLM_URL, MODELS] = process.argv.slice(2);
if (!EXT_ARG || !LLM_URL || !MODELS) {
  console.error("usage: node tests/integration/verify-llm-masking.mjs <unpacked-dir> <llm-url> <model,...>");
  process.exit(2);
}
const EXT = path.resolve(EXT_ARG);
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/llm-eval/pii-rich.json"), "utf8"));

async function runMode(model) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-verify-"));
  let server, ctx;
  const received = [];
  const logs = [];
  const out = { model, sent: "", rows: [], llm: null, ms: null, error: null };
  try {
    const crt = path.join(tmp, "server.crt"), k = path.join(tmp, "server.key");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", k, "-out", crt,
      "-days", "1", "-nodes", "-subj", "/CN=chatgpt.com", "-addext", "subjectAltName=DNS:chatgpt.com"], { stdio: "ignore" });
    server = https.createServer({ key: fs.readFileSync(k), cert: fs.readFileSync(crt) }, (req, res) => {
      if (req.method === "POST" && req.url.startsWith("/backend-api/conversation")) {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => { received.push(b); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>mock</title><h1>mock chatgpt.com</h1>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
      headless: false, ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
             `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${server.address().port}`,
             "--ignore-certificate-errors", "--no-sandbox"],
    });
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 25000 }));
    // 初回起動時の既定値 (LLM 無効) が書かれるのを待ってから設定する
    await sw.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        const s = await chrome.storage.local.get(["enabled", "localLlmEnabled"]);
        if (typeof s.enabled === "boolean" && typeof s.localLlmEnabled === "boolean") return;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    if (model) {
      await sw.evaluate(([url, m]) => chrome.storage.local.set({
        localLlmEnabled: true, localLlmUrl: url, localLlmModel: m,
        localLlmMode: "detect", localLlmKind: "ollama", localLlmTimeoutMs: 300000,
      }), [LLM_URL, model]);
    }

    const page = await ctx.newPage();
    page.on("console", (m) => { const t = m.text(); if (t.includes("[pii-guard]")) logs.push(t); });
    await page.goto("https://chatgpt.com/");
    await page.waitForTimeout(3500);
    const t0 = Date.now();
    await page.evaluate((t) => {
      fetch("/backend-api/conversation", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "next", model: "gpt-4",
          messages: [{ id: "1", author: { role: "user" }, content: { content_type: "text", parts: [t] } }] }),
      }).catch(() => {});
    }, FIX.text);

    const done = () => logs.find((l) => /llm detect merge:|llm detect: (ok_empty|failed|all LLM entities filtered)|llm response not JSON/.test(l));
    if (model) {
      for (let i = 0; i < 360 && !done(); i++) await page.waitForTimeout(1000);
      out.ms = Date.now() - t0;
      out.llm = done() || "応答なし (待ち時間切れ)";
      await page.waitForTimeout(2500); // 統合後のサイドバーの描き直しを待つ
    } else {
      await page.waitForTimeout(4000);
    }
    const host = await page.evaluateHandle(() => [...document.querySelectorAll("*")].find((e) => e.shadowRoot));
    out.rows = await host.evaluate((h) => [...h.shadowRoot.querySelectorAll(".row")].map((r) => ({
      value: (r.querySelector(".row-value") || {}).textContent || "",
      llm: !!r.querySelector(".row-llm-badge"),
      masked: r.getAttribute("aria-checked") === "true",
    })));
    await host.evaluate((h) =>
      [...h.shadowRoot.querySelectorAll("button")].find((b) => /マスクして送信/.test(b.textContent))?.click());
    await page.waitForTimeout(3000);
    out.sent = received.length ? JSON.parse(received[0]).messages[0].content.parts[0] : "";
    if (!received.length) out.error = "サーバに何も届かなかった";
  } catch (e) {
    out.error = String(e?.message || e);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

// 語の漏れ方を調べる。そのまま残っていれば「漏れ」。名前は空白で区切った部分ごと、
// 数字は 5 桁以上の断片ごとに見て、一部だけ残っていれば「一部漏れ」とする。
// 名字だけ伏せて下の名前が残る、マイナンバーの末尾が残る、といった漏れを捉えるため。
function leak(sent, item) {
  if (sent.includes(item)) return { kind: "full", parts: [item] };
  const parts = item.split(/\s+/).filter((tok) => tok.length >= 2 && tok !== item && sent.includes(tok));
  const digits = item.replace(/\D/g, "");
  if (digits.length >= 6) {
    for (const run of sent.match(/\d{5,}/g) || []) if (digits.includes(run)) parts.push(run);
  }
  return parts.length ? { kind: "partial", parts } : null;
}

// 伏せ字の形が崩れた箇所の数。元の文章には < も > も無いので、正しい伏せ字
// <LABEL_1> を取り除いた後に残る < や > は、置換が壊れた跡である
const corrupted = (sent) => (sent.replace(/<[A-Z][A-Z_]*_\d+>/g, "").match(/[<>]/g) || []).length;

function status(run, item) {
  if (!run.sent) return "—";
  const l = leak(run.sent, item);
  if (l && l.kind === "full") return "✗ 漏れ";
  if (l) return `△ 一部漏れ (${l.parts.join(", ")})`;
  const row = run.rows.find((r) => r.masked && r.value && (r.value.includes(item) || item.includes(r.value)));
  if (!row) return "✓";
  return row.llm ? "✓ AI" : "✓ 正規表現";
}

const modes = [null, ...MODELS.split(",")];
const runs = [];
for (const m of modes) {
  process.stderr.write(`実行中: ${m || "LLM なし"} …\n`);
  runs.push(await runMode(m));
}

const name = (r) => r.model || "LLM なし";
console.log(`文章: ${FIX.text.length} 文字 / 形式の値 ${FIX.format.length} / 文脈の語 ${FIX.context.length} / 伏せてはいけない語 ${FIX.keep.length}\n`);
console.log("| モード | LLM の応答 | 所要時間 | 形式の値を完全に伏せた | 文脈の語を完全に伏せた | 伏せてはいけない語を残した | 壊れた伏せ字 |");
console.log("|---|---|---|---|---|---|---|");
let failed = false;
for (const r of runs) {
  const clean = (v) => r.sent && !leak(r.sent, v);
  const fmt = FIX.format.filter(clean).length;
  const ctxN = FIX.context.filter(clean).length;
  const keep = FIX.keep.filter((v) => r.sent.includes(v)).length;
  const broken = r.sent ? corrupted(r.sent) : 0;
  const llm = r.model ? (r.llm || "").replace(/^\[pii-guard\] /, "") : "—";
  console.log(`| ${name(r)} | ${llm} | ${r.ms ? (r.ms / 1000).toFixed(1) + " 秒" : "—"} | ${fmt}/${FIX.format.length} | ${ctxN}/${FIX.context.length} | ${keep}/${FIX.keep.length} | ${broken} |`);
  if (r.error) console.log(`  ★ ${name(r)}: ${r.error}`);
  if (r.model && (r.error || fmt < FIX.format.length || broken > 0 || !/llm detect merge:/.test(r.llm || ""))) failed = true;
}

console.log(`\n| 種類 | 語 | ${runs.map(name).join(" | ")} |`);
console.log(`|---|---|${runs.map(() => "---").join("|")}|`);
for (const [kind, items] of [["形式", FIX.format], ["文脈", FIX.context]]) {
  for (const v of items) console.log(`| ${kind} | ${v} | ${runs.map((r) => status(r, v)).join(" | ")} |`);
}
for (const v of FIX.keep) {
  console.log(`| 残す | ${v} | ${runs.map((r) => (!r.sent ? "—" : r.sent.includes(v) ? "✓ 残った" : "✗ 伏せた")).join(" | ")} |`);
}

for (const r of runs.filter((x) => x.model)) {
  console.log(`\n--- ${name(r)} で送信された本文 ---\n${r.sent}`);
}
console.log(failed ? "\n✗ FAILED" : "\n✓ PASSED");
process.exit(failed ? 1 : 0);
