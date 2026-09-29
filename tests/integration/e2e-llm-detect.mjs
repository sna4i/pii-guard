// tests/integration/e2e-llm-detect.mjs — ローカル LLM の検出補助を、実際の送信経路で確かめる。
//
// e2e-send-path.mjs と同じく、chatgpt.com を名乗るページから送信し、
// 拡張機能の fetch hook → 正規表現 → ローカル LLM → サイドバー → 承認 →
// サーバが受け取った本文、の順に通す。確かめること:
//   - LLM の検出結果が正規表現の結果に統合される
//   - 正規表現では見つからない語も、送信される本文で伏せられる
//
// LLM サーバ (Ollama) はこのスクリプトの外で起動しておく。Ollama には、実行時に
// 表示される拡張機能の origin を OLLAMA_ORIGINS で許可しておくこと。モック HTTPS
// サーバとブラウザはこのスクリプト自身が起動し、finally で必ず閉じる。
//
// 使い方:
//   node tests/integration/e2e-llm-detect.mjs <unpacked 拡張機能ディレクトリ> <LLM の URL> <モデル名>
//   例) node tests/integration/e2e-llm-detect.mjs browser-extension http://127.0.0.1:11434 qwen3:1.7b
//
// 拡張機能は http://*/* を許可している開発版 (browser-extension/) を使う。
// Store 版は LLM の通信先を実行時に許可する作りなので、この自動テストでは扱えない。
//
// 終了コード: 0 = 全検査合格 / 1 = 失敗
import { chromium } from "playwright";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [EXT_ARG, LLM_URL, MODEL] = process.argv.slice(2);
if (!EXT_ARG || !LLM_URL || !MODEL) {
  console.error("usage: node tests/integration/e2e-llm-detect.mjs <unpacked-dir> <llm-url> <model>");
  process.exit(2);
}
const EXT = path.resolve(EXT_ARG);

// 正規表現が拾うのはメールアドレスだけ。人名・部署・社内プロジェクト名は LLM にしか見つけられない。
const TEXT = "品質保証部の西川さんに、社内プロジェクト「ホタル」の不具合一覧を送ってください。連絡先は nishikawa@example.co.jp です。";
const REGEX_FINDS = "nishikawa@example.co.jp";
const LLM_ONLY = ["西川", "品質保証部", "ホタル"];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-e2e-llm-"));
let server, ctx;
const received = [];
const logs = [];
let failed = false;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed = true; };

try {
  const crt = path.join(tmp, "server.crt"), k = path.join(tmp, "server.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", k, "-out", crt,
    "-days", "1", "-nodes", "-subj", "/CN=chatgpt.com",
    "-addext", "subjectAltName=DNS:chatgpt.com"], { stdio: "ignore" });
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
  const port = server.address().port;

  ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
    headless: false, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${port}`,
           "--ignore-certificate-errors", "--no-sandbox"],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 25000 }));
  // 拡張機能は初回起動時 (onInstalled) に既定値を書き込み、LLM を無効にする。
  // それより先に設定を書くと上書きされるので、既定値が入るのを待ってから書く。
  await sw.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const s = await chrome.storage.local.get(["enabled", "localLlmEnabled"]);
      if (typeof s.enabled === "boolean" && typeof s.localLlmEnabled === "boolean") return;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  await sw.evaluate(([url, model]) => chrome.storage.local.set({
    localLlmEnabled: true, localLlmUrl: url, localLlmModel: model,
    localLlmMode: "detect", localLlmKind: "ollama", localLlmTimeoutMs: 240000,
  }), [LLM_URL, MODEL]);
  // Ollama は拡張機能からの要求を OLLAMA_ORIGINS で許可しておく必要がある
  console.log(`拡張機能の origin: ${(sw.url().match(/^chrome-extension:\/\/[^/]+/) || [""])[0]}`);
  const saved = await sw.evaluate(async () => (await chrome.storage.local.get("localLlmEnabled")).localLlmEnabled);
  check(saved === true, "LLM の設定が保存された");

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { const t = m.text(); if (t.includes("[pii-guard]")) logs.push(t); });
  await page.goto("https://chatgpt.com/");
  await page.waitForTimeout(3500);

  await page.evaluate((t) => {
    window.__state = "sending";
    fetch("/backend-api/conversation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "next", model: "gpt-4",
        messages: [{ id: "1", author: { role: "user" }, content: { content_type: "text", parts: [t] } }] }),
    }).then(() => { window.__state = "resolved"; })
      .catch((e) => { window.__state = "rejected:" + e.message; });
  }, TEXT);

  // LLM の結果が統合されるまで待つ (CPU だけで動かすと数十秒かかる)
  const merged = () => logs.find((l) => /llm detect merge:|llm detect: (ok_empty|failed|all LLM entities filtered)/.test(l));
  for (let i = 0; i < 240 && !merged(); i++) await page.waitForTimeout(1000);

  console.log("LLM:");
  console.log(`    ${merged() || "(統合のログなし)"}`);
  check(/llm detect merge: \+[1-9]/.test(merged() || ""), "LLM の検出結果が統合された");

  const host = await page.evaluateHandle(() => [...document.querySelectorAll("*")].find((e) => e.shadowRoot));
  await host.evaluate((h) =>
    [...h.shadowRoot.querySelectorAll("button")].find((b) => /マスクして送信/.test(b.textContent))?.click());
  await page.waitForTimeout(3000);
  check(received.length === 1, "承認後にサーバへ 1 通だけ届く");

  const sent = received.length ? JSON.parse(received[0]).messages[0].content.parts[0] : "";
  console.log(`\n外に出た本文:\n    ${sent}\n\n検査:`);
  check(!sent.includes(REGEX_FINDS), `正規表現が見つけた「${REGEX_FINDS}」が外に出ていない`);
  const hidden = LLM_ONLY.filter((s) => !sent.includes(s));
  check(hidden.length >= 2, `LLM にしか見つけられない語の多くが伏せられた (${hidden.length}/${LLM_ONLY.length}: ${hidden.join(", ")})`);
  check(errs.length === 0, `ページの JS エラーなし${errs.length ? ": " + errs.join(" | ") : ""}`);
} catch (e) {
  console.error("テスト実行エラー:", e?.message || e);
  failed = true;
} finally {
  if (failed) {
    console.log("\n拡張機能のログ (失敗の調査用):");
    for (const l of logs.slice(-25)) console.log(`    ${l.slice(0, 200)}`);
  }
  if (ctx) await ctx.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? "\n✗ FAILED" : "\n✓ PASSED");
process.exit(failed ? 1 : 0);
