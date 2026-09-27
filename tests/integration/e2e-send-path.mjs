// tests/integration/e2e-send-path.mjs — 実際の送信経路を通す e2e テスト。
//
// エンジンを直接呼ぶのではなく、ユーザーと同じ経路を通す:
//   chatgpt.com を名乗るページから POST /backend-api/conversation を発行
//   → 拡張機能の fetch hook が横取り → サイドバー表示 → 承認
//   → サーバが「実際に受け取った本文」を検査する
//
// モック HTTPS サーバとブラウザはこのスクリプト自身が起動し、finally で
// 必ず閉じる。プロセスを残さない。
//
// 使い方:
//   node tests/integration/e2e-send-path.mjs <unpacked 拡張機能ディレクトリ>
//   例) unzip -qo pii-guard-v1.5.0.zip -d /tmp/x && node tests/integration/e2e-send-path.mjs /tmp/x
//
// 終了コード: 0 = 全検査合格 / 1 = 失敗
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const EXT = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(EXT, "manifest.json"))) {
  console.error("usage: node e2e-send-path.mjs <unpacked extension dir>");
  process.exit(2);
}

// 送信する本文。これまでに実データで見つかった落とし穴を 1 通に詰める。
const TEXT = [
  "社員番号：EMP-458721",                                   // 後続行を飲み込んだ (v1.4.1)
  "運転免許証番号：第123456789012号",
  "カード番号 4111-1111-1111-1111",                         // 桁が漏れていた (〜v1.3)
  "A社との買収交渉は最終段階で、プレミアムは30%を想定している。", // 機密文の数値
  "来期から主力製品を10%値上げし、見積額は1億2000万円、定価の7掛けで卸す。",
  "CSS の width: 50% が効かない",                           // マスクしてはいけない
].join("\n");

// 外に出てはいけない文字列
const MUST_NOT_LEAK = [
  "EMP-458721", "123456789012", "4111-1111-1111-1111",
  "30%", "10%", "1億2000万円", "1億", "7掛け",
];
// 残っていなければならない文字列
const MUST_KEEP = ["width: 50%"];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-e2e-"));
let server, ctx;
const received = [];
let failed = false;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed = true; };

try {
  // 自己署名証明書 (content script は https:// にしか注入されない)
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
  await (ctx.serviceWorkers()[0] || ctx.waitForEvent("serviceworker", { timeout: 25000 }));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
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
  await page.waitForTimeout(3000);

  console.log("送信経路:");
  check(await page.evaluate(() => window.__state) === "sending", "承認前は送信がブロックされている");
  check(received.length === 0, "承認前はサーバに何も届いていない");

  const host = await page.evaluateHandle(() => [...document.querySelectorAll("*")].find((e) => e.shadowRoot));
  const warned = await host.evaluate((h) => !!h.shadowRoot.querySelector(".confidential-warning"));
  check(warned, "機密文の警告が表示される");
  await host.evaluate((h) =>
    [...h.shadowRoot.querySelectorAll("button")].find((b) => /マスクして送信/.test(b.textContent))?.click());
  await page.waitForTimeout(3000);
  check(await page.evaluate(() => window.__state) === "resolved", "承認後に送信が完了する");
  check(received.length === 1, "サーバに 1 通だけ届く");

  const sent = received.length ? JSON.parse(received[0]).messages[0].content.parts[0] : "";
  console.log("\n外に出た本文:");
  console.log(sent.split("\n").map((l) => "    " + l).join("\n"));
  console.log("\n検査:");
  for (const s of MUST_NOT_LEAK) check(!sent.includes(s), `「${s}」が外に出ていない`);
  for (const s of MUST_KEEP) check(sent.includes(s), `「${s}」はマスクされずに残る`);
  check(sent.split("\n").length === TEXT.split("\n").length,
    `行数が保たれる (${TEXT.split("\n").length} → ${sent.split("\n").length})`);
  check(errs.length === 0, `ページの JS エラーなし${errs.length ? ": " + errs.join(" | ") : ""}`);
} catch (e) {
  console.error("テスト実行エラー:", e?.message || e);
  failed = true;
} finally {
  // 何があっても閉じる
  if (ctx) await ctx.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? "\n✗ FAILED" : "\n✓ PASSED");
process.exit(failed ? 1 : 0);
