// tests/integration/e2e-send-path-form.mjs — 実際の ChatGPT (ログインなし) が 2026-11-22 に
// 使っていた送信形を再現する回帰テスト。
//
// 実測から写した形 (tests/integration/probe で取得):
//   POST https://chatgpt.com/unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=...
//   content-type: application/x-www-form-urlencoded;charset=UTF-8
//   body: conversationState=...&messageMetadata=&oai-session-id=...&imageAttachments=[]&
//         pendingImageUploads=[]&prompt=<入力がそのまま>&clientContextualInfo=...
// 入力の文章は `prompt` フィールドに入る。JSON ではない。
//
// 狙い: 送信经路のフックは本文を JSONparse して伏せる。form-urlencoded の本文も
// 伏せられること。`prompt` の値が伏せた文章でサーバに届くこと。
//
// 使い方: node tests/integration/e2e-send-path-form.mjs <unpacked 拡張機能ディレクトリ>
// 終了コード: 0 = 全検査合格 / 1 = 失敗
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const EXT = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(EXT, "manifest.json"))) {
  console.error("usage: node e2e-send-path-form.mjs <unpacked extension dir>");
  process.exit(2);
}

const TEXT = [
  "田中太郎は東京の株式会社アスタリスクに勤めています。",
  "連絡先は taro@example.com です。",
  "社内番号 EMP-458721",
  "CSS の width: 50% が効かない",
].join("\n");

const MUST_NOT_LEAK = ["田中太郎", "株式会社アスタリスク", "taro@example.com", "EMP-458721"];
const MUST_KEEP = ["width: 50%"];

// 実測の本文のキー順 (値は決めうちではなく、この順で組み立てる)
const FORM_FIELDS = [
  "conversationState", "messageMetadata", "oai-session-id", "imageAttachments",
  "pendingImageUploads", "prompt", "clientContextualInfo", "timezone",
];
const REAL_VALUES = {
  conversationState: '{"messages":[],"parentMessageId":"client-created-root","safety":{"dismissedInterventionIds":[]},"userMessageCount":0}',
  messageMetadata: "",
  "oai-session-id": "7d8c93dc-f41d-4326-8a99-0ff0b0fdc514",
  imageAttachments: "[]",
  pendingImageUploads: "[]",
  clientContextualInfo: '{"app_name":"chatgpt.com","page_height":800,"page_width":1280}',
  timezone: "Asia/Tokyo",
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-e2e-form-"));
let server, ctx;
const received = [];
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

  const body = new URLSearchParams();
  for (const f of FORM_FIELDS) body.set(f, f === "prompt" ? TEXT : REAL_VALUES[f]);

  await page.evaluate((b) => {
    window.__state = "sending";
    fetch("/unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=22e3f7a5", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: b,
    }).then(() => { window.__state = "resolved"; })
      .catch((e) => { window.__state = "rejected:" + e.message; });
  }, body.toString());
  await page.waitForTimeout(3000);

  console.log("form-urlencoded の送信経路:");
  check(await page.evaluate(() => window.__state) === "sending", "承認前は送信がブロックされている");
  check(received.length === 0, "承認前はサーバに何も届いていない");

  const host = await page.evaluateHandle(() => [...document.querySelectorAll("*")].find((e) => e.shadowRoot));
  const found = await host.evaluate((h) => !!(h && h.shadowRoot &&
    [...h.shadowRoot.querySelectorAll("button")].some((b) => /マスクして送信/.test(b.textContent))));
  check(found, "確認 UI が出て、送信を待っている");
  await host.evaluate((h) => h && h.shadowRoot &&
    [...h.shadowRoot.querySelectorAll("button")].find((b) => /マスクして送信/.test(b.textContent))?.click());
  await page.waitForTimeout(3000);
  check(await page.evaluate(() => window.__state) === "resolved", "承認後に送信が完了する");
  check(received.length === 1, "サーバに 1 通だけ届く");

  const sent = received.length ? new URLSearchParams(received[0]).get("prompt") : "";
  console.log("\nサーバが受け取った prompt:");
  console.log("    " + sent.split("\n").join("\n    "));
  console.log("\n検査:");
  for (const s of MUST_NOT_LEAK) check(!sent.includes(s), `「${s}」が外に出ていない`);
  for (const s of MUST_KEEP) check(sent.includes(s), `「${s}」はマスクされずに残る`);
  check(sent.split("\n").length === TEXT.split("\n").length, `行数が保たれる (${TEXT.split("\n").length} → ${sent.split("\n").length})`);
  // 伏せたあとも form の形を保っていること (ほかのフィールドがそのまま読める)
  const parsed = new URLSearchParams(received[0] || "");
  check(parsed.get("timezone") === REAL_VALUES.timezone, "ほかのフィールドはそのまま残る");
  check(errs.length === 0, `ページの JS エラーなし${errs.length ? ": " + errs.join(" | ") : ""}`);
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
