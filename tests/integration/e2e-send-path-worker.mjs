// tests/integration/e2e-send-path-worker.mjs — ChatGPT (ログインなし) の送信は
// dedicated Web Worker から出ている、という実測に基づく回帰テスト。
//
// 実測 (2026-11-22, probe_worker_shape.mjs で記録したそのままの形):
//   構築: new Worker("https://chatgpt.com/unauth-mweb/assets/conversation-source-dil.worker-<hash>.js",
//                     { type: "module" })
//   本文: POST /unauth-mweb/conversation/updates  (application/x-www-form-urlencoded)
//         入力の文章は `prompt` フィールド
// page world の window.fetch は patch 済みで telemetry POST は捕まるのに、実送信は
// worker realm の fetch から出る。だから worker 側の fetch も伏せられること。
//
// 狙う形:
//   1) worker からの POST は承認前にブロックされる (サーバに届かない)
//   2) 確認 UI が出る (page world 側の pipeline が worker の送信にも効く)
//   3) 承認後、worker が page 側に返事できる (wrap しても message 往復が生きてる)
//   4) 届く `prompt` は伏せ字、ほかのフィールドはそのまま
//
// 使い方: node tests/integration/e2e-send-path-worker.mjs <unpacked 拡張機能ディレクトリ>
// 終了コード: 0 = 全検査合格 / 1 = 失敗
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const EXT = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(EXT, "manifest.json"))) {
  console.error("usage: node e2e-send-path-worker.mjs <unpacked extension dir>");
  process.exit(2);
}

const TEXT = [
  "田中太郎は東京の株式会社アスタリスクに勤めています。",
  "連絡先は taro@example.com です。",
  "社内番号 EMP-458721",
].join("\n");

const MUST_NOT_LEAK = ["田中太郎", "株式会社アスタリスク", "taro@example.com", "EMP-458721"];

// 実測の worker path をそのまま使う (hash 部分は固定)
const WORKER_PATH = "/unauth-mweb/assets/conversation-source-dil.worker-GTafL4rA.js";
const CATALOG_PATH = "/unauth-mweb/assets/dil-catalog-names-G3jLyxq0.js";

// worker 側のコード: page からの message を受けて form-urlencoded で POST する。
// 実サイトの worker と同じく ES module (top-level import を持つ形)。
const WORKER_SRC = [
  `import { noop } from "./${path.basename(CATALOG_PATH)}";`,
  "self.onmessage = async (e) => {",
  '  const r = await fetch("/unauth-mweb/conversation/updates?mock=1", {',
  '    method: "POST",',
  '    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },',
  '    body: new URLSearchParams({ prompt: e.data.prompt, timezone: "Asia/Tokyo" }).toString(),',
  "  });",
  "  self.postMessage(await r.text());",
  "};",
].join("\n");

// page 側のコード: worker を作って文章を渡す。返事は window.__state に入る。
// 実サイトでは拡張機能の page script (injected.js) が installed されたあとに worker が
// 作られる (実測: 入力送信のタイミングで作られる)。だからテストでも「フックが installed
// ことの印」である window.__localMaskMCP が出てから worker を作る。
const PAGE_SRC = [
  "<!doctype html><title>mock chatgpt.com (worker send)</title>",
  "<body>",
  '<script type="module">',
  `import { noop } from "${CATALOG_PATH}";`,
  "const wait = (ms) => new Promise((r) => setTimeout(r, ms));",
  "(async () => {",
  // 待つのは「Worker フックが installed されたこと」。window.__localMaskMCP は
  // UI スクリプトが先に作るから、これを見ても worker 構築の順序は保証されない。
  "  for (let i = 0; i < 200 && window.Worker === window.__origWorker; i++) await wait(50);",
  "  window.__hookReady = window.Worker !== window.__origWorker;",
  `  const w = new Worker("${WORKER_PATH}", { type: "module" });`,
  '  window.__state = "waiting";',
  "  w.onmessage = (e) => { window.__state = e.data; };",
  `  w.postMessage({ prompt: ${JSON.stringify(TEXT)} });`,
  "})();",
  "</script>",
  "</body>",
].join("\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-e2e-worker-"));
let server, ctx;
const received = [];
const errs = [];
let failed = false;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed = true; };

try {
  const crt = path.join(tmp, "server.crt"), k = path.join(tmp, "server.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", k, "-out", crt,
    "-days", "1", "-nodes", "-subj", "/CN=chatgpt.com",
    "-addext", "subjectAltName=DNS:chatgpt.com"], { stdio: "ignore" });

  server = https.createServer({ key: fs.readFileSync(k), cert: fs.readFileSync(crt) }, (req, res) => {
    if (req.method === "POST" && req.url.startsWith("/unauth-mweb/conversation/updates")) {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { received.push(b); res.writeHead(200, { "content-type": "application/json" }); res.end("resolved"); });
      return;
    }
    if (req.url === WORKER_PATH) {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(WORKER_SRC);
      return;
    }
    if (req.url === CATALOG_PATH) {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("export const noop = () => {};");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_SRC);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
    headless: false, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${port}`,
           "--ignore-certificate-errors", "--no-sandbox"],
  });
  await (ctx.serviceWorkers()[0] || ctx.waitForEvent("serviceworker", { timeout: 25000 }));
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    // 拡張機能のフックが入る前の Worker を控えておく。これと違うものになっていれば
    // 「worker 構築時にフックが効いていた」と言える。
    window.__origWorker = window.Worker;
    window.addEventListener("error", (e) => {
      window.__err = (window.__err || []).concat([e.message + " @ " + e.filename + ":" + e.lineno]);
    });
  });
  page.on("pageerror", (e) => errs.push(String(e.message || e)));
  page.on("console", (m) => { const t = m.text(); if (/\[pii-guard\]/.test(t)) console.log("  [log] " + t.slice(0, 200)); });
  await page.goto("https://chatgpt.com/");
  await page.waitForTimeout(4000);

  console.log("worker realm の送信経路:");
  check(await page.evaluate(() => window.__hookReady) === true, "worker を作る前に page world のフックが installed されている");
  const st = await page.evaluate(() => window.__state);
  check(st === "waiting", `承認前は worker からの送信がブロックされている (state=${st})`);
  check(received.length === 0, "承認前はサーバに何も届いていない");

  const host = await page.evaluateHandle(() => [...document.querySelectorAll("*")].find((e) => e.shadowRoot));
  const found = await host.evaluate((h) => !!(h && h.shadowRoot &&
    [...h.shadowRoot.querySelectorAll("button")].some((b) => /マスクして送信/.test(b.textContent))));
  check(found, "確認 UI が出て、送信を待っている");
  await host.evaluate((h) => h && h.shadowRoot &&
    [...h.shadowRoot.querySelectorAll("button")].find((b) => /マスクして送信/.test(b.textContent))?.click());
  await page.waitForTimeout(4000);

  check(await page.evaluate(() => window.__state) === "resolved", "承認後に worker からの送信が完了し、page 側に返事が届く");
  check(received.length === 1, "サーバに 1 通だけ届く");

  const sent = received.length ? new URLSearchParams(received[0]).get("prompt") : "";
  console.log("\nサーバが受け取った prompt:");
  console.log("    " + sent.split("\n").join("\n    "));
  console.log("\n検査:");
  for (const s of MUST_NOT_LEAK) check(!sent.includes(s), `「${s}」が外に出ていない`);
  const parsed = new URLSearchParams(received[0] || "");
  check(parsed.get("timezone") === "Asia/Tokyo", "ほかのフィールドはそのまま残る");
  const pageErrs = errs.concat(await page.evaluate(() => window.__err || []));
  check(pageErrs.length === 0, `ページの JS エラーなし${pageErrs.length ? ": " + pageErrs.join(" | ") : ""}`);
} catch (e) {
  console.error("テスト実行エラー:", e?.message || e);
  failed = true;
} finally {
  if (ctx) await ctx.close().catch(() => {});
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? "\n✗ FAILED" : "\n✓ PASSED");
process.exit(failed ? 1 : 0);
